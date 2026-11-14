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
from pathlib import Path
from typing import List, Optional, Dict, Any, Union
from contextlib import asynccontextmanager

from antigravity_sync import fetch_antigravity_live_quota
from browser_session import harvest_cookies, browser_debug_alive
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
                    os.environ.setdefault(k, v)

def update_env_file(psid: Optional[str] = None, psidts: Optional[str] = None):
    """Updates .env on disk with the freshest tokens without touching other variables."""
    env_path = Path(__file__).parent / ".env"
    if not env_path.exists():
        return
    try:
        lines = env_path.read_text(encoding="utf-8").splitlines()
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
        env_path.write_text("\n".join(new_lines) + "\n", encoding="utf-8")
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

client_instance: Optional[GeminiClient] = None
client_lock = asyncio.Lock()

async def refresh_cookies_from_browser() -> bool:
    """Pulls the Google session cookies from the bridge-owned Chrome and stores them.

    Returns True when a new __Secure-1PSID was obtained.
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
    print("[CDP] Получена свежая сессия Google из браузера моста.")
    await asyncio.to_thread(update_env_file, psid, psidts)
    return True

async def get_gemini_client(force_refresh: bool = False) -> GeminiClient:
    global client_instance
    async with client_lock:
        if not force_refresh and client_instance is not None and client_instance._running:
            return client_instance

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
            try:
                await client_instance.close()
            except Exception:
                pass
            client_instance = None

        # Attempt initialization with retry
        for attempt in range(3):
            try:
                print(f"[INFO] Авторизация GeminiClient в сессии Google (попытка {attempt+1}/3)...")
                new_client = GeminiClient(secure_1psid=psid, secure_1psidts=psidts, proxy=GEMINI_PROXY)
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
                print("[SUCCESS] GeminiClient успешно авторизован в gemini.google.com!")
                client_instance = new_client
                return client_instance
            except Exception as e:
                if is_rate_limited(e):
                    # Retrying a 429 immediately is what keeps the session limited.
                    raise HTTPException(
                        status_code=429,
                        detail="Google ограничил сессию (429). Подождите несколько минут и не перезапускайте "
                               "мост подряд: каждый старт заново запрашивает токен доступа.",
                    )
                print(f"[WARN] Сбой авторизации (попытка {attempt+1}/3): {e}")
                if attempt < 2:
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
    """Checks whether an exception is related to session expiration, network drop, or auth token rotation."""
    msg = str(err).lower()
    patterns = [
        "auth", "session", "cookie", "token", "unauthorized",
        "401", "302", "redirect", "login", "forbidden", "403",
        "bad gateway", "not available", "connection reset", "broken pipe",
        "timeout", "eof occurred", "remotedisconnected", "closed"
    ]
    return any(p in msg for p in patterns)

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
                    before = {m.model_name for m in (client_instance.list_models() or [])}
                    if len(before) < 3:
                        await client_instance._fetch_user_status()
                        after = {m.model_name for m in (client_instance.list_models() or [])}
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
                            print("[ROTATE] 1PSIDTS обновлён и сохранён.")
                        else:
                            print("[ROTATE] Google не вернул новый 1PSIDTS — повторим через интервал.")
                    except Exception as rot_err:
                        print(f"[ROTATE] Не удалось обновить 1PSIDTS: {rot_err}")
        except Exception as e:
            print(f"[WARN] Цикл обновления сессии: {e}")

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
    try:
        await warmup()
    except Exception as e:
        print(f"[WARN] Ошибка прогрева при старте: {e}")
    asyncio.create_task(cookie_persistence_loop())
    yield
    # Shutdown
    global client_instance
    if client_instance:
        try:
            await client_instance.close()
        except Exception:
            pass

app = FastAPI(
    title="Gemini Web Bridge (Google AI Pro - Antigravity Orchestrator Edition)",
    version="1.8.0",
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
    """Falls back to a model the account actually lists right now.

    Google sometimes returns a partial registry (only flash-lite) while the
    session still generates. Hard-failing on "Unknown model name" turned that
    into an outage, so pick the closest available model instead and say so.
    """
    try:
        available = [m.model_name for m in (client.list_models() or [])]
    except Exception:
        return wanted
    if not available or wanted in available:
        return wanted
    for cand in ("gemini-4-hydrogen", "gemini-pro", "gemini-carbon", "gemini-flash-lite"):
        if cand in available:
            print(f"[FALLBACK] Модели {wanted} нет в списке аккаунта {available}. Берём {cand}.")
            return cand
    print(f"[FALLBACK] Модели {wanted} нет в списке аккаунта {available}. Берём {available[0]}.")
    return available[0]

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
        "You have full access to execute workspace tools to read, create, and edit files, and to interact with MCP servers (such as Godot Engine).\n\n"
        "Guidelines:\n"
        "1. Direct File Changes: Always invoke `edit` or `write` (or `execute`) to apply changes, fixes, and refactoring directly to disk. Do not ask the user to manually copy-paste code.\n"
        "2. Proactive Inspection: When asked to inspect scenes, check errors, or verify code, immediately invoke the appropriate inspection tools.\n"
        "3. Complete Code: Deliver clean, production-ready code with no incomplete placeholders."
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

        has_execute = "execute" in tool_names
        has_edit = "edit" in tool_names
        has_write = "write" in tool_names
        has_direct_godot = any("editor_state" in n or "screenshot" in n or "godot" in n for n in tool_names)

        instruction_lines = [
            "Available tools:",
            json.dumps(tools, separators=(',', ':'), ensure_ascii=False),
            "\nTo call a tool, output:",
            "```tool_call",
            '{"name": "<tool_name>", "arguments": { ... }}',
            "```\n",
            "The tools listed above ARE available right now. They are executed by the client on your behalf: "
            "you emit a tool_call block, the client runs it and returns the next turn as 'Tool Result (<name>): ...'. "
            "Never claim you lack tools or filesystem access, and never ask the user to run a tool for you.",
            "Read the Tool Result and continue the task. Do not ask the user for information a tool already returned, "
            "and do not re-call a tool with identical arguments just to see its output again.",
            "When the task is finished, reply in plain text with no tool_call block.\n",
        ]

        examples = ["Examples:"]
        if has_execute:
            examples.append(
                'User: опиши как выглядит сцена через редактор godot\n'
                'Assistant: ```tool_call\n'
                '{"name": "execute", "arguments": {"code": "const state = await tools[\'godot-ai\'].editor_state({}); const shot = await tools[\'godot-ai\'].editor_screenshot({ source: \'editor\' }); return { state, shot };"}}\n'
                '```\n'
            )
            if has_edit:
                examples.append(
                    'User: Исправь ошибки в project.godot\n'
                    'Assistant: ```tool_call\n'
                    '{"name": "edit", "arguments": {"path": "project.godot", "edits": [{"oldText": "anti_aliasing/quality/use_taa=false", "newText": "anti_aliasing/quality/use_taa=true"}]}}\n'
                    '```\n'
                )
            elif has_write:
                examples.append(
                    'User: Исправь ошибки в project.godot\n'
                    'Assistant: ```tool_call\n'
                    '{"name": "write", "arguments": {"path": "project.godot", "content": "[application]\\n..."}}\n'
                    '```\n'
                )
        elif has_direct_godot:
            ex_editor = next((n for n in tool_names if "editor_state" in n or "state" in n), "editor_state")
            ex_shot = next((n for n in tool_names if "editor_screenshot" in n or "screenshot" in n), "editor_screenshot")
            examples.append(
                f'User: опиши как выглядит сцена через редактор godot\n'
                f'Assistant: ```tool_call\n{{"name": "{ex_editor}", "arguments": {{}}}}\n```\n'
                f'```tool_call\n{{"name": "{ex_shot}", "arguments": {{"source": "editor"}}}}\n```\n'
            )
            if has_edit:
                examples.append(
                    'User: Исправь ошибки в project.godot\n'
                    'Assistant: ```tool_call\n{"name": "edit", "arguments": {"path": "project.godot", "edits": [...]}}\n```\n'
                )
            elif has_write:
                examples.append(
                    'User: Исправь ошибки в project.godot\n'
                    'Assistant: ```tool_call\n{"name": "write", "arguments": {"path": "project.godot", "content": "..."}}\n```\n'
                )

        # Only emit the header when examples follow it. A dangling "Examples:"
        # right before the dialogue made the model read the real task as one of
        # the examples and reply that no task had been given.
        tools_instruction = "\n".join(instruction_lines)
        if len(examples) > 1:
            tools_instruction += "\n" + "\n".join(examples)
        system_prompts.append(tools_instruction)
    if tool_directive:
        system_prompts.append(tool_directive)

    processed_messages = messages

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
                                        raw_bytes = resp.read()
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
                    parts.append(f"```tool_call\n{{\"name\": \"{tc_name}\", \"arguments\": {args_val}}}\n```")
            dialogue_parts.append(f"Assistant: {' '.join(parts)}")
        elif m.role in ("tool", "function"):
            tool_name = m.name or m.tool_call_id or "tool"
            dialogue_parts.append(f"Tool Result ({tool_name}): {text}")
        else:
            dialogue_parts.append(f"{m.role.capitalize()}: {text}")

    full_prompt = ""
    if system_prompts:
        full_prompt += "### System Instructions:\n" + "\n\n".join(system_prompts) + "\n\n"
    if dialogue_parts:
        if len(dialogue_parts) == 1 and dialogue_parts[0].startswith("User: ") and not system_prompts:
            full_prompt = dialogue_parts[0][6:]
        else:
            full_prompt += "\n\n".join(dialogue_parts)
            if not dialogue_parts[-1].startswith("Assistant:"):
                full_prompt += "\n\nAssistant:"

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
        if dropped:
            dialogue_parts.insert(0, f"[{dropped} earlier turn(s) dropped: they no longer fit the Gemini Web prompt limit.]")
        full_prompt = header + "\n\n".join(dialogue_parts) + "\n\nAssistant:"

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

def output_limits(text: str, stops: List[str], max_tokens: Optional[int]) -> tuple[int, Optional[str]]:
    """Enforces stop and max_tokens here, because Gemini Web accepts neither.

    Returns how much of the cumulative text may be emitted and whether generation
    should end. While no stop has matched, a tail of len(stop)-1 is held back so a
    sequence split across chunks is still caught — that also keeps the emitted
    prefix from ever having to shrink.
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
            limit = min(limit, earliest)
            reason = reason or "stop"
        else:
            guard = max(len(s) for s in stops) - 1
            if guard > 0:
                limit = min(limit, max(0, len(text) - guard))

    return limit, reason

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
    cb_pattern = r"```(?:[a-zA-Z0-9_\-]+)?\s*([\{\[][\s\S]*?)\s*```"
    for m in re.finditer(cb_pattern, text):
        raw = m.group(1).strip()
        try:
            parsed = repair_json(raw)
            items = parsed if isinstance(parsed, list) else [parsed]
            for item in items:
                if isinstance(item, dict):
                    name = item.get("name") or item.get("function") or item.get("tool")
                    args = item.get("arguments") or item.get("parameters") or item.get("args") or item.get("params") or item.get("input") or {}
                    if name and any(k in item for k in ARG_KEYS):
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

