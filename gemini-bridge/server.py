"""
Gemini Web to OpenAI API Bridge
Exposes a local OpenAI-compatible endpoint (http://127.0.0.1:8010/v1) backed by Google Gemini Web
using session cookies (__Secure-1PSID, __Secure-1PSIDTS) for Google AI Pro users.

Features:
- Orchestrator routing across the account's real models (Carbon / Pro / Hydrogen / Flash-Lite).
- Cookie acquisition over Chrome DevTools Protocol: sign in once via login.cmd, never copy cookies.
- Real-time Cookie Persistence: Auto-saves Google-rotated 1PSIDTS directly to .env on disk.
- Native Multimodal Input: Images, Videos, Audios, PDFs & Code with Magic Bytes & MIME detection.
- Streaming & Non-Streaming MCP Tool Calling: delta.tool_calls compliant with OpenCode & @ai-sdk.
- Windows file:// path resolution with url2pathname.
- Parallel Subagent execution & concurrency without state collision.
- Transparent auto-recovery & retry on session/network dropouts.
"""

import os
import io
import re
import sys
import time
import uuid
import json
import base64
import urllib.parse
import urllib.request
import tempfile
import asyncio
import ctypes
import ctypes.wintypes
import threading
from pathlib import Path
from typing import List, Optional, Dict, Any, Union
from contextlib import asynccontextmanager

# --------------------------------------------------------------- logging
# start-hidden.vbs runs the bridge without a console, so every print() used to
# vanish: a failing 1PSIDTS rotation, a silent fallback to flash-lite or a
# traceback from a broken stream left no trace at all. Everything the process
# prints is mirrored into logs/bridge.log (rotated at 2 MB), which is the only
# way to diagnose a failure that already happened.
LOG_DIR = Path(__file__).parent / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG_PATH = LOG_DIR / "bridge.log"
LOG_MAX_BYTES = 2 * 1024 * 1024

_real_print = print
_log_lock = threading.Lock()


def _rotate_log():
    try:
        if LOG_PATH.exists() and LOG_PATH.stat().st_size > LOG_MAX_BYTES:
            backup = LOG_DIR / "bridge.log.1"
            if backup.exists():
                backup.unlink()
            LOG_PATH.rename(backup)
    except Exception:
        pass


def log(*args, **kwargs):
    text = " ".join(str(a) for a in args)
    try:
        with _log_lock:
            _rotate_log()
            with open(LOG_PATH, "a", encoding="utf-8") as f:
                f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {text}\n")
    except Exception:
        pass
    if kwargs.get("file") is None:
        try:
            _real_print(*args, **kwargs)
        except Exception:
            pass


# Rebind in this module only. Library prints are not routed here on purpose,
# but uvicorn's own logger is attached to the same file in __main__ below.
print = log

from antigravity_sync import fetch_antigravity_live_quota
from browser_session import (harvest_cookies, browser_debug_alive, reopen_saved_profile,
                             probe_session)
from model_routing import ModelSelectionError, model_catalog, select_model, selectable_models
from generation_runtime import generate_once
from gemini_webapi.utils import rotate_1psidts

from fastapi import FastAPI, Request, HTTPException, status
from fastapi.responses import JSONResponse, StreamingResponse, HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# Import gemini_webapi
try:
    from gemini_webapi import GeminiClient
    from gemini_webapi.exceptions import GeminiError, AuthError, UsageLimitExceededError, APIError
    from gemini_webapi.utils.upload_file import upload_file, parse_file_name
    import gemini_webapi.utils.upload_file as _gw_upload_mod

    # MONKEYPATCH: Prevent gemini_webapi from ever defaulting to "input_XXXXXXX.txt" for media bytes!
    def _safe_gw_generate_random_name(extension: str = ".jpg") -> str:
        ext = extension if extension and extension != ".txt" else ".jpg"
        return f"upload_{uuid.uuid4().hex[:8]}{ext}"

    _gw_upload_mod._generate_random_name = _safe_gw_generate_random_name
except ImportError:
    print("[ERROR] gemini-webapi is not installed. Please install it using 'pip install gemini-webapi fastapi uvicorn'.")
    sys.exit(1)

# Cache directory for decoded media/files
UPLOAD_CACHE_DIR = Path(tempfile.gettempdir()) / "gemini_bridge_uploads"
UPLOAD_CACHE_DIR.mkdir(parents=True, exist_ok=True)
last_cache_cleanup_time = 0.0
MAX_REMOTE_MEDIA_BYTES = 32 * 1024 * 1024

def cleanup_old_upload_cache(max_age_seconds: int = 7200):
    """Purge temporary uploads older than 2 hours."""
    global last_cache_cleanup_time
    now = time.time()
    if now - last_cache_cleanup_time < 1800:
        return
    last_cache_cleanup_time = now
    try:
        for f in UPLOAD_CACHE_DIR.glob("*"):
            if f.is_file() and (now - f.stat().st_mtime) > max_age_seconds:
                try:
                    f.unlink()
                except Exception:
                    pass
    except Exception:
        pass

# Load .env if present
SESSION_ENV_KEYS = {"GEMINI_SECURE_1PSID", "GEMINI_SECURE_1PSIDTS"}

def load_env_file():
    env_path = Path(__file__).parent / ".env"
    if env_path.exists():
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    k = k.strip()
                    v = v.strip().strip("'\"")
                    if k in SESSION_ENV_KEYS:
                        # setdefault kept the first value forever, so a session
                        # refreshed on disk by login.cmd never reached the bridge.
                        os.environ[k] = v
                    else:
                        os.environ.setdefault(k, v)

def update_env_file(psid: Optional[str] = None, psidts: Optional[str] = None):
    """Updates .env on disk with the freshest tokens without touching other variables.

    Written through a temporary file: a crash mid-write used to truncate the only
    copy of the session. The previous values are kept in .env.previous so a bad
    adoption can be undone without signing in again.
    """
    env_path = Path(__file__).parent / ".env"
    if not env_path.exists():
        return
    try:
        original = env_path.read_text(encoding="utf-8")
        lines = original.splitlines()
        new_lines = []
        has_psid = False
        has_psidts = False
        for line in lines:
            if line.startswith("GEMINI_SECURE_1PSID=") and psid:
                new_lines.append(f"GEMINI_SECURE_1PSID={psid}")
                has_psid = True
            elif line.startswith("GEMINI_SECURE_1PSIDTS=") and psidts:
                new_lines.append(f"GEMINI_SECURE_1PSIDTS={psidts}")
                has_psidts = True
            else:
                new_lines.append(line)
        if not has_psid and psid:
            new_lines.append(f"GEMINI_SECURE_1PSID={psid}")
        if not has_psidts and psidts:
            new_lines.append(f"GEMINI_SECURE_1PSIDTS={psidts}")
        updated = "\n".join(new_lines) + "\n"
        if updated == original:
            return
        tmp = env_path.parent / ".env.tmp"
        tmp.write_text(updated, encoding="utf-8")
        try:
            (env_path.parent / ".env.previous").write_text(original, encoding="utf-8")
        except OSError:
            pass
        tmp.replace(env_path)
        if psid:
            os.environ["GEMINI_SECURE_1PSID"] = psid
        if psidts:
            os.environ["GEMINI_SECURE_1PSIDTS"] = psidts
        print(f"[INFO] .env успешно обновлен свежими сессионными токенами Google!")
    except Exception as e:
        print(f"[WARN] Не удалось обновить .env: {e}")

load_env_file()

PORT = int(os.getenv("PORT", "8010"))
HOST = os.getenv("HOST", "127.0.0.1")
MAX_PROMPT_CHARS = int(os.getenv("MAX_PROMPT_CHARS", "700000"))
AGENT_THINKING = os.getenv("AGENT_THINKING", "1") == "1"
# Google flags the direct IP after enough session bootstraps and answers 429 on
# every init, which looks exactly like dead cookies. Going through the same
# proxy the rest of the machine uses avoids the flag entirely.
GEMINI_PROXY = (os.getenv("GEMINI_PROXY") or os.getenv("HTTPS_PROXY")
                or os.getenv("https_proxy") or None)

# The pool can replace GEMINI_PROXY at runtime, so the value from .env is kept
# separately as the fallback used when v2rayN is closed or no exit passes.
PROXY_FALLBACK = GEMINI_PROXY
VPN_ENABLED = os.getenv("VPN_AUTOSWITCH", "1") == "1"
VPN_PROBE_INTERVAL = max(300, int(os.getenv("VPN_PROBE_INTERVAL", "1800")))

try:
    from vpn_pool import VpnPool

    vpn_pool: Optional[VpnPool] = VpnPool(
        base_dir=Path(__file__).parent,
        log=print,
        v2rayn_home=os.getenv("V2RAYN_HOME") or None,
        size=int(os.getenv("VPN_POOL_SIZE", "10")),
        probe_timeout=float(os.getenv("VPN_PROBE_TIMEOUT", "12")),
        prefer_countries=os.getenv("VPN_PREFER_COUNTRIES",
                                   "SE,FI,CH,FR,PL,DE,NL,GB,CA,US"),
    )
    _saved_vpn = vpn_pool.load_state()
    vpn_pool.preferred_index = int(os.getenv("VPN_PROFILE_INDEX")
                                   or _saved_vpn.get("index_id") or 0) or None
except Exception as _vpn_import_error:  # the bridge must boot without the pool
    VpnPool = None  # type: ignore[assignment]
    vpn_pool = None
    _saved_vpn = {}
    print(f"[VPN] Пул узлов недоступен: {_vpn_import_error}")

vpn_state: Dict[str, Any] = {
    "source": "env" if PROXY_FALLBACK else "none",
    "winner": None,
    "last_probe_at": None,
    "last_probe_reason": None,
    "last_error": None if vpn_pool else "vpn_pool не загружен",
    "probe_results": [],
    "switches": 0,
}
vpn_lock = asyncio.Lock()
_vpn_recovery_task: Optional[asyncio.Task] = None


client_instance: Optional[GeminiClient] = None
client_lock = asyncio.Lock()

# Everything that silently went wrong before is recorded here and exposed by
# /health, so "it degraded to flash-lite" has a timestamp instead of a guess.
bridge_state: Dict[str, Any] = {
    "started_at": time.time(),
    "last_rotation_at": None,
    "last_rotation_ok": None,
    "last_rotation_error": None,
    "last_models_refresh_at": None,
    "last_auth_refresh_at": None,
    "last_auth_error": None,
    "last_quota_at": None,
    "last_quota_source": None,
    "session_identity": None,
    "registry_recovery": None,
}

# Requests currently generating on the shared client. A forced re-auth closes
# the client, which kills every stream using it, so it must wait for them.
bridge_state["inflight"] = 0

# Set when the exit node changed: the live client still holds connections to
# the old proxy, so the next request must rebuild it on the new one.
bridge_state["vpn_dirty"] = False

# Last "does this session really generate?" probe, shared by login.cmd polling.
_auth_probe: Dict[str, Any] = {"at": 0.0, "ok": None, "error": None}

async def refresh_cookies_from_browser() -> bool:
    """Pulls the Google session cookies from the bridge-owned Chrome and stores them.

    Returns True when a new, signed-in __Secure-1PSID was obtained.

    A signed-out Chrome profile still holds cookies, and they still generate on
    flash-lite. Adopting them unconditionally replaced a working AI Pro session
    with a guest one, which looked like "Google throttled us" for hours. The
    harvested pair is now identified before it is allowed to overwrite anything.
    """
    if not await asyncio.to_thread(browser_debug_alive):
        return False
    cookies = await asyncio.to_thread(harvest_cookies)
    psid = cookies.get("__Secure-1PSID")
    if not psid:
        return False
    psidts = cookies.get("__Secure-1PSIDTS")
    if psid == os.getenv("GEMINI_SECURE_1PSID") and psidts == os.getenv("GEMINI_SECURE_1PSIDTS"):
        return False

    identity = await asyncio.to_thread(probe_session, psid, psidts or "", GEMINI_PROXY)
    bridge_state["session_identity"] = {**identity, "at": time.time(), "source": "browser"}
    if identity.get("authenticated") is False:
        reason = identity.get("reason")
        if reason == "captcha":
            print("[CDP] Google показал CAPTCHA для этого выхода. Куки не приняты: "
                  "смените узел (POST /admin/vpn?action=switch) или пройдите проверку в браузере моста.")
        else:
            print("[CDP] Браузер моста не залогинен (гостевая сессия). Куки НЕ приняты, "
                  "чтобы не потерять рабочую сессию. Запустите login.cmd и войдите в аккаунт.")
        return False

    print("[CDP] Получена свежая сессия Google из браузера моста."
          + (f" Аккаунт: {identity['account']}" if identity.get("account") else ""))
    await asyncio.to_thread(update_env_file, psid, psidts)
    return True

async def _retire_client(old_client) -> None:
    """Closes a replaced client only after in-flight generations finished."""
    for _ in range(60):
        if bridge_state["inflight"] <= 0:
            break
        await asyncio.sleep(5)
    try:
        await old_client.close()
        print("[INFO] Старый GeminiClient закрыт после завершения активных запросов.")
    except Exception:
        pass


def unlock_verified_models(client) -> int:
    """Clears the library's guest suppression once the account is really known.

    gemini_webapi marks every model but the first unavailable whenever the status
    RPC answers UNAUTHENTICATED, and that RPC is not authoritative. The app page
    carries the signed-in account marker; when it does, the suppression is a false
    negative that hides the whole Pro catalogue behind a working session.
    """
    identity = bridge_state.get("session_identity") or {}
    if identity.get("authenticated") is not True:
        return 0
    unlocked = 0
    for model in (client.list_models() or []):
        if not getattr(model, "is_available", True):
            model.is_available = True
            unlocked += 1
    return unlocked


