"""Fetch the official installer for review, without executing it or reading tokens."""
import json
import os
from pathlib import Path
from urllib.request import urlopen

root = Path(__file__).resolve().parent
url = "https://antigravity.google/cli/install.ps1"
with urlopen(url, timeout=30) as response:
    if response.url != url:
        raise RuntimeError("Unexpected installer redirect")
    text = response.read(100_000).decode("utf-8-sig")
(root / "install-official.ps1.txt").write_text(text, encoding="utf-8")
app = Path(os.environ["LOCALAPPDATA"]) / "Programs/antigravity/resources/app/package.json"
if app.exists():
    package = json.loads(app.read_text(encoding="utf-8"))
    print(json.dumps({key: package.get(key) for key in ("name", "version")}, ensure_ascii=True))
print("Official installer saved for review; not executed.")
