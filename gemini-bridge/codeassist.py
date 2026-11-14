"""Native Gemini Code Assist backend.

Why this exists: the Gemini web session has no function calling, so tool calls
have to be smuggled through the prompt text. Code Assist speaks the real
protocol — `tools.functionDeclarations` in, `functionCall` parts out — which is
what Antigravity uses.

It needs a GCP project of your own: loadCodeAssist answers standard-tier with
userDefinedCloudaicompanionProject, and without a real project every generation
call answers 404. Set CODEASSIST_PROJECT once the project exists.
"""

import os
import json
import time
import ctypes
import ctypes.wintypes as w
from pathlib import Path
from typing import Any, Optional

from curl_cffi import requests

HOST = "https://cloudcode-pa.googleapis.com"
CRED_TARGET = "gemini:antigravity"
TOKEN_CACHE = Path(__file__).parent / ".codeassist-token.json"
METADATA = {"ideType": "ANTIGRAVITY", "platform": "PLATFORM_UNSPECIFIED", "pluginType": "GEMINI"}


class _CRED(ctypes.Structure):
    _fields_ = [("Flags", w.DWORD), ("Type", w.DWORD), ("TargetName", w.LPWSTR),
                ("Comment", w.LPWSTR), ("LastWritten", w.FILETIME),
                ("CredentialBlobSize", w.DWORD),
                ("CredentialBlob", ctypes.POINTER(ctypes.c_byte)),
                ("Persist", w.DWORD), ("AttributeCount", w.DWORD),
                ("Attributes", ctypes.c_void_p), ("TargetAlias", w.LPWSTR),
                ("UserName", w.LPWSTR)]


def _read_refresh_token() -> str:
    adv = ctypes.WinDLL("advapi32")
    pc = ctypes.POINTER(_CRED)()
    if not adv.CredReadW(CRED_TARGET, 1, 0, ctypes.byref(pc)):
        raise RuntimeError("В Credential Manager нет записи gemini:antigravity — войдите в Antigravity.")
    c = pc.contents
    blob = ctypes.string_at(c.CredentialBlob, c.CredentialBlobSize).decode("utf-8")
    adv.CredFree(pc)
    return json.loads(blob)["token"]["refresh_token"]


def _oauth_clients() -> tuple[list[str], list[str]]:
    """The installed-app clients Antigravity ships. Public by design.

    The binary stores Go strings back to back, so ids and secrets cannot be
    paired by position — the working combination is found by trying them.
    """
    import re
    exe = Path(os.environ["LOCALAPPDATA"]) / "Programs/antigravity/resources/bin/language_server.exe"
    if not exe.exists():
        raise RuntimeError("Не найден language_server.exe Antigravity.")
    b = exe.read_bytes()
    ids = sorted({m.decode() for m in re.findall(rb"[0-9]{10,}-[a-z0-9_]{20,}\.apps\.googleusercontent\.com", b)})
    secrets = sorted({m.decode() for m in re.findall(rb"GOCSPX-[A-Za-z0-9_\-]{28}", b)})
    if not ids or not secrets:
        raise RuntimeError("Не удалось извлечь OAuth-клиент из Antigravity.")
    return ids, secrets


