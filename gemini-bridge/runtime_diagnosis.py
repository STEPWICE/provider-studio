"""Print bounded, sanitized runtime diagnostics; never output raw logs or secrets."""
import json
from pathlib import Path


def main():
    path = Path(__file__).parent / "logs" / "bridge.log"
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()[-120:] if path.exists() else []
    words = ("429", "unauthenticated", "timeout", "certificate", "proxy", "location",
             "failed", "closed", "traceback", "success", "init", "модели", "авторизац", "ошибка")
    selected = []
    for line in lines:
        lower = line.lower()
        categories = [word for word in words if word in lower]
        if categories:
            selected.append({"at": line[:19] if line[:4].isdigit() else None, "categories": categories})
    from browser_session import browser_debug_alive
    print(json.dumps({"bridge_browser_open": browser_debug_alive(), "recent_events": selected[-10:]}, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