async def get_gemini_client(force_refresh: bool = False) -> GeminiClient:
    global client_instance
    async with client_lock:
        if not force_refresh and client_instance is not None and client_instance._running:
            pool_gone = bool(
                VPN_ENABLED and vpn_pool is not None
                and vpn_state.get("source") == "pool"
                and (not vpn_pool.is_running()
                     or GEMINI_PROXY != (vpn_state.get("winner") or {}).get("proxy"))
            )
            if not bridge_state.get("vpn_dirty") and not pool_gone:
                return client_instance
            # The exit changed under the live client: its sockets still point at
            # the old local port, so it must be rebuilt on the new one.
            force_refresh = True

        # Dynamically reload .env to allow live cookie updates without restarting server
        load_env_file()

        psid = os.getenv("GEMINI_SECURE_1PSID") or os.getenv("__Secure_1PSID") or os.getenv("SECURE_1PSID")
        psidts = os.getenv("GEMINI_SECURE_1PSIDTS") or os.getenv("__Secure_1PSIDTS") or os.getenv("SECURE_1PSIDTS")

        if not psid:
            await refresh_cookies_from_browser()
            load_env_file()
            psid = os.getenv("GEMINI_SECURE_1PSID")
            psidts = os.getenv("GEMINI_SECURE_1PSIDTS")

        if not psid:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=(
                    "Нет сессии Google. Запустите login.cmd и войдите в аккаунт в открывшемся окне Chrome — "
                    "мост заберёт куки сам. Копировать их вручную не нужно."
                ),
            )

        if client_instance is not None:
            old_client = client_instance
            client_instance = None
            if bridge_state["inflight"] > 0:
                # Other streams are still reading from this client. Closing it
                # now kills them mid-answer, so retire it once they finish.
                asyncio.create_task(_retire_client(old_client))
            else:
                try:
                    await old_client.close()
                except Exception:
                    pass

        # Pick the exit before building the client. On a warm bridge this is a
        # no-op; on startup it starts the private Xray pool and probes nodes.
        proxy = await ensure_proxy(reason="client-init")
        # Two independent reasons to move exit, each with its own budget. One
        # shared flag meant a 429 switch consumed the only attempt, so a guest
        # registry returned right after it was never retried on another node.
        switched_for_429 = False
        switched_for_registry = False
        max_attempts = 4

        # Attempt initialization with retry
        for attempt in range(max_attempts):
            try:
                print(f"[INFO] Авторизация GeminiClient в сессии Google (попытка {attempt+1}/{max_attempts})...")
                new_client = GeminiClient(secure_1psid=psid, secure_1psidts=psidts, proxy=proxy)
                await new_client.init(timeout=300, watchdog_timeout=120, auto_refresh=True, refresh_interval=600)
                if getattr(new_client, "account_status", None) is not None:
                    from gemini_webapi.constants import AccountStatus
                    if new_client.account_status != AccountStatus.AVAILABLE:
                        # The status RPC (GPRiHf) answers UNAUTHENTICATED on cookies
                        # that still generate perfectly well. Treating it as fatal
                        # made the bridge refuse a working session, so it is a
                        # warning only: a genuinely dead session fails on generate.
                        print(f"[WARN] Статус аккаунта: {new_client.account_status.name}. "
                              "Это не приговор — проверяем генерацией.")
                if attempt == 0 and getattr(getattr(new_client, "account_status", None), "name", None) == "UNAUTHENTICATED":
                    # A saved profile may hold fresher rotated cookies than .env.
                    # Reopen only our profile; never automate a login or purchase.
                    await asyncio.to_thread(reopen_saved_profile)
                    if await refresh_cookies_from_browser():
                        await new_client.close()
                        psid = os.getenv("GEMINI_SECURE_1PSID") or psid
                        psidts = os.getenv("GEMINI_SECURE_1PSIDTS") or psidts
                        continue
                models = [m.model_name for m in (new_client.list_models() or [])]
                usable = [m.model_name for m in selectable_models(new_client.list_models() or [])]
                if len(usable) < 3:
                    identity = await asyncio.to_thread(probe_session, psid, psidts or "", proxy)
                    bridge_state["session_identity"] = {**identity, "at": time.time(), "source": "init"}
                    restored = unlock_verified_models(new_client)
                    if restored:
                        print(f"[SESSION] Сессия подтверждена аккаунтом {identity.get('account')}: "
                              f"снята ложная блокировка {restored} моделей (status-RPC соврал).")
                        usable = [m.model_name for m in selectable_models(new_client.list_models() or [])]
                    if len(usable) < 3:
                        if identity.get("authenticated") is False and identity.get("reason") != "captcha":
                            # A signed-out session is guest level on every exit, so
                            # switching nodes cannot help and only spends probes.
                            print("[SESSION] Сессия Google гостевая (аккаунт не залогинен). "
                                  "Pro-модели недоступны ни на одном узле — запустите login.cmd.")
                        elif not switched_for_registry:
                            # A partial registry can also mean this exit was throttled.
                            # Another exit usually restores the Pro models.
                            current_exit = (vpn_state.get("winner") or {}).get("exit_ip")
                            new_proxy = await ensure_proxy(
                                switch=True, avoid_exit_ip=current_exit, reason="degraded-models")
                            if new_proxy and new_proxy != proxy:
                                await new_client.close()
                                proxy = new_proxy
                                switched_for_registry = True
                                print("[VPN] Реестр моделей урезан — пробую другой выход.")
                                continue
                bridge_state["last_auth_refresh_at"] = time.time()
                bridge_state["last_auth_error"] = None
                print(f"[SUCCESS] GeminiClient успешно авторизован в gemini.google.com! "
                      f"Модели аккаунта: {usable or models or ['<пусто>']}")
                if len(usable) < 3:
                    reason = (bridge_state.get("session_identity") or {}).get("reason")
                    advice = {
                        "guest_session": "аккаунт не залогинен — запустите login.cmd и войдите в окне Chrome моста.",
                        "captcha": "Google требует CAPTCHA для этого выхода — смените узел или пройдите проверку в браузере моста.",
                    }.get(reason, "проверьте 1PSIDTS и IP — Google отвечает так на 429 и на протухшую куку.")
                    print(f"[WARN] Список моделей урезан (гостевой уровень): {advice}")
                bridge_state["vpn_dirty"] = False
                client_instance = new_client
                return client_instance
            except Exception as e:
                bridge_state["last_auth_error"] = str(e)
                if is_rate_limited(e) and not switched_for_429:
                    # A 429 is tied to the exit IP, not the account. Move to a
                    # different exit and retry before telling the caller to wait.
                    switched_for_429 = True
                    current_exit = (vpn_state.get("winner") or {}).get("exit_ip")
                    new_proxy = await ensure_proxy(
                        switch=True, avoid_exit_ip=current_exit, reason="init-429")
                    if new_proxy and new_proxy != proxy:
                        proxy = new_proxy
                        print("[VPN] 429 на авторизации — переключаю выход и пробую снова.")
                        continue
                if is_rate_limited(e):
                    # Retrying a 429 immediately is what keeps the session limited.
                    raise HTTPException(
                        status_code=429,
                        detail="Google ограничил сессию (429). Подождите несколько минут и не перезапускайте "
                               "мост подряд: каждый старт заново запрашивает токен доступа.",
                    )
                print(f"[WARN] Сбой авторизации (попытка {attempt+1}/{max_attempts}): {e}")
                if attempt < max_attempts - 1:
                    if await refresh_cookies_from_browser():
                        psid = os.getenv("GEMINI_SECURE_1PSID") or psid
                        psidts = os.getenv("GEMINI_SECURE_1PSIDTS") or psidts
                    await asyncio.sleep(2)
                else:
                    raise HTTPException(
                        status_code=status.HTTP_502_BAD_GATEWAY,
                        detail=f"Не удалось подключиться к Google Gemini Web: {e}",
                    )

def is_rate_limited(err: Exception) -> bool:
    m = str(err).lower()
    return "429" in m or "too many requests" in m

def is_auth_or_session_error(err: Exception) -> bool:
    """Session/auth failures only.

    This used to match "timeout", "closed", "bad gateway" and "not available"
    too, so an ordinary network hiccup triggered a full Google re-auth — a new
    bootstrap token on every slow reply, which is exactly what gets an IP
    throttled. Network trouble is now a separate, cheaper retry.
    """
    msg = str(err).lower()
    patterns = [
        "auth", "session expired", "cookie", "1psid", "unauthorized",
        "401", "302", "redirect", "login", "forbidden", "403",
        "invalid session", "not signed in",
    ]
    return any(p in msg for p in patterns)


def is_transient_network_error(err: Exception) -> bool:
    """Timeouts and dropped sockets: retry the same client, do not re-auth."""
    msg = str(err).lower()
    patterns = [
        "timeout", "timed out", "connection reset", "broken pipe", "closed",
        "eof occurred", "remotedisconnected", "bad gateway", "502", "503", "504",
        "temporarily unavailable", "try again",
    ]
    return any(p in msg for p in patterns)


# ------------------------------------------------------------- proxy pool
def _probe_cookies() -> Dict[str, str]:
    """Cookies for the lightweight Gemini page check (no token rotation)."""
    load_env_file()
    psid = (os.getenv("GEMINI_SECURE_1PSID") or os.getenv("__Secure_1PSID")
            or os.getenv("SECURE_1PSID") or "")
    psidts = (os.getenv("GEMINI_SECURE_1PSIDTS") or os.getenv("__Secure_1PSIDTS")
              or os.getenv("SECURE_1PSIDTS") or "")
    if not psid:
        return {}
    return {"__Secure-1PSID": psid, "__Secure-1PSIDTS": psidts}


def vpn_public_state() -> Dict[str, Any]:
    """Sanitized pool status: no node UUIDs, passwords or config paths."""
    return {
        "enabled": bool(VPN_ENABLED and vpn_pool),
        "source": vpn_state["source"],
        "current_proxy": GEMINI_PROXY,
        "fallback_proxy": PROXY_FALLBACK,
        "winner": vpn_state.get("winner"),
        "last_probe_at": vpn_state.get("last_probe_at"),
        "last_probe_reason": vpn_state.get("last_probe_reason"),
        "last_error": vpn_state.get("last_error"),
        "switches": vpn_state.get("switches", 0),
        "probe_results": vpn_state.get("probe_results", []),
        "pool": vpn_pool.public_state() if vpn_pool else {"available": False},
    }


async def ensure_proxy(reprobe: bool = False, switch: bool = False,
                       avoid_exit_ip: Optional[str] = None,
                       reason: str = "") -> Optional[str]:
    """Returns the proxy the next Gemini client must use.

    The first call starts the private Xray pool and probes every candidate.
    Later calls reuse the winner unless `reprobe` asks for fresh numbers or
    `switch` asks for a different exit (429 / degraded model registry).
    """
    global GEMINI_PROXY

    if not VPN_ENABLED or vpn_pool is None:
        return GEMINI_PROXY

    async with vpn_lock:
        current = vpn_state.get("winner") or {}
        if (not reprobe and not switch and vpn_state["source"] == "pool"
                and current.get("port") and vpn_pool.is_running()):
            return GEMINI_PROXY

        started = await asyncio.to_thread(vpn_pool.ensure_started)
        if not started:
            vpn_state["last_error"] = vpn_pool.last_error or "Xray не запустился"
            vpn_state["last_probe_at"] = time.time()
            if vpn_state["source"] == "pool":
                GEMINI_PROXY = PROXY_FALLBACK
                vpn_state["source"] = "env" if PROXY_FALLBACK else "none"
                vpn_state["winner"] = None
                bridge_state["vpn_dirty"] = True
                print("[VPN] Пул остановлен — возвращаюсь на GEMINI_PROXY из .env.")
            return GEMINI_PROXY

        cookies = _probe_cookies()
        print(f"[VPN] Проверяю {len(vpn_pool.ports)} узлов ({reason or 'probe'})...")
        results = await vpn_pool.probe(cookies)
        working = [r for r in results if r["ok"]]
        results.sort(key=lambda r: (not r["ok"], r["latency_ms"] or 10**9))
        vpn_state["last_probe_at"] = time.time()
        vpn_state["last_probe_reason"] = reason or "probe"
        vpn_state["probe_results"] = [
            {
                "label": r["label"], "country": r["country"], "port": r["port"],
                "ok": r["ok"], "status": r["status"], "body_bytes": r["body_bytes"],
                "latency_ms": r["latency_ms"], "exit_ip": r["exit_ip"],
                "error": r["error"], "signed_in": r.get("signed_in"),
            }
            for r in results[:12]
        ]

        if not working:
            vpn_state["last_error"] = "Ни один узел не прошёл проверку gemini.google.com"
            if current.get("port") and vpn_pool.is_running():
                # A transient probe failure must not tear down a session that
                # is still generating through the current exit.
                print("[VPN] Проба не удалась, но текущий узел жив — оставляю его.")
                return GEMINI_PROXY
            GEMINI_PROXY = PROXY_FALLBACK
            vpn_state["source"] = "env" if PROXY_FALLBACK else "none"
            vpn_state["winner"] = None
            bridge_state["vpn_dirty"] = True
            print("[VPN] Живых узлов нет — возвращаюсь на GEMINI_PROXY из .env.")
            return GEMINI_PROXY

        vpn_state["last_error"] = None

        def best(rows):
            # An exit where the account is guest level is reachable but useless
            # for Pro models, so it loses to any exit that keeps the session.
            return min(rows, key=lambda r: (r.get("signed_in") is False,
                                            r["latency_ms"] or 10**9))

        if switch:
            candidates = [r for r in working if r["port"] != current.get("port")]
            if avoid_exit_ip:
                different_exit = [r for r in candidates if r.get("exit_ip") != avoid_exit_ip]
                candidates = different_exit or candidates
            candidates = candidates or working
            winner = best(candidates)
        elif current.get("port"):
            winner = next((r for r in working if r["port"] == current["port"]), None)
            if winner is None:
                winner = best(working)
        else:
            winner = best(working)

        old_proxy = GEMINI_PROXY
        winner_state = {
            "index_id": winner["index_id"],
            "port": winner["port"],
            "proxy": winner["proxy"],
            "label": winner["label"],
            "country": winner["country"],
            "exit_ip": winner["exit_ip"],
            "latency_ms": winner["latency_ms"],
            "selected_at": time.time(),
        }
        vpn_state["winner"] = winner_state
        vpn_state["source"] = "pool"
        GEMINI_PROXY = winner["proxy"]

        if old_proxy != GEMINI_PROXY:
            vpn_state["switches"] = vpn_state.get("switches", 0) + 1
            bridge_state["vpn_dirty"] = True
            print(f"[VPN] Google идёт через {winner['label']} "
                  f"({winner['country'] or '??'}), exit {winner['exit_ip'] or '?'}, "
                  f"{winner['latency_ms']} мс.")
        else:
            print(f"[VPN] Оставляю {winner['label']} — {winner['latency_ms']} мс.")

        vpn_pool.save_state({
            "index_id": winner["index_id"],
            "label": winner["label"],
            "country": winner["country"],
            "exit_ip": winner["exit_ip"],
            "latency_ms": winner["latency_ms"],
            "at": time.time(),
        })
        return GEMINI_PROXY


def schedule_vpn_recovery(reason: str) -> None:
    """Moves the bridge to another exit after a 429 without blocking the reply."""
    global _vpn_recovery_task

    if not VPN_ENABLED or vpn_pool is None:
        return
    if _vpn_recovery_task is not None and not _vpn_recovery_task.done():
        return

    async def runner() -> None:
        try:
            await asyncio.sleep(2)
            current_exit = (vpn_state.get("winner") or {}).get("exit_ip")
            proxy = await ensure_proxy(switch=True, avoid_exit_ip=current_exit,
                                       reason=reason)
            if proxy:
                bridge_state["vpn_dirty"] = True
                print("[VPN] Восстановление после 429 завершено; следующий запрос "
                      "переинициализирует сессию через другой выход.")
        except Exception as exc:  # noqa: BLE001 - background best effort
            print(f"[VPN] Фоновое переключение не удалось: {exc}")

    _vpn_recovery_task = asyncio.create_task(runner())


async def vpn_maintenance_loop() -> None:
    while True:
        await asyncio.sleep(VPN_PROBE_INTERVAL)
        try:
            await ensure_proxy(reprobe=True, reason="interval")
        except Exception as exc:  # noqa: BLE001
            print(f"[VPN] Плановая проверка узлов: {exc}")


async def vpn_bootstrap() -> None:
    """Selects an exit before the first Gemini client is built."""
    if VPN_ENABLED and vpn_pool is not None:
        try:
            await ensure_proxy(reason="startup")
        except Exception as exc:  # noqa: BLE001 - warmup still runs on fallback
            print(f"[VPN] Стартовый выбор узла не удался: {exc}")
    await warmup()


async def cookie_persistence_loop():
    """Keeps .env in sync with the Google-rotated tokens of the live client."""
    ticks = 0
    while True:
        await asyncio.sleep(30)
        ticks += 1
        try:
            if client_instance and client_instance._running:
                live = {c.name: c.value for c in client_instance.cookies.jar
                        if c.name in ("__Secure-1PSID", "__Secure-1PSIDTS") and c.value}
                psid = live.get("__Secure-1PSID")
                psidts = live.get("__Secure-1PSIDTS")
                changed = (
                    (psid and psid != os.environ.get("GEMINI_SECURE_1PSID")) or
                    (psidts and psidts != os.environ.get("GEMINI_SECURE_1PSIDTS"))
                )
                if changed:
                    print("[INFO] Google обновил сессионные куки. Сохраняем в .env...")
                    update_env_file(psid=psid, psidts=psidts)
                if ticks % 10 == 0:
                    # The registry is filled once at init. If Google answered a
                    # 429 then, it stays partial and every request silently runs
                    # on flash-lite until a restart — which risks another 429.
                    # This refetch reuses the session and needs no new token.
                    before = {m.model_name for m in selectable_models(client_instance.list_models() or [])}
                    if len(before) < 3:
                        try:
                            await client_instance._fetch_user_status()
                        except Exception as refetch_err:
                            print(f"[MODELS] Переспрос реестра не удался: {refetch_err}")
                        unlock_verified_models(client_instance)
                        after = {m.model_name for m in selectable_models(client_instance.list_models() or [])}
                        bridge_state["last_models_refresh_at"] = time.time()
                        if after != before:
                            print(f"[MODELS] Список моделей аккаунта обновился: {sorted(after)}")
                if ticks % 20 == 0:
                    # gemini_webapi only starts its own rotation when the status
                    # RPC says AVAILABLE. That RPC reports UNAUTHENTICATED on a
                    # session that still generates, so rotation never starts,
                    # 1PSIDTS ages out within the hour and the account silently
                    # drops to guest level: flash-lite only, no tier, no quota.
                    # Rotate here regardless of what the status endpoint thinks.
                    try:
                        fresh = await rotate_1psidts(client_instance._live_client, client_instance.verbose)
                        if fresh:
                            os.environ["GEMINI_SECURE_1PSIDTS"] = fresh
                            update_env_file(psidts=fresh)
                            bridge_state["last_rotation_at"] = time.time()
                            bridge_state["last_rotation_ok"] = True
                            bridge_state["last_rotation_error"] = None
                            print("[ROTATE] 1PSIDTS обновлён и сохранён.")
                        else:
                            bridge_state["last_rotation_at"] = time.time()
                            bridge_state["last_rotation_ok"] = False
                            bridge_state["last_rotation_error"] = "Google вернул пустой 1PSIDTS"
                            print("[ROTATE] Google не вернул новый 1PSIDTS — повторим через интервал.")
                    except Exception as rot_err:
                        bridge_state["last_rotation_at"] = time.time()
                        bridge_state["last_rotation_ok"] = False
                        bridge_state["last_rotation_error"] = str(rot_err)
                        print(f"[ROTATE] Не удалось обновить 1PSIDTS: {rot_err}")

                if ticks % 20 == 0:
                    # One line every ten minutes: the state that used to be
                    # invisible when the bridge ran without a console.
                    status_name = getattr(getattr(client_instance, "account_status", None), "name", "?")
                    models = [m.model_name for m in (client_instance.list_models() or [])]
                    last_rot = bridge_state.get("last_rotation_at")
                    rot_age = f"{int((time.time() - last_rot) // 60)} мин назад" if last_rot else "никогда"
                    print(f"[STATE] account={status_name} models={models} rotation={rot_age} "
                          f"inflight={bridge_state['inflight']}")
        except Exception as e:
            print(f"[WARN] Цикл обновления сессии: {e}")

REGISTRY_RECOVERY_MAX_ATTEMPTS = 4

