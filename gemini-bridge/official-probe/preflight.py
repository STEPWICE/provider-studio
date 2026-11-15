"""Offline preflight for project-local settings only; never inspect account storage."""
import json
from pathlib import Path

root = Path(__file__).resolve().parent
settings = json.loads((root / "smoke-settings.json").read_text(encoding="utf-8"))
assert settings["modelProvider"] == ""
assert settings["useG1Credits"] is False
assert settings["toolPermission"] == "strict"
assert settings["allowNonWorkspaceAccess"] is False
print("PASS: account provider; extra AI credits disabled; strict tool permissions")