@app.get("/")
@app.get("/health")
async def health_check():
    load_env_file()
    has_cookies = bool(os.getenv("GEMINI_SECURE_1PSID") or os.getenv("__Secure_1PSID") or os.getenv("SECURE_1PSID"))
    is_active = client_instance is not None and client_instance._running
    models = []
    quotas = {}
    if is_active and client_instance:
        raw_models = client_instance.list_models() or []
        models = [m.model_name for m in raw_models]
        quotas = client_instance._quotas or {}
    return {
        "status": "ok",
        "service": "Gemini Web to OpenAI Bridge (Google AI Pro - Antigravity Orchestrator Edition)",
        "cookies_configured": has_cookies,
        "client_active": is_active,
        "active_models": models,
        "quotas": quotas,
        "endpoint": f"http://{HOST}:{PORT}/v1",
    }

@app.get("/v1/models")
@app.get("/v1beta/models")
@app.get("/models")
async def list_models():
    models_list = [
        {"id": "gemini-orchestrator", "name": "Gemini Orchestrator (Auto: Carbon + Hydrogen)"},
        {"id": "gemini-carbon", "name": "Gemini Carbon (Глубокие рассуждения)"},
        {"id": "gemini-pro", "name": "Gemini Pro (Сложные задачи)"},
        {"id": "gemini-4-hydrogen-high", "name": "Gemini 4 Hydrogen (Высокий Thinking)"},
        {"id": "gemini-4-hydrogen", "name": "Gemini 4 Hydrogen (Повседневный кодинг)"},
        {"id": "gemini-flash-lite", "name": "Gemini Flash Lite (Быстрые ответы)"},
    ]

    live = set()
    if client_instance is not None and client_instance._running:
        try:
            live = {m.model_name for m in (client_instance.list_models() or [])}
        except Exception:
            live = set()

    def served_by(mid: str) -> str:
        if "orchestrator" in mid:
            return "gemini-4-hydrogen"
        if "flash" in mid or "lite" in mid:
            return "gemini-flash-lite"
        if "carbon" in mid:
            return "gemini-carbon"
        if "pro" in mid:
            return "gemini-pro"
        return "gemini-4-hydrogen"

    return {
        "object": "list",
        "account_models": sorted(live),
        "data": [
            {
                "id": m["id"],
                "object": "model",
                "created": int(time.time()),
                "owned_by": "google",
                "permission": [],
                "root": m["id"],
                "parent": None,
                # When Google returns a partial registry the bridge falls back to
                # a weaker model. Say so here instead of letting the caller think
                # it is talking to Carbon.
                "available": (not live) or served_by(m["id"]) in live,
            }
            for m in models_list
        ],
    }

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
        # that still generate. Probe once, and only in this ambiguous case, so
        # login.cmd polling does not spend quota on every tick.
        try:
            await client.generate_content("ping", model="gemini-flash-lite")
        except Exception:
            return {
                "ok": False,
                "browser_alive": browser_alive,
                "session_updated": updated,
                "account_status": status_name,
                "detail": "Сессия Google недействительна. Запустите login.cmd и войдите в аккаунт в окне Chrome моста.",
            }
    return {"ok": True, "browser_alive": browser_alive, "session_updated": updated,
            "account_status": status_name}

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
      
      const h5Rem = h5.remaining_credits ?? 2400;
      const h5Tot = h5.total_credits || 2400;
      const h5Pct = (h5.remaining_percentage !== undefined) ? h5.remaining_percentage : Math.round((h5Rem / h5Tot) * 100);
      
      document.getElementById('h5Rem').textContent = h5Rem.toLocaleString();
      document.getElementById('h5Badge').textContent = h5Pct + '% доступно';
      document.getElementById('h5Bar').style.width = Math.min(100, Math.max(0, h5Pct)) + '%';
      
      const wRem = w.remaining_credits ?? 48384;
      const wTot = w.total_credits || 48384;
      const wPct = (w.remaining_percentage !== undefined) ? w.remaining_percentage : Math.round((wRem / wTot) * 100);
      
      document.getElementById('wRem').textContent = wRem.toLocaleString();
      document.getElementById('wBadge').textContent = wPct + '% доступно';
      document.getElementById('wBar').style.width = Math.min(100, Math.max(0, wPct)) + '%';
      document.getElementById('wUsed').textContent = (w.used_credits || 0).toLocaleString() + ' кр. (' + (w.usage_percentage || 0) + '%)';

      const pill = document.querySelector('.status-pill');
      if (pill) {
        if (d.source === 'antigravity_daemon') {
          pill.innerHTML = '<span class=\"status-dot\"></span> 🟢 ANTIGRAVITY AUTO-SYNC';
        } else if (d.ok) {
          pill.innerHTML = '<span class=\"status-dot\"></span> PRO ACTIVE';
        } else {
          pill.innerHTML = '<span class=\"status-dot\" style=\"background:#ef4444;\"></span> ⚠️ AUTH REQUIRED';
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
        if (data.ok) {
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

@app.get("/v1/quota")
@app.get("/api/quota")
async def get_quota_info():
    """Returns real-time Google AI Pro quota and remaining credit metrics, prioritizing direct local Antigravity daemon sync."""
    agy_data = None
    try:
        agy_data = fetch_antigravity_live_quota()
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
        c5h_reset = h5.get("reset_time", "")

        w_total = 48384
        w_rem_pct = w.get("remaining_pct", 100.0)
        w_frac = w.get("remaining_fraction", w_rem_pct / 100.0)
        w_rem = int(round(w_total * w_frac))
        w_used = max(0, w_total - w_rem)
        w_pct = round(100.0 - w_rem_pct, 1)
        w_reset = w.get("reset_time", "")

        tier_name = user_info.get("tier", "Pro")
        user_email = user_info.get("email", "")
        tier = f"PRO ({tier_name})" if not user_email else f"PRO ({user_email})"
        is_authenticated = True
        status_label = f"AVAILABLE (Antigravity Daemon : {agy_data.get('port', 'live')})"
    else:
        # Fallback when Antigravity daemon is inactive
        is_authenticated = False
        status_label = "UNAUTHENTICATED"
        tier = "AUTH REQUIRED"
        c5h_rem = 0
        c5h_total = 2400
        c5h_used = 2400
        c5h_pct = 100.0
        c5h_rem_pct = 0.0
        c5h_reset = ""
        w_rem = 0
        w_total = 48384
        w_used = 48384
        w_pct = 100.0
        w_rem_pct = 0.0
        w_reset = ""

        try:
            client = await get_gemini_client()
            if hasattr(client, "_fetch_usage_info"):
                await client._fetch_usage_info()
            usage = getattr(client, "usage_info", {}) or {}
            c5h = usage.get("current_5h", {})
            weekly = usage.get("weekly", {})
            tier_info = usage.get("tier", {})
            tier = tier_info.get("label", "PRO") if isinstance(tier_info, dict) else "PRO"
            is_authenticated = (getattr(client.account_status, "name", "") == "AVAILABLE") and bool(usage)
            if is_authenticated:
                c5h_rem = c5h.get("remaining_credits", 2400)
                c5h_used = max(0, c5h_total - c5h_rem)
                c5h_pct = c5h.get("usage_percentage", round((c5h_used / c5h_total) * 100, 1))
                c5h_rem_pct = round(100.0 - c5h_pct, 1)
                c5h_reset = c5h.get("reset_at", "")

                w_rem = weekly.get("remaining_credits", 48384)
                w_used = max(0, w_total - w_rem)
                w_pct = weekly.get("usage_percentage", round((w_used / w_total) * 100, 1))
                w_rem_pct = round(100.0 - w_pct, 1)
                w_reset = weekly.get("reset_at", "")
                status_label = "AVAILABLE (Web Session)"
        except Exception as e:
            print(f"[QUOTA] Web client fallback error: {e}")

    est_hydrogen = int(c5h_rem / 2) if c5h_rem else 0
    est_orchestrator = int(c5h_rem / 8) if c5h_rem else 0
    est_carbon = int(c5h_rem / 22) if c5h_rem else 0

    return {
        "ok": is_authenticated,
        "tier": tier,
        "account_status": status_label,
        "source": "antigravity_daemon" if (agy_data and agy_data.get("quotas")) else "web_client",
        "window_5h": {
            "total_credits": c5h_total,
            "remaining_credits": c5h_rem,
            "used_credits": c5h_used,
            "usage_percentage": c5h_pct,
            "remaining_percentage": c5h_rem_pct,
            "reset_at": c5h_reset,
            "estimated_requests": {
                "hydrogen_fast": est_hydrogen,
                "orchestrator_balanced": est_orchestrator,
                "carbon_deep_thinking": est_carbon
            }
        },
        "weekly": {
            "total_credits": w_total,
            "remaining_credits": w_rem,
            "used_credits": w_used,
            "usage_percentage": w_pct,
            "remaining_percentage": w_rem_pct,
            "reset_at": w_reset
        },
        "models": [
            {"id": "gemini-orchestrator", "name": "Gemini Orchestrator (Auto: Carbon + Hydrogen)", "default": True},
            {"id": "gemini-carbon", "name": "Gemini Carbon (Глубокие рассуждения)", "tier": "Flagship"},
            {"id": "gemini-pro", "name": "Gemini Pro (Сложные задачи)", "tier": "Flagship"},
            {"id": "gemini-4-hydrogen-high", "name": "Gemini 4 Hydrogen (Высокий Thinking)", "tier": "Fast Thinking"},
            {"id": "gemini-4-hydrogen", "name": "Gemini 4 Hydrogen (Повседневный кодинг)", "tier": "Fast"}
        ]
    }

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
    """True only when the whole reply is a Google error page.

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
    )
    return any(p in t for p in patterns)

@app.post("/v1/chat/completions")
@app.post("/chat/completions")
async def chat_completions(req: ChatCompletionRequest, request: Request):
    cleanup_old_upload_cache()
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
    stops = normalize_stops(req.stop)
    client = await get_gemini_client()
    prompt, files_to_upload = parse_openai_messages(req.messages, req.tools, tool_directive)

    if not prompt and not files_to_upload:
        raise HTTPException(status_code=400, detail="Messages and files cannot be empty")

    completion_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
    created_time = int(time.time())

    # Fast-path for the client's background title generation. Matched against the
    # last user turn only: searching the whole prompt hijacked real coding tasks
    # like "write a function to generate a title for each blog post".
    last_user = next((m for m in reversed(req.messages) if m.role == "user"), None)
    last_user_text = str(last_user.content or "").lower() if last_user else ""
    is_title_request = not req.tools and "reply with only the title" in last_user_text

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
    model_id = req.model.lower().strip()
    effort = (req.reasoning_effort or "").lower().strip()
    extended_thinking = True
    gemini_model_param = "gemini-4-hydrogen"

    # Support model modifiers from Sophomoresty/gemini-web2api (@think=true / @think=false / @think=0)
    explicit_think_override = None
    if "@think=" in model_id:
        base_part, think_part = model_id.split("@think=", 1)
        model_id = base_part.strip()
        think_val = think_part.split()[0].strip()
        if think_val in ("false", "0", "off", "none"):
            explicit_think_override = False
        elif think_val in ("true", "1", "on", "high"):
            explicit_think_override = True

    if "flash" in model_id or "lite" in model_id:
        gemini_model_param = "gemini-flash-lite"
        extended_thinking = False
    elif "carbon" in model_id:
        gemini_model_param = "gemini-carbon"
        extended_thinking = True if explicit_think_override is None else explicit_think_override
    elif "orchestrator" in model_id:
        gemini_model_param, routed_thinking = orchestrator_route(req.messages, req.tools, effort, prompt)
        extended_thinking = routed_thinking if explicit_think_override is None else explicit_think_override
    elif "high" in model_id:
        gemini_model_param = "gemini-4-hydrogen"
        extended_thinking = True if explicit_think_override is None else explicit_think_override
    elif "pro" in model_id:
        gemini_model_param = "gemini-pro"
        extended_thinking = True if explicit_think_override is None else explicit_think_override
    else:
        gemini_model_param = "gemini-4-hydrogen"
        extended_thinking = False if explicit_think_override is None else explicit_think_override

    print(f"[ROUTE] {req.model} -> {gemini_model_param}, thinking={extended_thinking}")
    routed_model = gemini_model_param
    gemini_model_param = resolve_available_model(client, gemini_model_param)
    # The orchestrator is a router: landing on hydrogen is its job, not a
    # downgrade. Only an unavailable concrete model counts as a fallback.
    model_fallback = gemini_model_param != routed_model
    resp_model = gemini_model_param

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
                    continue
                print(f"[ERROR] Ошибка загрузки файлов: {upload_err}")
                raise HTTPException(status_code=500, detail=f"Не удалось загрузить медиафайл в Gemini: {upload_err}")

    completion_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
    created_time = int(time.time())

    # STREAMING (SSE)
    if req.stream:
        async def event_generator():
            nonlocal client, prompt

            for attempt in range(2):
                try:
                    print(f"[STREAM] Старт _generate: model={gemini_model_param}, thinking={extended_thinking}")
                    session_state = {"last_texts": {}, "last_thoughts": {}}
                    last_sent_text = ""
                    last_sent_thought = ""
                    collected_full_text = ""
                    finish_override = None

                    chunk_count = 0
                    async for chunk in client._generate(
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
                        if attempt == 0:
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
                        prompt, _ = parse_openai_messages(
                            req.messages, req.tools,
                            tool_directive + " Your last tool call was invalid: " + "; ".join(problems)
                            + ". Emit the corrected tool_call block with every required argument.")
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
                        if clean_text.startswith(last_sent_text) and len(clean_text) > len(last_sent_text):
                            rem_text = clean_text[len(last_sent_text):]
                            yield f"data: {json.dumps({'id': completion_id, 'object': 'chat.completion.chunk', 'created': created_time, 'model': req.model, 'choices': [{'index': 0, 'delta': {'content': rem_text}, 'finish_reason': None}]}, ensure_ascii=False)}\n\n"
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
                    if attempt == 0 and is_auth_or_session_error(stream_err):
                        print(f"[WARN] Сбой сессии во время стрима ({stream_err}). Автоматическое восстановление сессии Google...")
                        try:
                            client = await get_gemini_client(force_refresh=True)
                            continue
                        except Exception as refresh_err:
                            print(f"[ERROR] Не удалось восстановить сессию: {refresh_err}")

                    err_payload = {
                        "error": {
                            "message": str(stream_err),
                            "type": "gemini_stream_error",
                        }
                    }
                    yield f"data: {json.dumps(err_payload)}\n\n"
                    yield "data: [DONE]\n\n"
                    return

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # NON-STREAMING (with automatic retry on session dropout)
    for attempt in range(2):
        try:
            session_state = {"last_texts": {}, "last_thoughts": {}}

            async def collect_reply():
                last = None
                async for ch in client._generate(
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

            gen_task = asyncio.create_task(collect_reply())
            while not gen_task.done():
                if await request.is_disconnected():
                    gen_task.cancel()
                    print("[REQUEST] Клиент отключился — генерация Google отменена.")
                    return
                await asyncio.sleep(0.4)
            last_chunk = gen_task.result()

            reply_content = getattr(last_chunk, "text", "") or ""
            reply_thoughts = getattr(last_chunk, "thoughts", None)

            cap, cap_reason = output_limits(reply_content, stops, req.max_tokens)
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

            problems = tool_call_problems(tool_calls, req.tools) if tool_calls else []
            if problems and attempt == 0:
                print(f"[TOOL_FIX] Битый вызов, просим исправить: {problems}")
                prompt, _ = parse_openai_messages(
                    req.messages, req.tools,
                    tool_directive + " Your last tool call was invalid: " + "; ".join(problems)
                    + ". Emit the corrected tool_call block with every required argument.")
                continue

            if not tool_calls and not cap_reason and (forced_tool or req.tool_choice == "required"):
                if attempt == 0:
                    print("[TOOL_CHOICE] Обязательный вызов не состоялся — повтор с усиленной директивой.")
                    prompt, _ = parse_openai_messages(
                        req.messages, req.tools,
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
                raise HTTPException(status_code=429,
                                    detail="Google ограничил сессию (429). Подождите несколько минут.")
            if attempt == 0 and is_auth_or_session_error(e):
                print(f"[WARN] Сбой сессии ({e}). Выполняем авто-восстановление сессии...")
                try:
                    client = await get_gemini_client(force_refresh=True)
                    continue
                except Exception:
                    pass
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
        "model": model, "output": output, "error": None,
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

        def emit(kind: str, payload: Dict[str, Any]) -> str:
            nonlocal seq
            seq += 1
            body = {"type": kind, "sequence_number": seq, **payload}
            return f"event: {kind}\ndata: {json.dumps(body, ensure_ascii=False)}\n\n"

        base = {"id": resp_id, "object": "response", "created_at": created,
                "status": "in_progress", "model": resp_model, "output": [], "error": None}
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
                yield emit("response.failed", {"response": {**base, "status": "failed", "error": d["error"]}})
                return
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
        final = {**base, "status": "completed", "output": output,
                 "usage": {"input_tokens": usage.get("prompt_tokens", 0),
                           "output_tokens": usage.get("completion_tokens", 0),
                           "total_tokens": usage.get("total_tokens", 0)}}
        yield emit("response.completed", {"response": final})

    return StreamingResponse(as_responses_events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

if __name__ == "__main__":
    import uvicorn
    print(f"Запуск Gemini Web Bridge на http://{HOST}:{PORT} ...")
    uvicorn.run("server:app", host=HOST, port=PORT, reload=False)
