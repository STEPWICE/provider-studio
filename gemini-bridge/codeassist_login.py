"""Sign in to Gemini Code Assist with the Gemini CLI OAuth client.

Why a second login: the Antigravity client is refused the free individual tier
("This client is no longer supported ... migrate to Antigravity"), and its
standard-tier demands a paid licence. The Gemini CLI client is a different
consumer of the same API and is the one individuals are meant to use.

Run:  python codeassist_login.py
A browser window opens; approve access once. The refresh token is stored in
.codeassist-oauth.json, which is gitignored.
"""

import base64
import hashlib
import http.server
import json
import os
import secrets
import socket
import sys
import threading
import urllib.parse
import webbrowser
from pathlib import Path

from curl_cffi import requests

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com"
CLIENT_FILE = Path(__file__).parent / ".codeassist-client.json"


def client_secret() -> str:
    """Read at runtime, never committed.

    It is a public installed-app credential shipped inside @google/gemini-cli,
    but a literal here trips secret scanning on push. Take it from
    GEMINI_CLI_CLIENT_SECRET or .codeassist-client.json, or copy it out of the
    package: npm pack @google/gemini-cli, then grep the bundle for GOCSPX-.
    """
    env = os.getenv("GEMINI_CLI_CLIENT_SECRET")
    if env:
        return env
    if CLIENT_FILE.exists():
        try:
            value = json.loads(CLIENT_FILE.read_text(encoding="utf-8")).get("client_secret")
            if value:
                return value
        except Exception:
            pass
    raise SystemExit(
        "Не задан client_secret Gemini CLI.\n"
        "Задайте переменную GEMINI_CLI_CLIENT_SECRET или создайте .codeassist-client.json "
        'вида {"client_secret": "GOCSPX-..."}.\n'
        "Значение лежит в опубликованном пакете @google/gemini-cli (bundle, строка GOCSPX-)."
    )
SCOPES = [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
]
STORE = Path(__file__).parent / ".codeassist-oauth.json"

with socket.socket() as s:
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
redirect = f"http://127.0.0.1:{port}/oauth2callback"

verifier = base64.urlsafe_b64encode(secrets.token_bytes(64)).decode().rstrip("=")
challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
state = secrets.token_urlsafe(16)

auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
    "client_id": CLIENT_ID, "redirect_uri": redirect, "response_type": "code",
    "scope": " ".join(SCOPES), "access_type": "offline", "prompt": "consent",
    "code_challenge": challenge, "code_challenge_method": "S256", "state": state,
})

result = {}
done = threading.Event()


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        if "code" not in q and "error" not in q:
            self.send_response(404)
            self.end_headers()
            return
        result.update({k: v[0] for k, v in q.items()})
        ok = "code" in result and result.get("state") == state
        body = ("<h2>Done. You can close this tab.</h2>" if ok
                else "<h2>Sign-in failed. Return to the terminal.</h2>")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(body.encode())
        done.set()

    def log_message(self, *a):
        pass


server = http.server.HTTPServer(("127.0.0.1", port), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()

print("Откройте эту ссылку и разрешите доступ (окно браузера откроется само):")
print(auth_url)
print()
webbrowser.open(auth_url)

if not done.wait(timeout=300):
    print("Время ожидания истекло (5 минут). Запустите скрипт снова.")
    sys.exit(1)
server.shutdown()

if "code" not in result:
    print("Вход не выполнен:", result.get("error"))
    sys.exit(1)
if result.get("state") != state:
    print("Несовпадение state — вход отклонён.")
    sys.exit(1)

S = requests.Session(impersonate="chrome", timeout=90)
r = S.post("https://oauth2.googleapis.com/token", data={
    "client_id": CLIENT_ID, "client_secret": client_secret(), "code": result["code"],
    "code_verifier": verifier, "grant_type": "authorization_code", "redirect_uri": redirect,
})
if r.status_code != 200:
    print("Обмен кода не удался:", r.text[:300])
    sys.exit(1)
tok = r.json()
if "refresh_token" not in tok:
    print("Google не выдал refresh_token. Отзовите доступ приложения и повторите вход.")
    sys.exit(1)

STORE.write_text(json.dumps({
    "client_id": CLIENT_ID, "client_secret": client_secret(),
    "refresh_token": tok["refresh_token"], "access_token": tok["access_token"],
    "expires_in": tok.get("expires_in", 3600),
}), encoding="utf-8")
print("Вход выполнен. Токен сохранён в", STORE.name)

H = {"Authorization": f"Bearer {tok['access_token']}", "Content-Type": "application/json"}
r = S.post("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", headers=H,
           json={"metadata": {"ideType": "IDE_UNSPECIFIED", "platform": "PLATFORM_UNSPECIFIED",
                              "pluginType": "GEMINI"}})
print("\nloadCodeAssist:", r.status_code)
print(json.dumps(r.json(), ensure_ascii=False, indent=1)[:1200])