async def registry_recovery_loop():
    """Restores a throttled model registry without a restart and without hammering.

    A partial registry used to persist until the process was restarted. This waits
    with a growing delay, moves exit once per attempt, never touches a session with
    a request in flight, and stops asking after a few failures — a signed-out
    account is not recoverable by retrying, and every retry costs a bootstrap token.
    """
    delay = 300.0
    attempts = 0
    next_at = time.time() + delay
    while True:
        await asyncio.sleep(30)
        try:
            if client_instance is None or not client_instance._running:
                continue
            usable = selectable_models(client_instance.list_models() or [])
            if len(usable) >= 3:
                if attempts:
                    print("[RECOVERY] Реестр моделей восстановлен.")
                attempts, delay = 0, 300.0
                next_at = time.time() + delay
                bridge_state["registry_recovery"] = {"attempts": 0, "last_result": "healthy"}
                continue

            identity = bridge_state.get("session_identity") or {}
            if identity.get("authenticated") is False and identity.get("reason") != "captcha":
                bridge_state["registry_recovery"] = {"attempts": attempts, "last_result": "signed_out"}
                continue
            if attempts >= REGISTRY_RECOVERY_MAX_ATTEMPTS:
                bridge_state["registry_recovery"] = {"attempts": attempts, "last_result": "gave_up"}
                continue
            if bridge_state["inflight"] > 0 or time.time() < next_at:
                continue

            attempts += 1
            print(f"[RECOVERY] Реестр урезан — попытка {attempts}/{REGISTRY_RECOVERY_MAX_ATTEMPTS} "
                  "через другой выход.")
            current_exit = (vpn_state.get("winner") or {}).get("exit_ip")
            await ensure_proxy(switch=True, avoid_exit_ip=current_exit, reason="registry-recovery")
            try:
                client = await get_gemini_client(force_refresh=True)
                unlock_verified_models(client)
                restored = len(selectable_models(client.list_models() or []))
            except Exception as exc:  # noqa: BLE001 - background best effort
                print(f"[RECOVERY] Попытка не удалась: {exc}")
                restored = 0
            if restored >= 3:
                attempts, delay = 0, 300.0
                bridge_state["registry_recovery"] = {"attempts": 0, "last_result": "recovered"}
            else:
                delay = min(delay * 2, 1800.0)
                bridge_state["registry_recovery"] = {
                    "attempts": attempts, "last_result": "still_partial",
                    "next_attempt_in_seconds": int(delay),
                }
            next_at = time.time() + delay
        except Exception as exc:  # noqa: BLE001 - the loop must survive anything
            print(f"[RECOVERY] Цикл восстановления: {exc}")


async def warmup():
    try:
        cleanup_old_upload_cache(0)
        await get_gemini_client()
    except Exception as e:
        print(f"[WARN] Авто-прогрев при старте: {e}")

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    load_env_file()
    # Warmup used to be awaited here, so the port did not accept connections
    # until Google finished the bootstrap (init timeout is 5 minutes). A slow
    # bootstrap then looked like "the bridge is not running". The first request
    # still waits on the same lock, so nothing is duplicated.
    # vpn_bootstrap picks an exit before warmup builds the Gemini client.
    asyncio.create_task(vpn_bootstrap())
    asyncio.create_task(cookie_persistence_loop())
    recovery_task = asyncio.create_task(registry_recovery_loop())
    maintenance_task = None
    if VPN_ENABLED and vpn_pool is not None:
        maintenance_task = asyncio.create_task(vpn_maintenance_loop())
    print(f"[BOOT] Мост запущен на http://{HOST}:{PORT} · proxy={GEMINI_PROXY or 'нет'} · лог={LOG_PATH}")
    yield
    # Shutdown
    global client_instance
    recovery_task.cancel()
    if maintenance_task is not None:
        maintenance_task.cancel()
    if vpn_pool is not None:
        try:
            await asyncio.to_thread(vpn_pool.stop)
        except Exception:
            pass
    if client_instance:
        try:
            await client_instance.close()
        except Exception:
            pass

