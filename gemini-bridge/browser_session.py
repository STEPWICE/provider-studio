"""Cookie acquisition via Chrome DevTools Protocol.

Chrome holds an exclusive lock on its cookie database and encrypts values with
app-bound keys, so reading the profile from disk is not viable. A Chrome instance
we launch ourselves exposes the same cookies over CDP instead.
"""

import json
import os
from pathlib import Path
from typing import Dict, Optional

from curl_cffi import requests as cffi_requests

CDP_PORT = int(os.getenv("CDP_PORT", "9223"))
CDP_BASE = f"http://127.0.0.1:{CDP_PORT}"
WANTED = ("__Secure-1PSID", "__Secure-1PSIDTS")


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


def find_chrome() -> Optional[Path]:
    candidates = [
        Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe",
    ]
    return next((p for p in candidates if p.exists()), None)