class CodeAssist:
    def __init__(self, project: Optional[str] = None, proxy: Optional[str] = None):
        self.project = project or os.getenv("CODEASSIST_PROJECT", "")
        self.session = requests.Session(
            impersonate="chrome",
            proxies={"https": proxy, "http": proxy} if proxy else None,
            timeout=180,
        )
        self._token = None
        self._expires = 0.0

    def token(self) -> str:
        if self._token and time.time() < self._expires - 60:
            return self._token
        if TOKEN_CACHE.exists():
            try:
                cached = json.loads(TOKEN_CACHE.read_text(encoding="utf-8"))
                if cached.get("expires", 0) - 60 > time.time():
                    self._token, self._expires = cached["token"], cached["expires"]
                    return self._token
            except Exception:
                pass
        ids, secrets = _oauth_clients()
        refresh = _read_refresh_token()
        last = None
        for candidate in ids:
            for sec in secrets:
                r = self.session.post("https://oauth2.googleapis.com/token",
                                      data={"client_id": candidate, "client_secret": sec,
                                            "refresh_token": refresh, "grant_type": "refresh_token"})
                if r.status_code == 200:
                    d = r.json()
                    self._token = d["access_token"]
                    self._expires = time.time() + int(d.get("expires_in", 3600))
                    TOKEN_CACHE.write_text(json.dumps({"token": self._token, "expires": self._expires}),
                                           encoding="utf-8")
                    return self._token
                last = r.text[:200]
        raise RuntimeError(f"Не удалось обновить токен Code Assist: {last}")

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.token()}", "Content-Type": "application/json",
                "User-Agent": "jetski/2.31.2", "X-Goog-Api-Client": "gl-go/1.24.0 jetbox/2.31.2"}

    def call(self, method: str, body: dict) -> dict:
        r = self.session.post(f"{HOST}/v1internal:{method}", headers=self._headers(), json=body)
        if r.status_code != 200:
            raise RuntimeError(f"{method} -> {r.status_code}: {r.text[:300]}")
        return r.json()

    def onboard(self) -> dict:
        if not self.project:
            raise RuntimeError("Не задан CODEASSIST_PROJECT.")
        return self.call("onboardUser", {"tierId": "standard-tier", "metadata": METADATA,
                                         "cloudaicompanionProject": self.project})

    def status(self) -> dict:
        body = {"metadata": METADATA, "mode": "FULL_ELIGIBILITY_CHECK"}
        if self.project:
            body["cloudaicompanionProject"] = self.project
        return self.call("loadCodeAssist", body)

    def models(self) -> dict:
        return self.call("fetchAvailableModels", {"project": self.project})

    def stream(self, model: str, request_body: dict):
        """Yields parsed SSE frames from streamGenerateContent."""
        body = {"model": model, "request": request_body}
        if self.project:
            body["project"] = self.project
        with self.session.stream("POST", f"{HOST}/v1internal:streamGenerateContent?alt=sse",
                                 headers=self._headers(), json=body) as r:
            if r.status_code != 200:
                detail = b"".join(r.iter_content())[:300]
                raise RuntimeError(f"streamGenerateContent -> {r.status_code}: {detail!r}")
            for line in r.iter_lines():
                if not line:
                    continue
                text = line.decode("utf-8") if isinstance(line, bytes) else str(line)
                if text.startswith("data: "):
                    payload = text[6:]
                    if payload == "[DONE]":
                        return
                    try:
                        yield json.loads(payload)
                    except Exception:
                        continue


def openai_to_contents(messages: list) -> tuple[list, Optional[dict]]:
    """OpenAI chat messages -> Gemini contents plus systemInstruction."""
    contents: list[dict] = []
    system_parts: list[str] = []
    for m in messages:
        role = m.get("role")
        content = m.get("content")
        if isinstance(content, list):
            content = "\n".join(c.get("text", "") for c in content if isinstance(c, dict))
        content = content or ""
        if role == "system":
            system_parts.append(content)
        elif role == "user":
            contents.append({"role": "user", "parts": [{"text": content}]})
        elif role == "assistant":
            parts = []
            if content:
                parts.append({"text": content})
            for tc in m.get("tool_calls") or []:
                fn = tc.get("function") or {}
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except Exception:
                    args = {}
                parts.append({"functionCall": {"name": fn.get("name", ""), "args": args}})
            if parts:
                contents.append({"role": "model", "parts": parts})
        elif role in ("tool", "function"):
            try:
                parsed = json.loads(content)
                payload = parsed if isinstance(parsed, dict) else {"result": parsed}
            except Exception:
                payload = {"result": content}
            contents.append({"role": "user", "parts": [
                {"functionResponse": {"name": m.get("name") or "tool", "response": payload}}]})
    system = {"parts": [{"text": "\n\n".join(system_parts)}]} if system_parts else None
    return contents, system


def openai_to_tools(tools: Optional[list]) -> Optional[list]:
    if not tools:
        return None
    declarations = []
    for t in tools:
        fn = (t.get("function") or t) if isinstance(t, dict) else None
        if not fn or not fn.get("name"):
            continue
        declarations.append({"name": fn["name"], "description": fn.get("description", ""),
                             "parameters": fn.get("parameters", {"type": "object", "properties": {}})})
    return [{"functionDeclarations": declarations}] if declarations else None


def build_request(messages: list, tools: Optional[list] = None,
                  max_tokens: Optional[int] = None, temperature: Optional[float] = None,
                  top_p: Optional[float] = None, stop: Optional[list] = None) -> dict:
    contents, system = openai_to_contents(messages)
    body: dict[str, Any] = {"contents": contents}
    if system:
        body["systemInstruction"] = system
    decls = openai_to_tools(tools)
    if decls:
        body["tools"] = decls
    gen: dict[str, Any] = {}
    if max_tokens:
        gen["maxOutputTokens"] = max_tokens
    if temperature is not None:
        gen["temperature"] = temperature
    if top_p is not None:
        gen["topP"] = top_p
    if stop:
        gen["stopSequences"] = stop
    if gen:
        body["generationConfig"] = gen
    return body