app = FastAPI(
    title="Gemini Web Bridge (Google AI Pro - Antigravity Orchestrator Edition)",
    version="1.9.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ChatMessage(BaseModel):
    role: str
    content: Union[str, List[Any], None] = None
    name: Optional[str] = None
    tool_call_id: Optional[str] = None
    tool_calls: Optional[List[Any]] = None

class ChatCompletionRequest(BaseModel):
    model: str
    messages: List[ChatMessage]
    stream: Optional[bool] = False
    temperature: Optional[float] = 0.7
    max_tokens: Optional[int] = None
    stop: Optional[Union[str, List[str]]] = None
    tools: Optional[List[Any]] = None
    tool_choice: Optional[Any] = None
    reasoning_effort: Optional[str] = None

def orchestrator_route(messages: List[ChatMessage], tools: Optional[List[Any]], effort: str, prompt_text: str = "") -> tuple[str, bool]:
    """Picks a real account model plus a thinking flag for the current turn."""
    if "reply with only the title" in prompt_text.lower():
        return "gemini-flash-lite", False

    last_msg = messages[-1] if messages else None
    user_text = str(last_msg.content or "").lower() if last_msg else ""
    deep_plan_keywords = [
        "подробный план", "детальный план", "архитектур", "спроектируй с нуля",
        "detailed plan", "system architecture", "software design document"
    ]
    wants_depth = effort in ("high", "medium") or any(kw in user_text for kw in deep_plan_keywords)

    if wants_depth:
        return "gemini-carbon", True
    if effort in ("low", "none"):
        return "gemini-4-hydrogen", False

    # Agentic turns: thinking makes the model's reasoning visible in the client,
    # at the cost of latency on every tool round. AGENT_THINKING=0 trades the
    # visible reasoning for speed.
    if tools or (last_msg and last_msg.role in ("tool", "function")):
        return "gemini-4-hydrogen", AGENT_THINKING

    return "gemini-4-hydrogen", AGENT_THINKING

def resolve_available_model(client, wanted: str) -> str:
    """Resolve same-model aliases; explicit selections never change family."""
    try:
        return select_model(client.list_models() or [], wanted).model
    except ModelSelectionError as exc:
        raise HTTPException(status_code=503, detail={"code": exc.code, "message": str(exc)}) from exc

def detect_file_extension(raw_bytes: bytes, mime_type: str = "", filename: str = "") -> str:
    """Inspects filename, magic bytes, and MIME type to ensure exact file extensions for Google Vision/Files/Video/Audio."""
    # 1. Filename extension if provided
    if filename:
        p = Path(filename)
        if p.suffix and len(p.suffix) <= 8:
            return p.suffix.lower()

    # 2. Magic byte inspection
    # Images
    if raw_bytes.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if raw_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if raw_bytes.startswith(b"RIFF") and b"WEBP" in raw_bytes[:16]:
        return ".webp"
    if raw_bytes.startswith(b"GIF87a") or raw_bytes.startswith(b"GIF89a"):
        return ".gif"
    if raw_bytes.startswith(b"%PDF"):
        return ".pdf"
    if raw_bytes.startswith(b"BM"):
        return ".bmp"
    if raw_bytes.startswith(b"\x00\x00\x01\x00"):
        return ".ico"

    # Videos
    if len(raw_bytes) > 8 and raw_bytes[4:8] == b"ftyp":
        brand = raw_bytes[8:12]
        if brand in (b"qt  ", b"moov"):
            return ".mov"
        if brand in (b"M4A ", b"M4B "):
            return ".m4a"
        return ".mp4"
    if raw_bytes.startswith(b"\x1a\x45\xdf\xa3"):
        if b"webm" in raw_bytes[:64].lower():
            return ".webm"
        return ".mkv"
    if raw_bytes.startswith(b"RIFF") and b"AVI " in raw_bytes[:16]:
        return ".avi"
    if raw_bytes.startswith(b"FLV\x01"):
        return ".flv"

    # Audio
    if raw_bytes.startswith(b"ID3") or (len(raw_bytes) > 2 and raw_bytes[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2")):
        return ".mp3"
    if raw_bytes.startswith(b"RIFF") and b"WAVE" in raw_bytes[:16]:
        return ".wav"
    if raw_bytes.startswith(b"OggS"):
        return ".ogg"
    if raw_bytes.startswith(b"fLaC"):
        return ".flac"

    # 3. MIME type inspection
    mime_lower = (mime_type or "").lower()
    # Images
    if "png" in mime_lower:
        return ".png"
    if "jpeg" in mime_lower or "jpg" in mime_lower:
        return ".jpg"
    if "webp" in mime_lower:
        return ".webp"
    if "gif" in mime_lower:
        return ".gif"
    if "pdf" in mime_lower:
        return ".pdf"
    if "bmp" in mime_lower:
        return ".bmp"
    if "svg" in mime_lower:
        return ".svg"

    # Videos
    if "mp4" in mime_lower:
        return ".mp4"
    if "webm" in mime_lower:
        return ".webm"
    if "quicktime" in mime_lower or "mov" in mime_lower:
        return ".mov"
    if "avi" in mime_lower:
        return ".avi"
    if "mkv" in mime_lower or "matroska" in mime_lower:
        return ".mkv"
    if "video" in mime_lower:
        return ".mp4"

    # Audios
    if "mp3" in mime_lower or "mpeg" in mime_lower:
        return ".mp3"
    if "wav" in mime_lower:
        return ".wav"
    if "ogg" in mime_lower:
        return ".ogg"
    if "flac" in mime_lower:
        return ".flac"
    if "audio" in mime_lower:
        return ".mp3"

    # Text / Code
    if "csv" in mime_lower:
        return ".csv"
    if "json" in mime_lower:
        return ".json"
    if "markdown" in mime_lower or "md" in mime_lower:
        return ".md"
    if "text" in mime_lower or "plain" in mime_lower:
        return ".txt"

    # Default fallback
    return ".jpg"

def save_upload_bytes_to_disk(raw_bytes: bytes, mime_type: str = "", original_filename: str = "") -> Path:
    """Saves raw bytes into temporary disk cache with a valid extension for Google Gemini."""
    UPLOAD_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    ext = detect_file_extension(raw_bytes, mime_type, original_filename)
    safe_prefix = "upload"
    if original_filename:
        stem = Path(original_filename).stem
        cleaned = re.sub(r"[^a-zA-Z0-9_\-]", "_", stem)[:24]
        if cleaned:
            safe_prefix = f"upload_{cleaned}"
    file_id = uuid.uuid4().hex[:8]
    file_path = UPLOAD_CACHE_DIR / f"{safe_prefix}_{file_id}{ext}"
    file_path.write_bytes(raw_bytes)
    return file_path

def parse_openai_messages(messages: List[ChatMessage], tools: Optional[List[Any]] = None,
                          tool_directive: str = ""):
    """
    Parses OpenAI chat history, tool specs, assistant invocations, and extracts
    base64/local image, video, audio and document files into concrete Path objects.
    """
    system_prompts = [
        "You are an expert autonomous software engineer working directly in the user's IDE workspace.\n"
        + (
            "You have full access to the workspace tools listed below: reading, creating and editing files, "
            "running commands, and any MCP servers the client exposes.\n\n"
            "Guidelines:\n"
            "1. Direct File Changes: apply changes, fixes and refactoring to disk with the editing tools. "
            "Do not ask the user to copy-paste code.\n"
            "2. Proactive Inspection: when asked to inspect, check errors or verify code, call the appropriate tool "
            "instead of guessing.\n"
            "3. Complete Code: deliver clean, production-ready code with no incomplete placeholders."
            if tools else
            "This turn is a plain conversation: answer in text.\n\n"
            "Guidelines:\n"
            "1. Answer the question directly and completely, with production-ready code when code is asked for.\n"
            "2. Base the answer on the conversation and the files already shown, not on guesses."
        )
    ]
    dialogue_parts = []
    files_to_upload: List[Path] = []

    if tools:
        tool_names = []
        for t in tools:
            if isinstance(t, dict):
                fn = t.get("function")
                if isinstance(fn, dict) and fn.get("name"):
                    tool_names.append(fn["name"])
                elif t.get("name"):
                    tool_names.append(t["name"])

        instruction_lines = [
            "Available tools:",
            json.dumps(tools, separators=(',', ':'), ensure_ascii=False),
            "\nTo call a tool, output:",
            "```tool_call",
            '{"name": "<tool_name>", "arguments": { ... }}',
            "```\n",
            "The tools listed above ARE available right now. They are executed by the client on your behalf: "
            "you emit a tool_call block, the client runs it and returns the next turn as 'Tool Result (<name>): ...'. "
            "Tool access stays enabled for the whole session, so keep calling tools across as many turns "
            "as the task needs.",
            "Read the Tool Result and continue the task. Apply the change with the editing tools, then "
            "verify it with a read or a command. The work is finished when the change is on disk and checked.",
            "When the task is finished, reply in plain text with no tool_call block.\n",
        ]

        # One example, generated from the schema of a tool that is really in this
        # request. The old block hardcoded `edit` as {path, edits:[{oldText,
        # newText}]} and `write` as {path, content} plus a Godot-only `execute`
        # call, so the model was taught arguments the client does not accept and
        # every edit came back malformed.
        def _example_value(spec: Dict[str, Any]) -> Any:
            kind = (spec or {}).get("type")
            enum = (spec or {}).get("enum")
            if enum:
                return enum[0]
            return {
                "string": "...",
                "number": 0,
                "integer": 0,
                "boolean": False,
                "array": [],
                "object": {},
            }.get(kind, "...")

        def _example_arguments(name: str) -> Dict[str, Any]:
            fn = next((t.get("function") for t in tools
                       if isinstance(t, dict) and (t.get("function") or {}).get("name") == name), {}) or {}
            params = fn.get("parameters") or {}
            props = params.get("properties") or {}
            required = params.get("required") or []
            if not required:
                required = list(props)[:2]
            return {k: _example_value(props.get(k) or {}) for k in required}

        example_tool = next((n for n in ("read", "read_file", "bash", "execute", "write", "edit")
                             if n in tool_names), tool_names[0])
        tool_example = {
            "name": example_tool,
            "arguments": _example_arguments(example_tool),
        }
        instruction_lines += [
            "\nExample for a tool from this request:",
            "Assistant: ```tool_call",
            json.dumps(tool_example, ensure_ascii=False),
            "```\n",
        ]

        tools_instruction = "\n".join(instruction_lines)
        system_prompts.append(tools_instruction)
    if tool_directive:
        system_prompts.append(tool_directive)

    processed_messages = messages

    # OpenCode sends tool results with a tool_call_id and no name. Rendering that
    # id as the tool name told the model nothing about which call answered, so a
    # turn with several calls could not be followed at all.
    call_names: Dict[str, str] = {}
    for m in processed_messages:
        for tc in (m.tool_calls or []):
            if isinstance(tc, dict) and tc.get("id"):
                fn = tc.get("function") or {}
                call_names[tc["id"]] = fn.get("name") or tc.get("name") or ""

    for m_idx, m in enumerate(processed_messages):
        text = ""
        if isinstance(m.content, str):
            text = m.content
        elif isinstance(m.content, list):
            parts = []
            for item in m.content:
                if isinstance(item, dict):
                    item_type = item.get("type", "")
                    if item_type == "text":
                        parts.append(item.get("text", ""))
                    else:
                        raw_bytes = None
                        mime = ""
                        filename = ""
                        url = ""

                        # Format A: OpenAI image_url { url: "..." }
                        if item_type == "image_url" or "image_url" in item:
                            img_obj = item.get("image_url", {})
                            url = img_obj if isinstance(img_obj, str) else img_obj.get("url", "")

                        # Format B: Video { type: "video_url", video_url: { url: "..." } } or { type: "video" }
                        elif item_type in ("video_url", "video") or "video_url" in item:
                            vid_obj = item.get("video_url", {})
                            url = vid_obj if isinstance(vid_obj, str) else vid_obj.get("url", "")

                        # Format C: OpenCode @ai-sdk file { filename: "...", file_data: "data:...;base64,..." }
                        elif item_type == "file" or "file" in item:
                            f_obj = item.get("file", {})
                            if isinstance(f_obj, dict):
                                filename = f_obj.get("filename", "") or f_obj.get("name", "")
                                url = f_obj.get("file_data", "") or f_obj.get("url", "") or f_obj.get("path", "")
                            elif isinstance(f_obj, str):
                                url = f_obj

                        # Format D: Anthropic / Cline source { type: "base64", media_type: "...", data: "..." }
                        elif "source" in item:
                            src = item.get("source", {})
                            if isinstance(src, dict) and src.get("type") == "base64":
                                raw_b64 = src.get("data", "")
                                mime = src.get("media_type", "")
                                if raw_b64:
                                    try:
                                        raw_bytes = base64.b64decode(raw_b64)
                                    except Exception as ex:
                                        print(f"[WARN] Ошибка декодирования source.data base64: {ex}")

                        # Format E: Audio input_audio { data: "...", format: "wav" }
                        elif item_type in ("input_audio", "audio") or "input_audio" in item:
                            aud = item.get("input_audio", {})
                            if isinstance(aud, dict):
                                raw_b64 = aud.get("data", "")
                                fmt = aud.get("format", "wav")
                                mime = f"audio/{fmt}"
                                if raw_b64:
                                    try:
                                        raw_bytes = base64.b64decode(raw_b64)
                                    except Exception as ex:
                                        print(f"[WARN] Ошибка декодирования audio base64: {ex}")

                        # Fallback URL fields
                        if not raw_bytes and not url:
                            url = item.get("url", "") or item.get("path", "") or item.get("file_path", "")
                            if not filename:
                                filename = item.get("filename", "") or item.get("name", "")

                        # Parse extracted URL or raw_bytes
                        if url and not raw_bytes:
                            if url.startswith("data:"):
                                try:
                                    header, b64_data = url.split(",", 1)
                                    if ":" in header and ";" in header:
                                        mime = header.split(";")[0].split(":")[1]
                                    raw_bytes = base64.b64decode(b64_data)
                                except Exception as ex:
                                    print(f"[WARN] Ошибка декодирования data URI base64: {ex}")
                            elif url.startswith("file://"):
                                clean = url[7:]
                                if clean.startswith("localhost/"):
                                    clean = clean[10:]
                                elif clean.startswith("/"):
                                    clean = clean.lstrip("/")
                                clean = urllib.parse.unquote(clean)
                                local_p = Path(clean)
                                if local_p.is_file():
                                    files_to_upload.append(local_p)
                                else:
                                    parsed_path = urllib.request.url2pathname(urllib.parse.urlparse(url).path)
                                    p2 = Path(parsed_path)
                                    if p2.is_file():
                                        files_to_upload.append(p2)
                            elif url.startswith("http://") or url.startswith("https://"):
                                try:
                                    req_dl = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                                    with urllib.request.urlopen(req_dl, timeout=15) as resp:
                                        raw_bytes = resp.read(MAX_REMOTE_MEDIA_BYTES + 1)
                                    if len(raw_bytes) > MAX_REMOTE_MEDIA_BYTES:
                                        print(f"[WARN] Медиафайл по URL больше {MAX_REMOTE_MEDIA_BYTES} байт, пропущен: {url}")
                                        raw_bytes = None
                                    else:
                                        mime = resp.headers.get_content_type() or ""
                                except Exception as dl_err:
                                    print(f"[WARN] Ошибка скачивания медиафайла по URL {url}: {dl_err}")
                            elif os.path.exists(url) and os.path.isfile(url):
                                files_to_upload.append(Path(url))

                        # Save raw bytes to disk with magic-byte verified extension
                        if raw_bytes:
                            saved_path = save_upload_bytes_to_disk(raw_bytes, mime, filename)
                            files_to_upload.append(saved_path)
                            print(f"[INFO] Сохранен файл для Google Vision/Files: {saved_path.name} ({len(raw_bytes)} байт)")

                elif isinstance(item, str):
                    parts.append(item)
            text = "\n".join(parts)

        if m.role == "system":
            system_prompts.append(text)
        elif m.role == "user":
            dialogue_parts.append(f"User: {text}")
        elif m.role == "assistant":
            parts = []
            if text:
                parts.append(text)
            if m.tool_calls:
                for tc in m.tool_calls:
                    tc_fn = tc.get("function", {}) if isinstance(tc, dict) else {}
                    tc_name = tc_fn.get("name") or (tc.get("name") if isinstance(tc, dict) else "")
                    tc_args = tc_fn.get("arguments") or (tc.get("arguments") if isinstance(tc, dict) else {})
                    args_val = tc_args if isinstance(tc_args, str) else json.dumps(tc_args, ensure_ascii=False)
                    tc_id = tc.get("id") if isinstance(tc, dict) else None
                    call_tag = f" [call: {tc_id}]" if tc_id else ""
                    parts.append(f"```tool_call\n{{\"name\": {json.dumps(tc_name)}, \"arguments\": {args_val}}}\n```{call_tag}")
            dialogue_parts.append(f"Assistant: {' '.join(parts)}")
        elif m.role in ("tool", "function"):
            call_id = m.tool_call_id or ""
            tool_name = m.name or call_names.get(call_id) or call_id or "tool"
            call_tag = f", call: {call_id}" if call_id else ""
            dialogue_parts.append(f"Tool Result ({tool_name}{call_tag}): {text}")
        else:
            dialogue_parts.append(f"{m.role.capitalize()}: {text}")

    full_prompt = ""
    if system_prompts:
        full_prompt += "### System Instructions:\n" + "\n\n".join(system_prompts) + "\n\n"
    # Placed last on purpose. With the rules only at the top the model routinely
    # diagnosed the bug and handed back a plan instead of editing the file; the
    # reminder has to sit next to the generation point to be acted on.
    action_reminder = ""
    if tools and dialogue_parts:
        action_reminder = (
            "\n\n[Tools are enabled. Continue the task now: emit the next tool_call block, apply the "
            "change and verify it. Reply in plain text only once the work is complete and checked.]"
        )
    if dialogue_parts:
        if len(dialogue_parts) == 1 and dialogue_parts[0].startswith("User: ") and not system_prompts:
            full_prompt = dialogue_parts[0][6:]
        else:
            full_prompt += "\n\n".join(dialogue_parts)
            if not dialogue_parts[-1].startswith("Assistant:"):
                full_prompt += action_reminder + "\n\nAssistant:"

    if len(full_prompt) > MAX_PROMPT_CHARS:
        print(f"[CONTEXT] Промпт {len(full_prompt)} симв > лимита {MAX_PROMPT_CHARS}. Отбрасываем самые старые ходы целиком.")
        header = "### System Instructions:\n" + "\n\n".join(system_prompts) + "\n\n" if system_prompts else ""
        dropped = 0
        while len(dialogue_parts) > 2:
            candidate = header + "\n\n".join(dialogue_parts) + "\n\nAssistant:"
            if len(candidate) <= MAX_PROMPT_CHARS:
                break
            dialogue_parts.pop(0)
            dropped += 1
        # A tool result without the call that produced it reads as an unexplained
        # observation, and the model answers it instead of continuing the task.
        while len(dialogue_parts) > 1 and dialogue_parts[0].startswith("Tool Result ("):
            dialogue_parts.pop(0)
            dropped += 1
        if dropped:
            dialogue_parts.insert(0, f"[{dropped} earlier turn(s) dropped: they no longer fit the Gemini Web prompt limit.]")
        tail = action_reminder + "\n\nAssistant:"
        body = "\n\n".join(dialogue_parts)
        if len(header) + len(body) + len(tail) > MAX_PROMPT_CHARS:
            # Two retained turns can still be too big — one file read is enough.
            # Keep the newest text: the tail is what the model has to act on.
            marker = "[earlier context trimmed to fit the Gemini Web prompt limit]\n\n"
            keep = MAX_PROMPT_CHARS - len(header) - len(marker) - len(tail)
            body = marker + (body[-keep:] if keep > 0 else "")
        full_prompt = header + body + tail

    return full_prompt.strip(), files_to_upload

def collect_tool_names(tools: Optional[List[Any]]) -> set:
    names = set()
    for t in tools or []:
        if isinstance(t, dict):
            fn = t.get("function")
            if isinstance(fn, dict) and fn.get("name"):
                names.add(fn["name"])
            elif t.get("name"):
                names.add(t["name"])
    return names

ARG_KEYS = ("arguments", "parameters", "args", "params", "input")

def estimate_tokens(text: str) -> int:
    """The web session reports no token counts, so this is an estimate.

    Counting words, as this used to, undercounts code badly: a minified line is
    one word and hundreds of tokens, and the client sizes its context budget
    from these numbers.
    """
    return len(text or "") // 4

def normalize_stops(stop: Optional[Union[str, List[str]]]) -> List[str]:
    if not stop:
        return []
    items = [stop] if isinstance(stop, str) else list(stop)
    return [s for s in items if isinstance(s, str) and s][:4]

def output_limits(text: str, stops: List[str], max_tokens: Optional[int],
                  complete: bool = False) -> tuple[int, Optional[str]]:
    """Enforces stop and max_tokens here, because Gemini Web accepts neither.

    Returns how much of the cumulative text may be emitted and whether generation
    should end. While no stop has matched, a tail of len(stop)-1 is held back so a
    sequence split across chunks is still caught — that also keeps the emitted
    prefix from ever having to shrink.

    `complete` marks the finished text. The hold-back exists only for a sequence
    that may still arrive; applying it to a finished answer cut the last
    characters off every non-streamed reply that carried a stop sequence.
    """
    limit = len(text)
    reason = None

    if max_tokens is not None and max_tokens > 0:
        budget = max_tokens * 4
        if limit > budget:
            limit = budget
            reason = "length"

    if stops:
        earliest = None
        for s in stops:
            i = text.find(s)
            if i != -1 and (earliest is None or i < earliest):
                earliest = i
        if earliest is not None:
            if earliest <= limit:
                limit = earliest
                reason = "stop"
        elif not complete:
            guard = max(len(s) for s in stops) - 1
            if guard > 0:
                limit = min(limit, max(0, len(text) - guard))

    return limit, reason

CONTINUE_NUDGE = (
    "The tools are live in this turn and the task is still in progress. If any change is unapplied "
    "or unverified, emit the next tool_call block now. If the task really is complete, reply with "
    "the final answer only."
)

# How many continuation attempts a stalled turn may cost. Each one is a whole
# extra generation, so this is deliberately small and only fires on turns that
# actually look stalled.
CONTINUE_NUDGES = int(os.getenv("CONTINUE_NUDGES", "2"))

_STALL_MARKERS = (
    "i can't", "i cannot", "i don't have access", "i do not have access",
    "i don't have the ability", "i am unable to", "i'm unable to",
    "не могу", "не имею доступа", "нет доступа", "не в состоянии",
    "here's the plan", "here is the plan", "вот план", "план действий",
    "would you like me to", "хотите, чтобы я", "should i proceed",
    "let me know if you want me to", "please provide", "предоставьте",
    # A flash-class model invents an exhausted tool budget when it would rather
    # describe the work than do it. OpenCode does have a real step limit, but it
    # announces it by sending tool_choice "none" and no tools at all, and both
    # nudge sites require tool_names — so these markers can only fire on a turn
    # where tools really are on offer.
    "ran out of tool calls", "out of tool calls", "no tool calls remaining",
    "0 tool calls", "maximum number of tool calls", "tool calls has been exceeded",
    "maximum steps", "tools are disabled", "tool execution is currently disabled",
    "закончились вызовы инструментов", "лимит вызовов инструментов",
)


def looks_like_stall(text: str) -> bool:
    """Prose that replaces work with a plan, an excuse or a question.

    Nudging every answer that came without a tool call tripled the cost of an
    ordinary reply: the client offers tools on every request, so a plain final
    answer looked identical to a model that refused to act. This is the signal
    that separates the two.
    """
    t = (text or "").strip().lower()
    if not t:
        return True
    if "```tool_call" in t or "<tool_call>" in t:
        return False
    return any(p in t for p in _STALL_MARKERS)

def nudge_budget(text: str, agent_turn: bool) -> int:
    """How many continuation attempts this reply may cost.

    An agent turn used to earn the full budget unconditionally, so every completed
    turn paid two extra generations to re-ask a final answer that was already
    correct. Clean prose on an agent turn now gets one rescue attempt; a
    recognised stall still gets the full budget.
    """
    if looks_like_stall(text):
        return CONTINUE_NUDGES
    return min(1, CONTINUE_NUDGES) if agent_turn else 0


def repair_json(raw: str) -> Any:
    """Parses the JSON models actually emit, not just well-formed JSON.

    A web model writing a tool call by hand produces trailing commas, Python
    literals, single-quoted keys and occasionally a truncated tail. Rejecting
    those turns a usable call into a plain-text answer and stalls the agent.
    Raises ValueError when nothing usable can be recovered.
    """
    text = (raw or "").strip()
    if not text:
        raise ValueError("empty")

    try:
        return json.loads(text)
    except Exception:
        pass

    candidate = re.sub(r",\s*([}\]])", r"\1", text)
    candidate = re.sub(r"\b(True|False|None)\b",
                       lambda m: {"True": "true", "False": "false", "None": "null"}[m.group(1)],
                       candidate)
    try:
        return json.loads(candidate)
    except Exception:
        pass

    # Single-quoted keys and values, but only when double quotes are absent:
    # a blanket replace would corrupt apostrophes inside real content.
    if "'" in candidate and '"' not in candidate:
        quoted = re.sub(r"'([^'\\]*)'", lambda m: json.dumps(m.group(1)), candidate)
        try:
            return json.loads(quoted)
        except Exception:
            pass

    # Truncated tail: close what is still open, dropping a dangling fragment.
    trimmed = candidate.rstrip()
    trimmed = re.sub(r",\s*$", "", trimmed)
    # A key whose value never arrived would close into `"path":}`.
    trimmed = re.sub(r',?\s*"[^"]*"\s*:\s*$', "", trimmed)
    stack = []
    in_str = False
    esc = False
    for ch in trimmed:
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append(ch)
        elif ch in "}]" and stack:
            stack.pop()
    if in_str:
        trimmed += '"'
    for opener in reversed(stack):
        trimmed += "}" if opener == "{" else "]"
    trimmed = re.sub(r",\s*([}\]])", r"\1", trimmed)
    try:
        return json.loads(trimmed)
    except Exception as e:
        raise ValueError(str(e))


def match_tool_name(name: str, tool_names: set) -> Optional[str]:
    """Maps a near-miss name onto a tool that was actually offered."""
    if not name or not tool_names:
        return None
    if name in tool_names:
        return name
    lowered = {n.lower(): n for n in tool_names}
    if name.lower() in lowered:
        return lowered[name.lower()]
    normalized = name.lower().replace("-", "_").replace(" ", "_")
    for key, original in lowered.items():
        if key.replace("-", "_") == normalized:
            return original
    import difflib
    close = difflib.get_close_matches(name.lower(), list(lowered), n=1, cutoff=0.8)
    return lowered[close[0]] if close else None


def tool_call_problems(tool_calls: Optional[list], tools: Optional[list]) -> List[str]:
    """Required arguments the model left out. A repaired truncation can do this."""
    specs = {}
    for t in tools or []:
        fn = (t.get("function") or t) if isinstance(t, dict) else {}
        if fn.get("name"):
            specs[fn["name"]] = fn.get("parameters") or {}
    problems = []
    for tc in tool_calls or []:
        fn = tc.get("function") or {}
        name = fn.get("name", "")
        required = (specs.get(name) or {}).get("required") or []
        try:
            args = json.loads(fn.get("arguments") or "{}")
        except Exception:
            args = None
        if not isinstance(args, dict):
            problems.append(f"{name}: arguments must be a JSON object")
            continue
        missing = [k for k in required if k not in args]
        if missing:
            problems.append(f"{name}: missing required argument(s): {', '.join(missing)}")
    return problems


def extract_tool_calls(text: str, tool_names: Optional[set] = None) -> Optional[List[Dict[str, Any]]]:
    """Parses tool calls the model emitted.

    Only names offered in this request count. A generic JSON fence is otherwise
    indistinguishable from a config sample: a package.json answer carries
    {"name": "my-app"} and used to be executed as a tool called my-app.
    """
    if not text or not tool_names:
        return None

    results: List[Dict[str, Any]] = []
    seen_calls = set()

    def add_call(name: str, args: Any):
        resolved = match_tool_name(name, tool_names)
        if not resolved:
            return
        name = resolved
        args_str = json.dumps(args, ensure_ascii=False) if isinstance(args, dict) else str(args)
        dedup_key = (str(name), args_str)
        if dedup_key in seen_calls:
            return
        seen_calls.add(dedup_key)
        results.append({
            "id": f"call_{uuid.uuid4().hex[:8]}",
            "type": "function",
            "function": {
                "name": str(name),
                "arguments": args_str
            }
        })

    # 1. Code blocks. An explicit tool_call tag is a call on its own; any other
    #    tag (```json, ```js, bare ```) also needs an arguments-shaped key.
    cb_pattern = r"```([a-zA-Z0-9_\-]+)?\s*([\{\[][\s\S]*?)\s*```"
    for m in re.finditer(cb_pattern, text):
        tag = (m.group(1) or "").lower()
        raw = m.group(2).strip()
        try:
            parsed = repair_json(raw)
            items = parsed if isinstance(parsed, list) else [parsed]
            for item in items:
                if isinstance(item, dict):
                    name = item.get("name") or item.get("function") or item.get("tool")
                    args = item.get("arguments") or item.get("parameters") or item.get("args") or item.get("params") or item.get("input") or {}
                    # An explicit tool fence needs no arguments key: a no-argument
                    # call is valid, and requiring one dropped it whenever another
                    # call in the same reply had already produced a result.
                    if name and (any(k in item for k in ARG_KEYS) or tag in TOOL_FENCE_TAGS):
                        add_call(name, args)
        except Exception:
            # Handle multiple JSON objects concatenated inside a single code block
            for obj_m in re.finditer(r"(\{\s*\"(?:name|function|tool)\"\s*:[\s\S]*?\})(?=\s*\{|\s*$)", raw):
                try:
                    obj = repair_json(obj_m.group(1))
                    name = obj.get("name") or obj.get("function") or obj.get("tool")
                    args = obj.get("arguments") or obj.get("parameters") or obj.get("args") or {}
                    if name:
                        add_call(name, args)
                except Exception:
                    pass

    # 2. Parse XML tags: <tool_call> ... </tool_call>
    xml_pattern = r"<tool_call>([\s\S]*?)</tool_call>"
    for m in re.finditer(xml_pattern, text):
        inner = m.group(1).strip()
        if inner.startswith("{"):
            try:
                data = repair_json(inner)
                name = data.get("name") or data.get("function") or data.get("tool")
                args = data.get("arguments") or data.get("parameters") or data.get("args") or {}
                if name:
                    add_call(name, args)
                    continue
            except Exception:
                pass
        name_m = re.search(r"<name>(.*?)</name>", inner)
        args_m = re.search(r"<arguments>([\s\S]*?)</arguments>", inner)
        if name_m:
            name = name_m.group(1).strip()
            args_str = args_m.group(1).strip() if args_m else "{}"
            try:
                args_obj = json.loads(args_str)
            except Exception:
                args_obj = {"raw": args_str}
            add_call(name, args_obj)

    # 3. Fallback: bare JSON objects containing {"name": ..., "arguments": ...} anywhere in text
    if not results:
        for bare_m in re.finditer(r"\{\s*\"(?:name|function|tool)\"\s*:\s*\"([^\"]+)\"[\s\S]*?\}", text):
            try:
                data = repair_json(bare_m.group(0))
                name = data.get("name") or data.get("function") or data.get("tool")
                args = data.get("arguments") or data.get("parameters") or data.get("args") or {}
                if name:
                    add_call(name, args)
            except Exception:
                pass

    return results if results else None

def strip_tool_call_blocks(text: str, tool_names: Optional[set] = None) -> str:
    """Removes only the blocks that really are tool calls.

    This used to delete every fenced block starting with a brace or bracket, so
    a coding answer lost its package.json / tsconfig sample and kept only prose.
    """
    if not text or not tool_names:
        return (text or "").strip()

    def fence_repl(m):
        return "" if extract_tool_calls(m.group(0), tool_names) else m.group(0)
    cleaned = re.sub(r"```(?:[a-zA-Z0-9_\-]+)?\s*[\{\[][\s\S]*?[\}\]]\s*```", fence_repl, text)
    cleaned = re.sub(r"<tool_call>[\s\S]*?</tool_call>", "", cleaned)
    return cleaned.strip()

TOOL_FENCE_TAGS = ("tool_call", "tool_calls", "tools")
XML_OPEN = "<tool_call>"
FENCE_BLOCK_RE = re.compile(r"```(?:[a-zA-Z0-9_\-]+)?\s*[\{\[][\s\S]*?[\}\]]\s*```")


def safe_stream_prefix(text: str, tool_names: Optional[set]) -> int:
    """Length of the prefix that is safe to show before a tool call resolves.

    Agent turns used to buffer everything so a half-written call could not leak
    into the UI, which cost all streaming. Only the call itself needs holding:
    prose and ordinary code blocks go out immediately.
    """
    if not tool_names:
        return len(text)

    limit = len(text)

    x = text.find(XML_OPEN)
    if x != -1:
        limit = min(limit, x)

    for m in FENCE_BLOCK_RE.finditer(text):
        if extract_tool_calls(m.group(0), tool_names):
            limit = min(limit, m.start())

    # An odd number of fence markers means the last block is still open. Hold it
    # until its tag line and first body character are known: while "```t" is
    # still arriving it may yet become "```tool_call", and a prefix that shrinks
    # would mean un-sending text the client already has.
    parts = text.split("```")
    if len(parts) % 2 == 0:
        inside = parts[-1]
        tag_m = re.match(r"[a-zA-Z0-9_\-]*", inside)
        tag = tag_m.group(0).lower()
        rest = inside[tag_m.end():]
        body = rest.lstrip()
        if ("\n" not in rest or tag in TOOL_FENCE_TAGS
                or not body or body.startswith(("{", "["))):
            limit = min(limit, text.rfind("```"))

    # Never emit the first characters of a marker that is still arriving.
    m = re.search(r"`{1,2}$", text)
    if m:
        limit = min(limit, m.start())
    for k in range(len(XML_OPEN) - 1, 0, -1):
        if text.endswith(XML_OPEN[:k]):
            limit = min(limit, len(text) - k)
            break

    return max(0, limit)

def session_diagnosis() -> Dict[str, Any]:
    """What is actually wrong with the session, and the one action that fixes it."""
    identity = bridge_state.get("session_identity") or {}
    models = []
    if client_instance is not None and client_instance._running:
        models = [m.model_name for m in selectable_models(client_instance.list_models() or [])]
    if identity.get("reason") == "captcha":
        return {"signed_in": False, "problem": "captcha", "account": None,
                "action": "Google требует CAPTCHA для этого выхода: POST /admin/vpn?action=switch "
                          "или пройдите проверку в браузере моста."}
    if identity.get("authenticated") is False:
        return {"signed_in": False, "problem": "signed_out", "account": None,
                "action": "Запустите login.cmd и войдите в аккаунт Google в окне Chrome моста."}
    if len(models) < 3:
        return {"signed_in": identity.get("authenticated"), "problem": "partial_registry",
                "account": identity.get("account"),
                "action": "Реестр моделей урезан. Мост сам пробует другой выход; "
                          "ускорить — POST /admin/reinit?switch=true."}
    return {"signed_in": True, "problem": None, "account": identity.get("account"), "action": None}


@app.get("/health")
async def health_check():
    load_env_file()
    has_cookies = bool(os.getenv("GEMINI_SECURE_1PSID") or os.getenv("__Secure_1PSID") or os.getenv("SECURE_1PSID"))
    is_active = client_instance is not None and client_instance._running
    models = []
    quotas = {}
    account_status = None
    if is_active and client_instance:
        raw_models = client_instance.list_models() or []
        models = [m.model_name for m in selectable_models(raw_models)]
        quotas = client_instance._quotas or {}
        account_status = getattr(getattr(client_instance, "account_status", None), "name", None)

    last_rot = bridge_state.get("last_rotation_at")
    return {
        "status": "ok",
        "service": "Gemini Web to OpenAI Bridge (Google AI Pro - Antigravity Orchestrator Edition)",
        "version": "1.9.0",
        "cookies_configured": has_cookies,
        "client_active": is_active,
        "account_status": account_status,
        "active_models": models,
        "degraded": bool(is_active and len(models) < 3),
        "session": session_diagnosis(),
        "registry_recovery": bridge_state.get("registry_recovery"),
        "quotas": quotas,
        "endpoint": f"http://{HOST}:{PORT}/v1",
        # The bridge used to be diagnosable only from its console, which is
        # hidden when it autostarts. These are the facts needed to tell a dead
        # session from a slow Google.
        "bridge": {
            "uptime_seconds": int(time.time() - bridge_state["started_at"]),
            "proxy": GEMINI_PROXY or None,
            "last_rotation_at": last_rot,
            "last_rotation_age_seconds": int(time.time() - last_rot) if last_rot else None,
            "last_rotation_ok": bridge_state.get("last_rotation_ok"),
            "last_rotation_error": bridge_state.get("last_rotation_error"),
            "last_auth_refresh_at": bridge_state.get("last_auth_refresh_at"),
            "last_auth_error": bridge_state.get("last_auth_error"),
            "last_quota_at": bridge_state.get("last_quota_at"),
            "last_quota_source": bridge_state.get("last_quota_source"),
            "inflight_requests": bridge_state["inflight"],
            "log": str(LOG_PATH),
        },
        "vpn": vpn_public_state(),
    }

@app.get("/v1/models")
@app.get("/v1beta/models")
@app.get("/models")
async def list_models():
    models = []
    if client_instance is not None and client_instance._running:
        models = client_instance.list_models() or []
    return {**model_catalog(models), "session": session_diagnosis()}


@app.post("/v1/models/refresh")
async def refresh_models():
    """Recover the bridge-owned browser session; discover without generating a ping."""
    updated = False
    if client_instance is None or getattr(getattr(client_instance, "account_status", None), "name", None) == "UNAUTHENTICATED":
        updated = await refresh_cookies_from_browser()
    client = await get_gemini_client(force_refresh=updated)
    await client._fetch_user_status()
    unlock_verified_models(client)
    bridge_state["last_models_refresh_at"] = time.time()
    return {**model_catalog(client.list_models() or []), "session": session_diagnosis()}

@app.post("/auth/refresh")
async def auth_refresh():
    """Re-reads the Google session from the bridge Chrome and verifies it actually works."""
    browser_alive = await asyncio.to_thread(browser_debug_alive)
    updated = await refresh_cookies_from_browser() if browser_alive else False
    try:
        client = await get_gemini_client(force_refresh=updated)
    except HTTPException as e:
        return {"ok": False, "browser_alive": browser_alive, "session_updated": updated,
                "detail": str(e.detail)}
    from gemini_webapi.constants import AccountStatus
    account_status = getattr(client, "account_status", None)
    status_name = getattr(account_status, "name", "UNKNOWN")
    if account_status != AccountStatus.AVAILABLE:
        # Status alone cannot decide this: it reports UNAUTHENTICATED on cookies
        # that still generate. Probe once, and rate-limit it, because login.cmd
        # polls this endpoint every five seconds and every probe is a real
        # generation on a session Google may already be throttling.
        now = time.time()
        if updated or _auth_probe["ok"] is None or now - _auth_probe["at"] > 30:
            try:
                await client.generate_content("ping", model="gemini-flash-lite")
                _auth_probe.update(at=now, ok=True)
            except Exception as probe_err:
                _auth_probe.update(at=now, ok=False, error=str(probe_err))
                return {
                    "ok": False,
                    "browser_alive": browser_alive,
                    "session_updated": updated,
                    "account_status": status_name,
                    "detail": "Сессия Google недействительна. Запустите login.cmd и войдите в аккаунт в окне Chrome моста.",
                }
        elif not _auth_probe["ok"]:
            return {
                "ok": False,
                "browser_alive": browser_alive,
                "session_updated": updated,
                "account_status": status_name,
                "detail": "Сессия Google недействительна (проверено менее 30 с назад). "
                          "Запустите login.cmd и войдите в аккаунт в окне Chrome моста.",
            }
    models = [m.model_name for m in selectable_models(client.list_models() or [])]
    bridge_state["last_auth_refresh_at"] = time.time()
    # The cached quota was computed against the previous session; a fresh one
    # must not be answered from it.
    _quota_cache["at"] = 0.0
    degraded = len(models) < 3
    return {"ok": True, "browser_alive": browser_alive, "session_updated": updated,
            "account_status": status_name, "account_models": models,
            "degraded": degraded, "session": session_diagnosis(),
            "reason": "guest_session" if degraded else None}


@app.get("/admin/vpn")
async def vpn_status():
    """Current exit, last probe table and pool health (no node secrets)."""
    return {"ok": True, **vpn_public_state()}


@app.post("/admin/vpn")
async def vpn_admin(action: str = "probe"):
    """probe = re-check exits and keep a live winner; switch = move to another exit."""
    if not VPN_ENABLED or vpn_pool is None:
        raise HTTPException(status_code=503, detail="Автовыбор узлов отключён (VPN_AUTOSWITCH=0).")
    if action not in ("probe", "switch"):
        raise HTTPException(status_code=400, detail="action должен быть probe или switch.")
    current_exit = (vpn_state.get("winner") or {}).get("exit_ip")
    proxy = await ensure_proxy(
        reprobe=(action == "probe"),
        switch=(action == "switch"),
        avoid_exit_ip=current_exit if action == "switch" else None,
        reason=f"admin-{action}",
    )
    if action == "switch" and proxy:
        bridge_state["vpn_dirty"] = True
    return {"ok": True, "action": action, "current_proxy": proxy,
            **vpn_public_state()}

@app.post("/admin/reinit")
async def admin_reinit(switch: bool = False):
    """Rebuilds the Google session on demand, without restarting the process.

    Restarting was the only way to retry a throttled registry, and every restart
    spends a fresh bootstrap token — the very thing that earns the 429.
    """
    if switch and VPN_ENABLED and vpn_pool is not None:
        current_exit = (vpn_state.get("winner") or {}).get("exit_ip")
        await ensure_proxy(switch=True, avoid_exit_ip=current_exit, reason="admin-reinit")
    load_env_file()
    identity = await asyncio.to_thread(
        probe_session, os.getenv("GEMINI_SECURE_1PSID") or "",
        os.getenv("GEMINI_SECURE_1PSIDTS") or "", GEMINI_PROXY)
    bridge_state["session_identity"] = {**identity, "at": time.time(), "source": "admin"}
    try:
        client = await get_gemini_client(force_refresh=True)
    except HTTPException as exc:
        return {"ok": False, "session": session_diagnosis(), "detail": exc.detail}
    unlock_verified_models(client)
    _quota_cache["at"] = 0.0
    return {"ok": True, "session": session_diagnosis(),
            "account_models": [m.model_name for m in selectable_models(client.list_models() or [])]}


DASHBOARD_HTML = """<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Gemini Pro Bridge · Монитор лимитов и квот</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>💎</text></svg>">
  <style>
    :root {
      --bg: #0b0f17;
      --card-bg: #131b26;
      --card-border: #1e293b;
      --text: #f1f5f9;
      --muted: #94a3b8;
      --dim: #64748b;
      --accent: #38bdf8;
      --green: #22c55e;
      --yellow: #eab308;
      --purple: #a855f7;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    body { background: var(--bg); color: var(--text); min-height: 100vh; padding: 32px 20px; }
    .container { max-width: 1000px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 28px; flex-wrap: wrap; gap: 16px; border-bottom: 1px solid var(--card-border); padding-bottom: 20px; }
    .brand { display: flex; align-items: center; gap: 12px; }
    .logo-badge { width: 42px; height: 42px; border-radius: 12px; background: linear-gradient(135deg, #38bdf8, #a855f7); display: flex; align-items: center; justify-content: center; font-size: 22px; box-shadow: 0 4px 14px rgba(56, 189, 248, 0.25); }
    h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; }
    .sub { font-size: 13px; color: var(--muted); margin-top: 2px; }
    .actions { display: flex; gap: 10px; align-items: center; }
    .btn { background: #1e293b; color: var(--text); border: 1px solid #334155; padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: 6px; transition: all 0.15s ease; }
    .btn:hover { background: #334155; border-color: #475569; }
    .btn-primary { background: #0284c7; border-color: #38bdf8; }
    .btn-primary:hover { background: #0369a1; }
    .status-pill { display: inline-flex; align-items: center; gap: 6px; background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.3); color: #4ade80; padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; }
    .status-dot { width: 7px; height: 7px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 8px #4ade80; }
    
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(310px, 1fr)); gap: 20px; margin-bottom: 24px; }
    .card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 16px; padding: 24px; position: relative; transition: border-color 0.2s; }
    .card:hover { border-color: #334155; }
    .card-title { font-size: 14px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .big-num { font-size: 34px; font-weight: 800; letter-spacing: -0.03em; color: #fff; display: flex; align-items: baseline; gap: 8px; }
    .big-num .denom { font-size: 18px; font-weight: 500; color: var(--dim); }
    .pct-badge { font-size: 13px; font-weight: 600; padding: 3px 8px; border-radius: 6px; }
    .pct-green { background: rgba(34, 197, 94, 0.15); color: #4ade80; }
    
    .bar-bg { width: 100%; height: 10px; background: #1e293b; border-radius: 10px; overflow: hidden; margin: 16px 0; }
    .bar-fill { height: 100%; border-radius: 10px; transition: width 0.5s ease; background: linear-gradient(90deg, #10b981, #38bdf8); }
    
    .meta-line { display: flex; justify-content: space-between; font-size: 13px; color: var(--muted); margin-top: 8px; }
    .meta-line strong { color: var(--text); }
    
    .calc-box { margin-top: 18px; padding-top: 14px; border-top: 1px dashed var(--card-border); }
    .calc-title { font-size: 12px; color: var(--muted); margin-bottom: 8px; font-weight: 600; text-transform: uppercase; }
    .calc-row { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 6px; }
    .calc-row .lbl { display: flex; align-items: center; gap: 6px; }
    .calc-row .cnt { font-weight: 700; color: var(--accent); }
    
    .info-card { background: linear-gradient(180deg, #131b26 0%, #0f172a 100%); border: 1px solid var(--card-border); border-radius: 16px; padding: 24px; margin-bottom: 24px; }
    .model-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 14px; }
    .model-item { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 12px 14px; }
    .model-name { font-weight: 600; font-size: 14px; color: #fff; margin-bottom: 4px; display: flex; align-items: center; justify-content: space-between; }
    .model-desc { font-size: 12px; color: var(--muted); }
    .tag-sm { font-size: 10px; padding: 2px 6px; border-radius: 4px; font-weight: 600; text-transform: uppercase; }
    .tag-carbon { background: rgba(168, 85, 247, 0.2); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.4); }
    .tag-orch { background: rgba(56, 189, 248, 0.2); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.4); }
    .tag-hydro { background: rgba(34, 197, 94, 0.2); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.4); }
    
    .footer { text-align: center; font-size: 12px; color: var(--dim); margin-top: 24px; }
    .footer a { color: var(--muted); text-decoration: none; }
    .footer a:hover { color: var(--text); }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="brand">
        <div class="logo-badge">💎</div>
        <div>
          <h1>Gemini Web Bridge · Google AI Pro</h1>
          <div class="sub">v1.8 Antigravity Orchestrator Edition &bull; Локальный эндпоинт http://127.0.0.1:8010/v1</div>
        </div>
      </div>
      <div class="actions">
        <span class="status-pill"><span class="status-dot"></span> PRO ACTIVE</span>
        <button class="btn btn-primary" onclick="loadQuota(true)" id="refreshBtn">🔄 Обновить</button>
        <a class="btn" href="http://localhost:5173" target="_blank">🎛️ ProviderStudio</a>
      </div>
    </div>

    <div class="grid">
      <!-- 5-HOUR WINDOW -->
      <div class="card">
        <div class="card-title">
          <span>5-часовое скользящее окно</span>
          <span class="pct-badge pct-green" id="h5Badge">81% доступно</span>
        </div>
        <div class="big-num">
          <span id="h5Rem">1 934</span>
          <span class="denom">/ 2 400 кр.</span>
        </div>
        <div class="bar-bg">
          <div class="bar-fill" id="h5Bar" style="width: 81%;"></div>
        </div>
        <div class="meta-line">
          <span>Сброс лимита:</span>
          <strong id="h5Reset">через 3 ч 35 мин</strong>
        </div>
        <div class="meta-line">
          <span>Точное время сброса:</span>
          <strong id="h5ExactTime">17:13:48</strong>
        </div>

        <div class="calc-box">
          <div class="calc-title">Сколько запросов еще доступно:</div>
          <div class="calc-row">
            <span class="lbl">⚡ <b>Hydrogen</b> (быстрый кодинг, 1-2 кр.):</span>
            <span class="cnt" id="estHydro">~960+</span>
          </div>
          <div class="calc-row">
            <span class="lbl">🧠 <b>Orchestrator</b> (баланс Carbon+Hydrogen):</span>
            <span class="cnt" id="estOrch">~240+</span>
          </div>
          <div class="calc-row">
            <span class="lbl">🔬 <b>Carbon</b> (глубокий Thinking):</span>
            <span class="cnt" id="estCarbon">~90+</span>
          </div>
        </div>
      </div>

      <!-- WEEKLY WINDOW -->
      <div class="card">
        <div class="card-title">
          <span>Недельный пул кредитов</span>
          <span class="pct-badge pct-green" id="wBadge">99% доступно</span>
        </div>
        <div class="big-num">
          <span id="wRem">47 791</span>
          <span class="denom">/ 48 384 кр.</span>
        </div>
        <div class="bar-bg">
          <div class="bar-fill" id="wBar" style="width: 99%;"></div>
        </div>
        <div class="meta-line">
          <span>Использовано за неделю:</span>
          <strong id="wUsed">593 кр. (1.2%)</strong>
        </div>
        <div class="meta-line">
          <span>Сброс пула:</span>
          <strong id="wReset">17 ноября в 19:13</strong>
        </div>

        <div class="calc-box">
          <div class="calc-title">Как работает маршрутизация:</div>
          <div class="calc-row">
            <span class="lbl">⚡ Инструментальные ходы:</span>
            <span class="cnt" style="color:#4ade80;">Hydrogen, без Thinking</span>
          </div>
          <div class="calc-row">
            <span class="lbl">🧠 Глубокий анализ и планы:</span>
            <span class="cnt" style="color:#38bdf8;">Carbon + Thinking</span>
          </div>
          <div class="calc-row">
            <span class="lbl">📝 Заголовки и мелочи:</span>
            <span class="cnt" style="color:#c084fc;">Flash-Lite</span>
          </div>
        </div>
      </div>
    </div>

    <!-- BROWSER SESSION -->
    <div class="info-card" id="tokenCard" style="border: 1px solid rgba(59, 130, 246, 0.4); background: rgba(30, 41, 59, 0.7); margin-bottom: 24px;">
      <div class="card-title" style="display:flex; justify-content:space-between; align-items:center;">
        <span>🔑 Сессия Google</span>
        <span id="tokenStatusBadge" style="font-size:12px; color:#94a3b8;">Продлевается автоматически</span>
      </div>
      <div style="margin-top: 12px; display: flex; gap: 10px;">
        <button class="btn btn-primary" onclick="refreshBrowserSession()" id="saveTokenBtn">🔄 Забрать сессию из браузера</button>
      </div>
      <div id="tokenMsg" style="margin-top: 8px; font-size: 12px; color: #94a3b8;">
        Куки копировать не нужно. Если сессия истекла — запустите <code>login.cmd</code> и войдите в аккаунт в открывшемся окне Chrome. Дальше мост забирает и продлевает сессию сам.
      </div>
    </div>

    <!-- MODELS -->
    <div class="info-card">
      <div class="card-title">
        <span>Активные топовые модели (Google AI Pro)</span>
        <span style="font-size: 12px; color: var(--accent); text-transform:none;">Carbon · Pro · Hydrogen · Flash-Lite</span>
      </div>
      <div class="model-list">
        <div class="model-item">
          <div class="model-name">
            <span>Gemini Orchestrator</span>
            <span class="tag-sm tag-orch">Default</span>
          </div>
          <div class="model-desc">Авто-маршрутизатор: Carbon для плана/ошибок + Hydrogen для правок.</div>
        </div>
        <div class="model-item">
          <div class="model-name">
            <span>Gemini 4 Carbon</span>
            <span class="tag-sm tag-carbon">Thinking</span>
          </div>
          <div class="model-desc">Флагман со сложным Thinking. Доступен в мосту без ограничений.</div>
        </div>
        <div class="model-item">
          <div class="model-name">
            <span>Gemini Pro</span>
            <span class="tag-sm tag-carbon">Pro</span>
          </div>
          <div class="model-desc">Сложные задачи и анализ, модель уровня Pro из подписки.</div>
        </div>
        <div class="model-item">
          <div class="model-name">
            <span>Gemini 4 Hydrogen High</span>
            <span class="tag-sm tag-hydro">Thinking</span>
          </div>
          <div class="model-desc">Быстрый агентный кодинг с пошаговыми рассуждениями.</div>
        </div>
        <div class="model-item">
          <div class="model-name">
            <span>Gemini 4 Hydrogen</span>
            <span class="tag-sm tag-hydro">Speed</span>
          </div>
          <div class="model-desc">Молниеносная скорость для мелких правок и суб-вызовов тулзов.</div>
        </div>
      </div>
    </div>

    <div class="footer">
      <span>Gemini Web to OpenAI Bridge &bull; OpenAI-совместимый эндпоинт: <code>http://127.0.0.1:8010/v1</code> &bull; <a href="/v1/quota" target="_blank">JSON Quota API</a></span>
    </div>
  </div>

  <script>
    async function loadQuota(manual) {
      const btn = document.getElementById('refreshBtn');
      if (manual && btn) { btn.textContent = '⏳ Загрузка...'; btn.disabled = true; }
      try {
        const res = await fetch('/v1/quota');
        const data = await res.json();
        render(data);
      } catch (e) {
        console.error('Ошибка получения квоты:', e);
      } finally {
        if (manual && btn) { btn.textContent = '🔄 Обновить'; btn.disabled = false; }
      }
    }

    function render(d) {
      const h5 = d.window_5h || {};
      const w = d.weekly || {};
      const known5 = h5.remaining_credits !== null && h5.remaining_credits !== undefined;
      const knownW = w.remaining_credits !== null && w.remaining_credits !== undefined;

      document.getElementById('h5Rem').textContent = known5 ? h5.remaining_credits.toLocaleString() : '—';
      document.getElementById('h5Badge').textContent = known5 ? h5.remaining_percentage + '% доступно' : 'нет данных';
      document.getElementById('h5Bar').style.width = known5 ? Math.min(100, Math.max(0, h5.remaining_percentage)) + '%' : '0%';

      document.getElementById('wRem').textContent = knownW ? w.remaining_credits.toLocaleString() : '—';
      document.getElementById('wBadge').textContent = knownW ? w.remaining_percentage + '% доступно' : 'нет данных';
      document.getElementById('wBar').style.width = knownW ? Math.min(100, Math.max(0, w.remaining_percentage)) + '%' : '0%';
      document.getElementById('wUsed').textContent = knownW
        ? (w.used_credits || 0).toLocaleString() + ' кр. (' + (w.usage_percentage || 0) + '%)'
        : 'Google не отдаёт счётчики для этой сессии';

      const pill = document.querySelector('.status-pill');
      if (pill) {
        if (d.source === 'antigravity_daemon') {
          pill.innerHTML = '<span class="status-dot"></span> 🟢 ANTIGRAVITY AUTO-SYNC';
        } else if (d.ok) {
          pill.innerHTML = '<span class="status-dot"></span> PRO ACTIVE';
        } else if (d.authenticated === false && d.account_status && d.account_status !== 'UNKNOWN') {
          pill.innerHTML = '<span class="status-dot" style="background:#ef4444;"></span> ⚠️ КВОТА НЕИЗВЕСТНА (' + d.account_status + ')';
        } else {
          pill.innerHTML = '<span class="status-dot" style="background:#eab308;"></span> ⚠️ НЕТ ДАННЫХ О КВОТЕ';
        }
      }

      if (h5.reset_at) {
        const rDate = new Date(h5.reset_at);
        document.getElementById('h5ExactTime').textContent = rDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const diffMs = rDate - new Date();
        if (diffMs > 0) {
          const hours = Math.floor(diffMs / 3600000);
          const mins = Math.floor((diffMs % 3600000) / 60000);
          document.getElementById('h5Reset').textContent = 'через ' + hours + ' ч ' + mins + ' мин';
        } else {
          document.getElementById('h5Reset').textContent = 'сброс прямо сейчас';
        }
      }
      
      if (w.reset_at) {
        const wDate = new Date(w.reset_at);
        document.getElementById('wReset').textContent = wDate.toLocaleDateString([], { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
      }

      const est = h5.estimated_requests || {};
      if (est.hydrogen_fast) document.getElementById('estHydro').textContent = '~' + est.hydrogen_fast.toLocaleString() + '+';
      if (est.orchestrator_balanced) document.getElementById('estOrch').textContent = '~' + est.orchestrator_balanced.toLocaleString() + '+';
      if (est.carbon_deep_thinking) document.getElementById('estCarbon').textContent = '~' + est.carbon_deep_thinking.toLocaleString() + '+';
    }

    async function refreshBrowserSession() {
      const msg = document.getElementById('tokenMsg');
      const btn = document.getElementById('saveTokenBtn');
      btn.disabled = true;
      btn.textContent = '⏳ Читаем сессию...';
      try {
        const res = await fetch('/auth/refresh', { method: 'POST' });
        const data = await res.json();
        if (data.ok && data.degraded) {
          msg.textContent = '⚠️ Сессия гостевого уровня: Google отдаёт только flash-lite. '
            + 'Войдите в аккаунт в окне Chrome моста (login.cmd).';
          msg.style.color = '#fbbf24';
          loadQuota(true);
        } else if (data.ok) {
          msg.textContent = data.session_updated
            ? '✅ Сессия обновлена из браузера, мост переподключён.'
            : '✅ Сессия уже актуальна.';
          msg.style.color = '#4ade80';
          loadQuota(true);
        } else {
          msg.textContent = '⚠️ ' + (data.detail || 'Не удалось получить сессию');
          msg.style.color = '#fbbf24';
        }
      } catch (e) {
        msg.textContent = '❌ Ошибка сети: ' + e;
        msg.style.color = '#f87171';
      } finally {
        btn.disabled = false;
        btn.textContent = '🔄 Забрать сессию из браузера';
      }
    }

    loadQuota(false);
    setInterval(() => loadQuota(false), 30000);
  </script>
</body>
</html>
"""

QUOTA_TTL_SECONDS = 30.0
_quota_cache: Dict[str, Any] = {"at": 0.0, "body": None}
_quota_lock = asyncio.Lock()


def _empty_window(total_hint: int) -> Dict[str, Any]:
    """Unknown, not zero.

    The old fallback filled in 2400/2400 used and 0 left whenever the status
    RPC was unhappy, so a working session was reported as an exhausted plan and
    the dashboard showed "0 кредитов". Nothing here is a measurement, so the
    values are null and the caller has to say "unknown".
    """
    return {
        "total_credits": None,
        "remaining_credits": None,
        "used_credits": None,
        "usage_percentage": None,
        "remaining_percentage": None,
        "reset_at": "",
        "total_credits_hint": total_hint,
    }


def _quota_models() -> List[Dict[str, Any]]:
    return [
        {"id": "gemini-orchestrator", "name": "Gemini Orchestrator (Auto: Carbon + Hydrogen)", "default": True},
        {"id": "gemini-carbon", "name": "Gemini Carbon (Глубокие рассуждения)", "tier": "Flagship"},
        {"id": "gemini-pro", "name": "Gemini Pro (Сложные задачи)", "tier": "Flagship"},
        {"id": "gemini-4-hydrogen-high", "name": "Gemini 4 Hydrogen (Высокий Thinking)", "tier": "Fast Thinking"},
        {"id": "gemini-4-hydrogen", "name": "Gemini 4 Hydrogen (Повседневный кодинг)", "tier": "Fast"},
        {"id": "gemini-flash-lite", "name": "Gemini Flash Lite (Быстрые ответы)", "tier": "Fast"},
    ]


async def _collect_quota() -> Dict[str, Any]:
    agy_data = None
    try:
        # Blocking urllib with 3+3 s timeouts: it must not run on the event loop,
        # where it stalled every in-flight chat stream for two seconds.
        agy_data = await asyncio.to_thread(fetch_antigravity_live_quota)
    except Exception as e:
        print(f"[ANTIGRAVITY-SYNC] Quota query exception: {e}")

    if agy_data and agy_data.get("quotas"):
        quotas = agy_data["quotas"]
        user_info = agy_data.get("user", {})
        gemini_models = quotas.get("Gemini Models", {})
        h5 = gemini_models.get("5h", {})
        w = gemini_models.get("weekly", {})

        c5h_total = 2400
        c5h_rem_pct = h5.get("remaining_pct", 100.0)
        c5h_frac = h5.get("remaining_fraction", c5h_rem_pct / 100.0)
        c5h_rem = int(round(c5h_total * c5h_frac))
        c5h_used = max(0, c5h_total - c5h_rem)
        c5h_pct = round(100.0 - c5h_rem_pct, 1)

        w_total = 48384
        w_rem_pct = w.get("remaining_pct", 100.0)
        w_frac = w.get("remaining_fraction", w_rem_pct / 100.0)
        w_rem = int(round(w_total * w_frac))
        w_used = max(0, w_total - w_rem)
        w_pct = round(100.0 - w_rem_pct, 1)

        tier_name = user_info.get("tier", "Pro")
        user_email = user_info.get("email", "")
        tier = f"PRO ({user_email})" if user_email else f"PRO ({tier_name})"
        bridge_state["last_quota_source"] = "antigravity_daemon"
        bridge_state["last_quota_at"] = time.time()
        return {
            "ok": True,
            "authenticated": True,
            "tier": tier,
            "account_status": f"AVAILABLE (Antigravity Daemon : {agy_data.get('port', 'live')})",
            "source": "antigravity_daemon",
            "reason": None,
            "checked_at": int(time.time()),
            "window_5h": {
                "total_credits": c5h_total,
                "remaining_credits": c5h_rem,
                "used_credits": c5h_used,
                "usage_percentage": c5h_pct,
                "remaining_percentage": round(100.0 - c5h_pct, 1),
                "reset_at": h5.get("reset_time", ""),
                "estimated_requests": {
                    "hydrogen_fast": int(c5h_rem / 2),
                    "orchestrator_balanced": int(c5h_rem / 8),
                    "carbon_deep_thinking": int(c5h_rem / 22),
                },
            },
            "weekly": {
                "total_credits": w_total,
                "remaining_credits": w_rem,
                "used_credits": w_used,
                "usage_percentage": w_pct,
                "remaining_percentage": round(100.0 - w_pct, 1),
                "reset_at": w.get("reset_time", ""),
            },
            "models": _quota_models(),
        }

    # Fallback: ask the web session. The status RPC is not trusted here either —
    # it says UNAUTHENTICATED on cookies that generate — but usage_info only
    # carries numbers when Google actually returned them.
    status_name = "UNKNOWN"
    usage: Dict[str, Any] = {}
    reason = "web_session_unavailable"
    try:
        client = await get_gemini_client()
        status_name = getattr(getattr(client, "account_status", None), "name", "UNKNOWN")
        if hasattr(client, "_fetch_usage_info"):
            await client._fetch_usage_info()
        usage = getattr(client, "usage_info", {}) or {}
        reason = "web_session_reports_no_usage"
    except HTTPException as e:
        reason = str(e.detail)
    except Exception as e:
        reason = f"web_session_error: {e}"
        print(f"[QUOTA] Web client fallback error: {e}")

    c5h = usage.get("current_5h", {}) or {}
    weekly = usage.get("weekly", {}) or {}
    tier_info = usage.get("tier", {})
    has_numbers = c5h.get("remaining_credits") is not None

    bridge_state["last_quota_source"] = "web_client"
    bridge_state["last_quota_at"] = time.time()

    if has_numbers:
        c5h_total = 2400
        c5h_rem = int(c5h.get("remaining_credits", 0))
        c5h_used = max(0, c5h_total - c5h_rem)
        c5h_pct = c5h.get("usage_percentage", round((c5h_used / c5h_total) * 100, 1))
        w_total = 48384
        w_rem = int(weekly.get("remaining_credits", 0))
        w_used = max(0, w_total - w_rem)
        w_pct = weekly.get("usage_percentage", round((w_used / w_total) * 100, 1))
        tier_label = tier_info.get("label") if isinstance(tier_info, dict) else None
        return {
            "ok": True,
            "authenticated": True,
            "tier": tier_label or "PRO",
            "account_status": f"{status_name} (Web Session)",
            "source": "web_client",
            "reason": None,
            "checked_at": int(time.time()),
            "window_5h": {
                "total_credits": c5h_total,
                "remaining_credits": c5h_rem,
                "used_credits": c5h_used,
                "usage_percentage": c5h_pct,
                "remaining_percentage": round(100.0 - c5h_pct, 1),
                "reset_at": c5h.get("reset_at", ""),
                "estimated_requests": {
                    "hydrogen_fast": int(c5h_rem / 2),
                    "orchestrator_balanced": int(c5h_rem / 8),
                    "carbon_deep_thinking": int(c5h_rem / 22),
                },
            },
            "weekly": {
                "total_credits": w_total,
                "remaining_credits": w_rem,
                "used_credits": w_used,
                "usage_percentage": w_pct,
                "remaining_percentage": round(100.0 - w_pct, 1),
                "reset_at": weekly.get("reset_at", ""),
            },
            "models": _quota_models(),
        }

    return {
        "ok": False,
        "authenticated": False,
        "tier": None,
        "account_status": status_name,
        "source": "web_client",
        "reason": reason,
        "checked_at": int(time.time()),
        "window_5h": _empty_window(2400),
        "weekly": _empty_window(48384),
        "models": _quota_models(),
    }


@app.get("/v1/quota")
@app.get("/api/quota")
async def get_quota_info():
    """Live quota. Cached for 30 s, and honest when it has no numbers.

    The dashboard polls this every 30 s, ProviderStudio polls it on every
    diagnosis, and both used to pay a two-second Google round trip that ran on
    the event loop.
    """
    now = time.time()
    if _quota_cache["body"] is not None and now - _quota_cache["at"] < QUOTA_TTL_SECONDS:
        return _quota_cache["body"]

    async with _quota_lock:
        now = time.time()
        if _quota_cache["body"] is not None and now - _quota_cache["at"] < QUOTA_TTL_SECONDS:
            return _quota_cache["body"]
        body = await _collect_quota()
        _quota_cache["body"] = body
        _quota_cache["at"] = time.time()
        return body

@app.get("/", response_class=HTMLResponse)
@app.get("/dashboard", response_class=HTMLResponse)
async def dashboard_page():
    """Serves the interactive web dashboard for monitoring Google AI Pro quotas."""
    return HTMLResponse(content=DASHBOARD_HTML)

def generate_local_title(prompt: str) -> str:
    """Instantly generates clean, descriptive titles for OpenCode sessions without hitting Google API."""
    clean = re.sub(r"(?i)reply with only the title[^\n]*", "", prompt).strip()
    clean = re.sub(r"(?i)generate a title[^\n]*", "", clean).strip()
    clean = re.sub(r"(?i)title for this[^\n]*", "", clean).strip()
    clean = re.sub(r"(?i)here is the first message(?: from the user)?:\s*", "", clean).strip()
    user_match = re.search(r"(?i)(?:user|пользователь):\s*([^\n]+)", clean)
    if user_match:
        text = user_match.group(1).strip()
    else:
        lines = [l.strip() for l in clean.splitlines() if l.strip() and not l.strip().startswith("#")]
        text = lines[-1] if lines else "Новая сессия"
    words = text.split()[:5]
    title = " ".join(words).strip('`"\'.,;:!?')
    if len(title) > 35:
        title = title[:35].rsplit(' ', 1)[0]
    return title.capitalize() if title else "Сессия"

def is_google_glitch_text(text: str) -> bool:
    """True only when the whole reply is a Google error or canned non-answer.

    A substring search anywhere in the answer also matched ordinary prose about
    error handling ("if an error occurred, please try again"), which then got
    replaced by a canned sentence.
    """
    if not text:
        return False
    t = text.strip().lower()
    if len(t) > 200 or "```" in t:
        return False
    patterns = (
        "something went wrong",
        "encountered an error",
        "try your request again",
        "try again later",
        "could you try again",
        "please try again",
        "error occurred",
        "temporarily unavailable",
        # The web UI's refusal shell. It arrives as a normal 200 response with a
        # finish reason of "stop", so an agent read it as the model's final
        # answer and the task dead-ended on a coding request.
        "having a hard time fulfilling",
        "can i help you with something else instead",
        "i'm still learning how to respond",
        "i am still learning how to respond",
    )
    return any(p in t for p in patterns)

@app.post("/v1/chat/completions")
@app.post("/chat/completions")
async def chat_completions(req: ChatCompletionRequest, request: Request):
    cleanup_old_upload_cache()
    incoming_tools = len(req.tools or [])
    if req.tool_choice == "none":
        req.tools = None
    forced_tool = None
    tool_directive = ""
    if isinstance(req.tool_choice, dict):
        forced_tool = (req.tool_choice.get("function") or {}).get("name")
        if forced_tool:
            # Showing only the chosen tool is the strongest lever available:
            # the model cannot name a tool it was never offered.
            req.tools = [t for t in (req.tools or [])
                         if isinstance(t, dict) and (t.get("function") or {}).get("name") == forced_tool]
            tool_directive = (f"You must call the tool `{forced_tool}` in this turn. "
                              "Reply with a tool_call block and nothing else.")
    elif req.tool_choice == "required":
        tool_directive = ("You must call one of the available tools in this turn. "
                          "Reply with a tool_call block and nothing else.")
    tool_names = collect_tool_names(req.tools)
    # A turn whose last message is a tool result is mid-task: prose there means
    # the agent stalled. On a plain user turn prose is the normal final answer.
    last_role = req.messages[-1].role if req.messages else ""
    agent_turn = last_role in ("tool", "function")
    stops = normalize_stops(req.stop)
    # Parsed before any Google call: title generation is answered locally, and
    # it must keep working while the session is degraded or rate-limited.
    # Parsing decodes base64, writes uploads and may download a remote URL. On
    # the event loop that stalled every other request, /health included.
    prompt, files_to_upload = await asyncio.to_thread(
        parse_openai_messages, req.messages, req.tools, tool_directive)

    if not prompt and not files_to_upload:
        raise HTTPException(status_code=400, detail="Messages and files cannot be empty")

    completion_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
    created_time = int(time.time())
    # Defined before the title fast-path: that branch returned a completion with
    # `resp_model` and crashed with UnboundLocalError (HTTP 500) whenever the
    # client asked for a title without streaming.
    resp_model = req.model

    # Fast-path for the client's background title generation. Matched against the
    # last user turn only: searching the whole prompt hijacked real coding tasks
    # like "write a function to generate a title for each blog post".
    last_user = next((m for m in reversed(req.messages) if m.role == "user"), None)
    last_user_text = str(last_user.content or "").lower() if last_user else ""
    is_title_request = (req.model == "gemini-local-title" and not req.tools
                        and "reply with only the title" in last_user_text)

    if is_title_request:
        title = generate_local_title(prompt)
        print(f"[FAST-PATH] Мгновенная локальная генерация заголовка (0ms): '{title}'")
        if req.stream:
            async def title_stream():
                yield f"data: {json.dumps({'id': completion_id, 'object': 'chat.completion.chunk', 'created': created_time, 'model': req.model, 'choices': [{'index': 0, 'delta': {'content': title}, 'finish_reason': None}]})}\n\n"
                yield f"data: {json.dumps({'id': completion_id, 'object': 'chat.completion.chunk', 'created': created_time, 'model': req.model, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]})}\n\n"
                yield "data: [DONE]\n\n"
            return StreamingResponse(title_stream(), media_type="text/event-stream")
        else:
            return {
                "id": completion_id,
                "object": "chat.completion",
                "created": created_time,
                "model": resp_model,
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": title},
                    "finish_reason": "stop"
                }],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
            }

    resp_model = req.model
    # The client is fetched only after the local fast-paths: a background title
    # request used to fail with the whole session's error for no reason.
    client = await get_gemini_client()

    effort = (req.reasoning_effort or "").lower().strip()
    routed_model, routed_thinking = orchestrator_route(req.messages, req.tools, effort, prompt)
    try:
        selection = select_model(client.list_models() or [], req.model, routed_model, routed_thinking)
    except ModelSelectionError as exc:
        raise HTTPException(status_code=503, detail={"code": exc.code, "message": str(exc)}) from exc
    gemini_model_param = selection.model
    extended_thinking = selection.thinking
    def check_replacement_model(replacement):
        # Retry only the same concrete model, never re-route mid-response.
        nonlocal gemini_model_param, resp_model
        gemini_model_param = resolve_available_model(replacement, gemini_model_param)
        resp_model = gemini_model_param

    model_fallback = False
    resp_model = gemini_model_param
    print(f"[ROUTE] {req.model} -> {gemini_model_param}, thinking={extended_thinking}, "
          f"tools={incoming_tools}, choice={req.tool_choice}, agent_turn={agent_turn}, "
          f"prompt_chars={len(prompt)}")

    # Upload files / images / videos / audios with retry
    file_data = None
    if files_to_upload:
        for upload_attempt in range(2):
            try:
                print(f"[INFO] Синхронизация сессии и передача {len(files_to_upload)} медиафайлов в Google Gemini: {[f.name for f in files_to_upload]}")
                await client._sync_activity()
                uploaded_urls = await asyncio.gather(
                    *(
                        upload_file(
                            f,
                            client=client._live_client,
                            push_id=client.push_id,
                            filename=f.name,
                            verbose=client.verbose,
                        )
                        for f in files_to_upload
                    )
                )
                file_data = [
                    [[url], f.name]
                    for url, f in zip(uploaded_urls, files_to_upload, strict=True)
                ]
                print(f"[SUCCESS] Файлы успешно переданы в Google Gemini: {[f.name for f in files_to_upload]}")
                break
            except Exception as upload_err:
                if upload_attempt == 0 and is_auth_or_session_error(upload_err):
                    print(f"[WARN] Ошибка загрузки файлов ({upload_err}), переподключаемся...")
                    client = await get_gemini_client(force_refresh=True)
                    check_replacement_model(client)
                    continue
                print(f"[ERROR] Ошибка загрузки файлов: {upload_err}")
                raise HTTPException(status_code=500, detail=f"Не удалось загрузить медиафайл в Gemini: {upload_err}")

    completion_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
    created_time = int(time.time())

    # STREAMING (SSE)
    if req.stream:
        async def event_generator():
            nonlocal client, prompt
            nudges = 0

            for attempt in range(4):
                try:
                    print(f"[STREAM] Старт _generate: model={gemini_model_param}, thinking={extended_thinking}")
                    session_state = {"last_texts": {}, "last_thoughts": {}}
                    last_sent_text = ""
                    last_sent_thought = ""
                    collected_full_text = ""
                    finish_override = None

                    chunk_count = 0
                    async for chunk in generate_once(client,
                        prompt=prompt or "Please analyze the attached inputs.",
                        req_file_data=file_data,
                        model=gemini_model_param,
                        temporary=True,
                        extended_thinking=extended_thinking,
                        session_state=session_state,
                    ):
                        chunk_count += 1
                        if await request.is_disconnected():
                            print("[STREAM] Клиент отключился — прерываем генерацию Google.")
                            return
                        if chunk_count % 5 == 1:
                            print(f"[STREAM] Chunk #{chunk_count} принят от Google (len={len(getattr(chunk, 'text', '') or '')})")
                        # 1. Reasoning (thoughts) delta
                        if hasattr(chunk, "thoughts") and chunk.thoughts:
                            current_thought = chunk.thoughts
                            if len(current_thought) > len(last_sent_thought):
                                delta_thought = current_thought[len(last_sent_thought):]
                                last_sent_thought = current_thought
                                event_data = {
                                    "id": completion_id,
                                    "object": "chat.completion.chunk",
                                    "created": created_time,
                                    "model": resp_model,
                                    "choices": [
                                        {
                                            "index": 0,
                                            "delta": {
                                                "reasoning_content": delta_thought,
                                                "reasoning": delta_thought,
                                            },
                                            "finish_reason": None,
                                        }
                                    ],
                                }
                                yield f"data: {json.dumps(event_data, ensure_ascii=False)}\n\n"

                        # 2. Text content delta (real-time for chat, buffered & intercepted for tool agent turns)
                        if hasattr(chunk, "text") and chunk.text:
                            current_text = chunk.text
                            collected_full_text = current_text

                            safe = safe_stream_prefix(current_text, tool_names)
                            cap, cap_reason = output_limits(current_text, stops, req.max_tokens)
                            safe = min(safe, cap)
                            if nudges:
                                # Continuation attempt: the original answer was already
                                # streamed, so only a tool call may be added here.
                                safe = len(last_sent_text)
                            if safe > len(last_sent_text):
                                delta_text = current_text[len(last_sent_text):safe]
                                last_sent_text = current_text[:safe]
                                event_data = {
                                    "id": completion_id,
                                    "object": "chat.completion.chunk",
                                    "created": created_time,
                                    "model": resp_model,
                                    "choices": [{"index": 0, "delta": {"content": delta_text}, "finish_reason": None}],
                                }
                                yield f"data: {json.dumps(event_data, ensure_ascii=False)}\n\n"
                            if cap_reason:
                                # stop / max_tokens reached: end upstream generation too,
                                # so the rest of the answer is not paid for.
                                finish_override = cap_reason
                                collected_full_text = current_text[:safe]
                                break

                    if finish_override:
                        final_event = {
                            "id": completion_id,
                            "object": "chat.completion.chunk",
                            "created": created_time,
                            "model": resp_model,
                            "choices": [{"index": 0, "delta": {}, "finish_reason": finish_override}],
                            "usage": {
                                "prompt_tokens": estimate_tokens(prompt),
                                "completion_tokens": estimate_tokens(collected_full_text),
                                "total_tokens": estimate_tokens(prompt) + estimate_tokens(collected_full_text),
                            },
                        }
                        yield f"data: {json.dumps(final_event)}\n\n"
                        yield "data: [DONE]\n\n"
                        return

                    # Automatic recovery if Google returned a transient web glitch text
                    if is_google_glitch_text(collected_full_text):
                        if attempt == 0 and not last_sent_text and not last_sent_thought:
                            print(f"[RETRY] Временный сбой Google Web: '{collected_full_text.strip()}'. Повторный вызов...")
                            await asyncio.sleep(0.3)
                            continue
                        else:
                            err = {"error": {"message": "Gemini Web вернул страницу ошибки вместо ответа. Повторите запрос.",
                                             "type": "gemini_upstream_error"}}
                            yield f"data: {json.dumps(err, ensure_ascii=False)}\n\n"
                            yield "data: [DONE]\n\n"
                            return

                    # 3. Handle Tool Calls & Text at stream completion
                    tool_calls = extract_tool_calls(collected_full_text, tool_names)

                    problems = tool_call_problems(tool_calls, req.tools) if tool_calls else []
                    if problems and attempt == 0 and not last_sent_text:
                        # Only retry while nothing has been shown, otherwise the
                        # client would receive the prose twice.
                        print(f"[TOOL_FIX] Битый вызов в стриме, повтор: {problems}")
                        prompt, _ = await asyncio.to_thread(
                            parse_openai_messages, req.messages, req.tools,
                            tool_directive + " Your last tool call was invalid: " + "; ".join(problems)
                            + ". Emit the corrected tool_call block with every required argument.")
                        continue

                    if (not tool_calls and not finish_override and tool_names
                            and nudges < nudge_budget(collected_full_text, agent_turn)):
                        nudges += 1
                        print("[CONTINUE] Модель остановилась посреди задачи — попытка продолжить "
                              f"({nudges}/{CONTINUE_NUDGES}, стрим).")
                        prompt, _ = await asyncio.to_thread(
                            parse_openai_messages, req.messages, req.tools,
                            tool_directive + " " + CONTINUE_NUDGE)
                        continue

                    if tool_calls:
                        # Emit delta.tool_calls chunk required by @ai-sdk/openai-compatible (ZERO refusal text emitted!)
                        tool_delta_event = {
                            "id": completion_id,
                            "object": "chat.completion.chunk",
                            "created": created_time,
                            "model": resp_model,
                            "choices": [
                                {
                                    "index": 0,
                                    "delta": {
                                        "tool_calls": [
                                            {
                                                "index": idx,
                                                "id": tc["id"],
                                                "type": "function",
                                                "function": {
                                                    "name": tc["function"]["name"],
                                                    "arguments": tc["function"]["arguments"],
                                                },
                                            }
                                            for idx, tc in enumerate(tool_calls)
                                        ]
                                    },
                                    "finish_reason": None,
                                }
                            ],
                        }
                        yield f"data: {json.dumps(tool_delta_event, ensure_ascii=False)}\n\n"
                        finish_reason = "tool_calls"
                    else:
                        if forced_tool or req.tool_choice == "required":
                            err = {"error": {"message": "Модель не сделала обязательный вызов инструмента (tool_choice). "
                                                        "Веб-сессия Gemini не умеет принуждать к вызову — повторите запрос.",
                                             "type": "gemini_tool_choice_error"}}
                            yield f"data: {json.dumps(err, ensure_ascii=False)}\n\n"
                            yield "data: [DONE]\n\n"
                            return
                        # Pure text assistant response (or clean final answer)
                        clean_text = strip_tool_call_blocks(collected_full_text, tool_names)

                        # Both modes stream incrementally now, so only the tail is
                        # left. The prefix check keeps a stripped block from making
                        # us resend text the client already has.
                        # A nudged attempt may only add a tool call: its prose is
                        # a second answer, and the client already has the first.
                        if (not nudges and clean_text.startswith(last_sent_text)
                                and len(clean_text) > len(last_sent_text)):
                            rem_text = clean_text[len(last_sent_text):]
                            yield f"data: {json.dumps({'id': completion_id, 'object': 'chat.completion.chunk', 'created': created_time, 'model': resp_model, 'choices': [{'index': 0, 'delta': {'content': rem_text}, 'finish_reason': None}]}, ensure_ascii=False)}\n\n"
                        finish_reason = "stop"

                    print(f"[STREAM] Завершено. Чанков: {chunk_count}, tool_calls: {len(tool_calls) if tool_calls else 0}, finish_reason: {finish_reason}")

                    # 4. Final stop chunk
                    final_event = {
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "created": created_time,
                        "model": resp_model,
                        "choices": [
                            {
                                "index": 0,
                                "delta": {},
                                "finish_reason": finish_reason,
                            }
                        ],
                        "usage": {
                            "prompt_tokens": estimate_tokens(prompt),
                            "completion_tokens": estimate_tokens(collected_full_text),
                            "total_tokens": estimate_tokens(prompt) + estimate_tokens(collected_full_text),
                        },
                    }
                    yield f"data: {json.dumps(final_event)}\n\n"
                    yield "data: [DONE]\n\n"
                    return

                except Exception as stream_err:
                    if last_sent_text or last_sent_thought:
                        # Never restart generation after any visible output.
                        bridge_state["last_error"] = type(stream_err).__name__
                        err_payload = {"error": {"message": "Поток прерван после частичного ответа. Автоматический повтор не выполнен.",
                                                 "type": "gemini_partial_stream_error"}}
                        yield f"data: {json.dumps(err_payload, ensure_ascii=False)}\n\n"
                        yield "data: [DONE]\n\n"
                        return
                    if is_rate_limited(stream_err):
                        # Log the real Google message: the generic 429 detail in
                        # the client response is not enough to tell a short
                        # per-session limit from an IP-level block.
                        bridge_state["last_error"] = f"429: {stream_err}"
                        print(f"[429] Google ограничил стрим: {stream_err}")
                        # A 429 during generation is exit-IP specific; move the
                        # bridge to another node so the next request recovers.
                        schedule_vpn_recovery("stream-429")
                        err_payload = {
                            "error": {
                                "message": "Google ограничил сессию (429). Подождите несколько минут.",
                                "type": "gemini_rate_limited",
                            }
                        }
                        yield f"data: {json.dumps(err_payload)}\n\n"
                        yield "data: [DONE]\n\n"
                        return
                    if attempt == 0 and is_auth_or_session_error(stream_err):
                        print(f"[WARN] Сбой сессии во время стрима ({stream_err}). Автоматическое восстановление сессии Google...")
                        try:
                            client = await get_gemini_client(force_refresh=True)
                            check_replacement_model(client)
                            continue
                        except Exception as refresh_err:
                            print(f"[ERROR] Не удалось восстановить сессию: {refresh_err}")
                    elif attempt == 0 and is_transient_network_error(stream_err):
                        # A dropped socket is not a dead session. Re-authing here
                        # spent a new Google bootstrap token on every hiccup.
                        print(f"[WARN] Сетевой сбой во время стрима ({stream_err}). Повтор без переавторизации.")
                        await asyncio.sleep(1)
                        continue

                    bridge_state["last_error"] = str(stream_err)

                    err_payload = {
                        "error": {
                            "message": str(stream_err),
                            "type": "gemini_stream_error",
                        }
                    }
                    yield f"data: {json.dumps(err_payload)}\n\n"
                    yield "data: [DONE]\n\n"
                    return

        async def _counted_stream(inner):
            bridge_state["inflight"] += 1
            try:
                async for piece in inner:
                    yield piece
            finally:
                bridge_state["inflight"] = max(0, bridge_state["inflight"] - 1)

        return StreamingResponse(
            _counted_stream(event_generator()),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # NON-STREAMING (with automatic retry on session dropout)
    nudges = 0
    first_reply = None
    first_thoughts = None
    for attempt in range(4):
        try:
            session_state = {"last_texts": {}, "last_thoughts": {}}

            async def collect_reply():
                last = None
                async for ch in generate_once(client,
                    prompt=prompt or "Please analyze the attached inputs.",
                    req_file_data=file_data,
                    model=gemini_model_param,
                    temporary=True,
                    extended_thinking=extended_thinking,
                    session_state=session_state,
                ):
                    last = ch
                    text_so_far = getattr(ch, "text", "") or ""
                    _, why = output_limits(text_so_far, stops, req.max_tokens)
                    if why:
                        break
                return last

            bridge_state["inflight"] += 1
            try:
                gen_task = asyncio.create_task(collect_reply())
                while not gen_task.done():
                    if await request.is_disconnected():
                        gen_task.cancel()
                        print("[REQUEST] Клиент отключился — генерация Google отменена.")
                        return
                    await asyncio.sleep(0.4)
                last_chunk = gen_task.result()
            finally:
                bridge_state["inflight"] = max(0, bridge_state["inflight"] - 1)

            reply_content = getattr(last_chunk, "text", "") or ""
            reply_thoughts = getattr(last_chunk, "thoughts", None)

            cap, cap_reason = output_limits(reply_content, stops, req.max_tokens, complete=True)
            reply_content = reply_content[:cap]

            if is_google_glitch_text(reply_content):
                if attempt == 0:
                    print(f"[RETRY] Временный сбой Google Web (non-stream): '{reply_content.strip()}'. Повтор...")
                    await asyncio.sleep(0.3)
                    continue
                else:
                    raise RuntimeError("Gemini Web вернул страницу ошибки вместо ответа. Повторите запрос.")

            # A cut answer may end mid-call, so do not parse calls out of it.
            tool_calls = None if cap_reason else extract_tool_calls(reply_content, tool_names)

            if not tool_calls and not cap_reason and reply_content and nudges == 0:
                # Remembered so a failed continuation cannot replace a perfectly
                # good answer: the retry exists to rescue a stalled agent, not to
                # throw away the first reply.
                first_reply = reply_content
                first_thoughts = reply_thoughts

            if (not tool_calls and not cap_reason and tool_names
                    and nudges < nudge_budget(reply_content, agent_turn)):
                # The recurring failure of a text protocol: the model diagnoses the
                # bug and hands back a plan instead of editing.
                nudges += 1
                print(f"[CONTINUE] Модель остановилась посреди задачи — попытка продолжить "
                      f"({nudges}/{CONTINUE_NUDGES}, non-stream).")
                prompt, _ = await asyncio.to_thread(
                    parse_openai_messages, req.messages, req.tools, tool_directive + " " + CONTINUE_NUDGE)
                continue

            if not tool_calls and not cap_reason and nudges and first_reply:
                # The continuation produced no call either: return what the model
                # actually answered first instead of the follow-up refusal.
                print("[CONTINUE] Повтор не дал вызова инструмента — возвращаем исходный ответ.")
                reply_content = first_reply
                reply_thoughts = first_thoughts

            problems = tool_call_problems(tool_calls, req.tools) if tool_calls else []
            if problems and attempt == 0:
                print(f"[TOOL_FIX] Битый вызов, просим исправить: {problems}")
                prompt, _ = await asyncio.to_thread(
                    parse_openai_messages, req.messages, req.tools,
                    tool_directive + " Your last tool call was invalid: " + "; ".join(problems)
                    + ". Emit the corrected tool_call block with every required argument.")
                continue

            if not tool_calls and not cap_reason and (forced_tool or req.tool_choice == "required"):
                if attempt == 0:
                    print("[TOOL_CHOICE] Обязательный вызов не состоялся — повтор с усиленной директивой.")
                    prompt, _ = await asyncio.to_thread(
                        parse_openai_messages, req.messages, req.tools,
                        tool_directive + " Your previous reply was plain text, which is not allowed here. "
                                         "Output only a tool_call block now.")
                    continue
                raise HTTPException(
                    status_code=502,
                    detail="Модель не сделала обязательный вызов инструмента (tool_choice). "
                           "Веб-сессия Gemini не умеет принуждать к вызову — повторите запрос.",
                )

            finish_reason = cap_reason or ("tool_calls" if tool_calls else "stop")
            clean_content = strip_tool_call_blocks(reply_content, tool_names) if tool_calls else reply_content

            msg_body: Dict[str, Any] = {
                "role": "assistant",
                "content": clean_content or None,
            }
            if reply_thoughts:
                msg_body["reasoning_content"] = reply_thoughts
            if tool_calls:
                msg_body["tool_calls"] = tool_calls

            return {
                "id": completion_id,
                "object": "chat.completion",
                "created": created_time,
                "model": resp_model,
                "choices": [
                    {
                        "index": 0,
                        "message": msg_body,
                        "finish_reason": finish_reason,
                    }
                ],
                "usage": {
                    "prompt_tokens": estimate_tokens(prompt),
                    "completion_tokens": estimate_tokens(reply_content),
                    "total_tokens": estimate_tokens(prompt) + estimate_tokens(reply_content),
                },
                "bridge": {
                    "requested_model": req.model,
                    "actual_model": gemini_model_param,
                    "fallback": model_fallback,
                    "thinking": extended_thinking,
                },
            }
        except HTTPException:
            raise
        except Exception as e:
            if is_rate_limited(e):
                bridge_state["last_error"] = f"429: {e}"
                print(f"[429] Google ограничил генерацию: {e}")
                schedule_vpn_recovery("generate-429")
                raise HTTPException(status_code=429,
                                    detail="Google ограничил сессию (429). Подождите несколько минут.")
            if attempt == 0 and is_auth_or_session_error(e):
                print(f"[WARN] Сбой сессии ({e}). Выполняем авто-восстановление сессии...")
                try:
                    client = await get_gemini_client(force_refresh=True)
                    check_replacement_model(client)
                    continue
                except Exception:
                    pass
            elif attempt == 0 and is_transient_network_error(e):
                print(f"[WARN] Сетевой сбой ({e}). Повтор без переавторизации.")
                await asyncio.sleep(1)
                continue
            bridge_state["last_error"] = str(e)
            err_msg = str(e)
            if "auth" in err_msg.lower() or "token" in err_msg.lower() or "401" in err_msg or "cookie" in err_msg.lower():
                err_msg = "Сессия Google недействительна. Запустите login.cmd и войдите в аккаунт в окне Chrome моста."
            raise HTTPException(status_code=500, detail=f"Ошибка генерации ответа Gemini: {err_msg}")

class ResponsesRequest(BaseModel):
    model: str
    input: Union[str, List[Any]] = []
    instructions: Optional[str] = None
    tools: Optional[List[Any]] = None
    tool_choice: Optional[Any] = None
    stream: Optional[bool] = False
    max_output_tokens: Optional[int] = None
    temperature: Optional[float] = None
    stop: Optional[Union[str, List[str]]] = None


def responses_to_chat(req: "ResponsesRequest") -> ChatCompletionRequest:
    """Translates the Responses API shape into the internal chat shape."""
    messages: List[ChatMessage] = []
    if req.instructions:
        messages.append(ChatMessage(role="system", content=req.instructions))

    items = [{"role": "user", "content": req.input}] if isinstance(req.input, str) else list(req.input)
    for item in items:
        if not isinstance(item, dict):
            messages.append(ChatMessage(role="user", content=str(item)))
            continue
        kind = item.get("type")
        if kind == "function_call":
            messages.append(ChatMessage(role="assistant", content=None, tool_calls=[{
                "id": item.get("call_id") or item.get("id") or f"call_{uuid.uuid4().hex[:8]}",
                "type": "function",
                "function": {"name": item.get("name", ""), "arguments": item.get("arguments", "{}")},
            }]))
        elif kind == "function_call_output":
            messages.append(ChatMessage(role="tool", tool_call_id=item.get("call_id", ""),
                                        content=str(item.get("output", ""))))
        else:
            role = item.get("role", "user")
            if role == "developer":
                role = "system"
            content = item.get("content", "")
            if isinstance(content, list):
                parts = []
                for c in content:
                    if isinstance(c, dict):
                        parts.append(c.get("text") or c.get("content") or "")
                    else:
                        parts.append(str(c))
                content = "\n".join(p for p in parts if p)
            messages.append(ChatMessage(role=role, content=content))

    tools = None
    if req.tools:
        tools = []
        for t in req.tools:
            if not isinstance(t, dict):
                continue
            if t.get("type") == "function" and "function" not in t:
                tools.append({"type": "function", "function": {
                    "name": t.get("name", ""), "description": t.get("description", ""),
                    "parameters": t.get("parameters", {"type": "object", "properties": {}})}})
            else:
                tools.append(t)

    return ChatCompletionRequest(
        model=req.model, messages=messages, stream=bool(req.stream), tools=tools,
        tool_choice=req.tool_choice, max_tokens=req.max_output_tokens,
        temperature=req.temperature, stop=req.stop,
    )


def chat_result_to_response(result: Dict[str, Any], model: str) -> Dict[str, Any]:
    """Builds a Responses API object from a chat completion."""
    choice = (result.get("choices") or [{}])[0]
    msg = choice.get("message") or {}
    output: List[Dict[str, Any]] = []
    if msg.get("content"):
        output.append({
            "type": "message", "id": f"msg_{uuid.uuid4().hex[:12]}", "role": "assistant",
            "status": "completed",
            "content": [{"type": "output_text", "text": msg["content"], "annotations": []}],
        })
    for tc in msg.get("tool_calls") or []:
        fn = tc.get("function") or {}
        output.append({
            "type": "function_call", "id": f"fc_{uuid.uuid4().hex[:12]}",
            "call_id": tc.get("id", ""), "name": fn.get("name", ""),
            "arguments": fn.get("arguments", "{}"), "status": "completed",
        })
    usage = result.get("usage") or {}
    return {
        "id": f"resp_{uuid.uuid4().hex[:16]}", "object": "response",
        "created_at": result.get("created", int(time.time())), "status": "completed",
        "model": result.get("model", model), "output": output, "error": None,
        "usage": {"input_tokens": usage.get("prompt_tokens", 0),
                  "output_tokens": usage.get("completion_tokens", 0),
                  "total_tokens": usage.get("total_tokens", 0)},
    }


@app.post("/v1/responses")
async def responses_endpoint(req: ResponsesRequest, request: Request):
    chat_req = responses_to_chat(req)
    result = await chat_completions(chat_req, request)

    if not req.stream:
        return chat_result_to_response(result, req.model)

    async def as_responses_events():
        resp_id = f"resp_{uuid.uuid4().hex[:16]}"
        created = int(time.time())
        text_parts: List[str] = []
        calls: List[Dict[str, Any]] = []
        usage: Dict[str, Any] = {}
        seq = 0
        actual_model = req.model
        base = {"id": resp_id, "object": "response", "created_at": created,
                "status": "in_progress", "model": req.model, "output": [], "error": None}

        def emit(kind: str, payload: Dict[str, Any]) -> str:
            nonlocal seq
            seq += 1
            body = {"type": kind, "sequence_number": seq, **payload}
            return f"event: {kind}\ndata: {json.dumps(body, ensure_ascii=False)}\n\n"

        yield emit("response.created", {"response": base})

        async for raw in result.body_iterator:
            line = raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)
            line = line.strip()
            if not line.startswith("data: "):
                continue
            payload = line[6:]
            if payload == "[DONE]":
                break
            try:
                d = json.loads(payload)
            except Exception:
                continue
            if d.get("error"):
                yield emit("response.failed", {"response": {**base, "model": actual_model,
                                                              "status": "failed", "error": d["error"]}})
                return
            if d.get("model"):
                # The chat stream carries the model that actually answered, which
                # may differ from the requested one after a fallback.
                actual_model = d["model"]
            if d.get("usage"):
                usage = d["usage"]
            for ch in d.get("choices", []):
                delta = ch.get("delta") or {}
                if delta.get("content"):
                    text_parts.append(delta["content"])
                    yield emit("response.output_text.delta",
                               {"item_id": "msg_0", "output_index": 0, "content_index": 0,
                                "delta": delta["content"]})
                for tc in delta.get("tool_calls") or []:
                    calls.append(tc)

        output: List[Dict[str, Any]] = []
        full_text = "".join(text_parts)
        if full_text:
            yield emit("response.output_text.done",
                       {"item_id": "msg_0", "output_index": 0, "content_index": 0, "text": full_text})
            output.append({"type": "message", "id": "msg_0", "role": "assistant", "status": "completed",
                           "content": [{"type": "output_text", "text": full_text, "annotations": []}]})
        for tc in calls:
            fn = tc.get("function") or {}
            output.append({"type": "function_call", "id": f"fc_{uuid.uuid4().hex[:12]}",
                           "call_id": tc.get("id", ""), "name": fn.get("name", ""),
                           "arguments": fn.get("arguments", "{}"), "status": "completed"})
        final = {**base, "model": actual_model, "status": "completed", "output": output,
                 "usage": {"input_tokens": usage.get("prompt_tokens", 0),
                           "output_tokens": usage.get("completion_tokens", 0),
                           "total_tokens": usage.get("total_tokens", 0)}}
        yield emit("response.completed", {"response": final})

    return StreamingResponse(as_responses_events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

if __name__ == "__main__":
    import logging
    import uvicorn

    # uvicorn reports tracebacks through logging, which went to a console nobody
    # sees under start-hidden.vbs. Same file as the prints, same rotation.
    _file_handler = logging.FileHandler(LOG_PATH, encoding="utf-8")
    _file_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logging.getLogger().addHandler(_file_handler)
    logging.getLogger().setLevel(logging.INFO)

    print(f"Запуск Gemini Web Bridge на http://{HOST}:{PORT} ...")
    uvicorn.run("server:app", host=HOST, port=PORT, reload=False)
