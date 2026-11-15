"""Cookie acquisition via Chrome DevTools Protocol.

Chrome holds an exclusive lock on its cookie database and encrypts values with
app-bound keys, so reading the profile from disk is not viable. A Chrome instance
we launch ourselves exposes the same cookies over CDP instead.
"""

import json
import os
import re
from pathlib import Path
from typing import Dict, Optional

from curl_cffi import requests as cffi_requests

CDP_PORT = int(os.getenv("CDP_PORT", "9223"))
CDP_BASE = f"http://127.0.0.1:{CDP_PORT}"
WANTED = ("__Secure-1PSID", "__Secure-1PSIDTS")

GEMINI_APP_URL = "https://gemini.google.com/app"
# WIZ_global_data carries the signed-in account identifier here: an email or a
# numeric account id. It is empty on a guest page, which is the only reliable
# difference: a guest session still serves the full ~900 KB app shell and still
# generates on flash-lite.
ACCOUNT_MARKER_RE = re.compile(r'"S06Grb"\s*:\s*"([^"]*)"')
SIGN_IN_RE = re.compile(r'aria-label="Sign in"|accounts\.google\.com/ServiceLogin')
CAPTCHA_MARKERS = ("sorry/index", "unusual traffic", "g-recaptcha")


def inspect_app_page(body: str, status: int = 200, url: str = "") -> Dict[str, object]:
    """Classifies a Gemini app response as signed-in, guest, or CAPTCHA-blocked.

    `authenticated` is None when the page carries neither marker, so an unfamiliar
    layout is never reported as a definite sign-out.
    """
    text = body or ""
    lowered = text[:200000].lower()
    captcha = (status in (403, 429) and any(m in lowered for m in CAPTCHA_MARKERS)) or (
        any(m in lowered for m in CAPTCHA_MARKERS) and len(text) < 200000) or (
        "sorry/index" in (url or ""))
    if captcha:
        return {"authenticated": False, "account": None, "captcha": True, "reason": "captcha"}

    match = ACCOUNT_MARKER_RE.search(text)
    if match and match.group(1):
        return {"authenticated": True, "account": match.group(1), "captcha": False, "reason": "account_marker"}
    if match or SIGN_IN_RE.search(text):
        return {"authenticated": False, "account": None, "captcha": False, "reason": "guest_session"}
    return {"authenticated": None, "account": None, "captcha": False, "reason": "unknown"}


def probe_session(psid: str, psidts: str = "", proxy: Optional[str] = None,
                  timeout: float = 25.0) -> Dict[str, object]:
    """Asks Google what this cookie pair really is, through the bridge's own exit."""
    if not psid:
        return {"authenticated": False, "account": None, "captcha": False, "reason": "no_cookies"}
    cookies = {"__Secure-1PSID": psid}
    if psidts:
        cookies["__Secure-1PSIDTS"] = psidts
    try:
        response = cffi_requests.get(
            GEMINI_APP_URL, proxy=proxy or None, impersonate="chrome",
            cookies=cookies, timeout=timeout, allow_redirects=False, verify=True,
        )
    except Exception as exc:
        return {"authenticated": None, "account": None, "captcha": False,
                "reason": "probe_failed", "error": str(exc)}
    if response.status_code in (301, 302, 303, 307, 308):
        location = response.headers.get("location", "")
        return {"authenticated": False, "account": None,
                "captcha": "sorry/index" in location,
                "reason": "captcha" if "sorry/index" in location else "redirect",
                "location": location}
    state = inspect_app_page(response.text or "", response.status_code)
    state["status"] = response.status_code
    return state


def browser_debug_alive() -> bool:
    try:
        r = cffi_requests.get(f"{CDP_BASE}/json/version", timeout=3)
        return r.status_code == 200
    except Exception:
        return False


def harvest_cookies() -> Dict[str, str]:
    """Returns the Google session cookies from the bridge-owned Chrome, or {}."""
    try:
        version = cffi_requests.get(f"{CDP_BASE}/json/version", timeout=5).json()
        ws_url = version.get("webSocketDebuggerUrl")
        if not ws_url:
            return {}
        session = cffi_requests.Session()
        ws = session.ws_connect(ws_url, timeout=15)
        try:
            ws.send_json({"id": 1, "method": "Storage.getCookies"})
            for _ in range(20):
                raw = ws.recv()
                if isinstance(raw, tuple):
                    raw = raw[0]
                msg = json.loads(raw)
                if msg.get("id") != 1:
                    continue
                cookies = msg.get("result", {}).get("cookies", [])
                found = {}
                for c in cookies:
                    if c.get("name") in WANTED and "google.com" in (c.get("domain") or ""):
                        if c.get("value"):
                            found[c["name"]] = c["value"]
                return found
            return {}
        finally:
            ws.close()
            session.close()
    except Exception as e:
        print(f"[CDP] Не удалось прочитать куки из браузера моста: {e}")
        return {}


def reopen_saved_profile() -> bool:
    """Reopen our own saved profile only. Never log in or read other profiles."""
    import subprocess
    import time

    if browser_debug_alive():
        return True
    chrome = find_chrome()
    profile = Path(__file__).resolve().parent / ".chrome-profile"
    if chrome is None or not profile.is_dir():
        return False
    subprocess.Popen([
        str(chrome), f"--remote-debugging-port={CDP_PORT}",
        "--remote-debugging-address=127.0.0.1", f"--user-data-dir={profile}",
        "--no-first-run", "--no-default-browser-check", "https://gemini.google.com/app",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(15):
        if browser_debug_alive():
            return True
        time.sleep(1)
    return False


def find_chrome() -> Optional[Path]:
    candidates = [
        Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe",
    ]
    return next((p for p in candidates if p.exists()), None)