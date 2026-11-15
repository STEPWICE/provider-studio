"""Direct official CLI diagnostics, not a model provider or third-party agent wrapper."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
CLI = ROOT / ".runtime/agy.exe"


def redact(text):
    text = re.sub(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "[account-redacted]", text)
    text = re.sub(r"(?i)(Bearer\s+|ya29\.|1//)[A-Za-z0-9_.~+/=-]+", "[token-redacted]", text)
    text = re.sub(r"https://[^\s\"<>]*(?:oauth|accounts\.google)[^\s\"<>]*", "[auth-url-redacted]", text)
    return text


def safe_environment():
    # Never silently use an API key, ADC or a custom model endpoint/proxy.
    env = dict(os.environ)
    for key in list(env):
        if key.startswith(("GEMINI_", "GOOGLE_", "AGY_", "ANTHROPIC_", "OPENAI_")):
            env.pop(key)
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        env.pop(key, None)
    env["NO_COLOR"] = "1"
    return env


def run_diagnostic(command, recheck=False):
    if command not in ("version", "help", "models-help", "models", "smoke", "hydrogen"):
        raise ValueError("Diagnostic not allowlisted")
    # Account/config storage belongs to the official client; never read it here.
    args = {"version": ["--version"], "help": ["--help"],
            "models-help": ["models", "--help"], "models": ["models"],
            "smoke": [], "hydrogen": []}[command]
    if command in ("smoke", "hydrogen"):
        from availability import blocked_generation, latest_models, load_reports
        reports = load_reports(ROOT)
        blocker = blocked_generation(reports)
        if blocker and not recheck:
            print(json.dumps({"status": "blocked", "reason": "unresolved_region_precondition",
                              "evidence": blocker, "action": "Resolve official access before --recheck"}))
            return 1
        model = "gemini-4-hydrogen-high" if command == "hydrogen" else "gemini-3.8-flash-low"
        if model not in (latest_models(reports) or []):
            print(json.dumps({"status": "blocked", "reason": "model_not_in_latest_cli_catalog",
                              "model": model, "action": "Refresh models; do not guess aliases"}))
            return 1
        settings_path = ROOT / "smoke-settings.json"
        try:
            settings = json.loads(settings_path.read_text(encoding="utf-8"))
            safe = (settings.get("modelProvider") == "" and settings.get("useG1Credits") is False
                    and settings.get("toolPermission") == "strict"
                    and settings.get("allowNonWorkspaceAccess") is False
                    and {"command(*)", "read_file(*)", "write_file(*)", "read_url(*)",
                         "execute_url(*)", "mcp(*)"}.issubset(settings.get("permissions", {}).get("deny", [])))
        except (OSError, ValueError, AttributeError, TypeError):
            safe = False
        if not safe:
            print(json.dumps({"status": "blocked", "reason": "unsafe_or_missing_probe_settings"}))
            return 1
        args = ["-p", "Reply with exactly BRIDGE_PROBE_OK. Do not use any tools.",
                "--model", model, "--output-format", "stream-json",
                "--settings", str(ROOT / "smoke-settings.json"),
                "--disable-slash-commands", "--print-timeout", "45s"]
    sandbox = ROOT / "sandbox"
    sandbox.mkdir(exist_ok=True)
    # No TTY or stdin: do not run interactive login or grant tool permissions.
    try:
        result = subprocess.run([str(CLI), *args], cwd=sandbox, env=safe_environment(),
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=60)
        report = {"command": command, "returncode": result.returncode,
                  "stdout": redact(result.stdout.decode("utf-8", errors="replace")),
                  "stderr": redact(result.stderr.decode("utf-8", errors="replace"))}
    except subprocess.TimeoutExpired:
        report = {"command": command, "status": "timeout", "seconds": 60}
    directory = ROOT / "results"
    directory.mkdir(exist_ok=True)
    report["recorded_at"] = datetime.now(timezone.utc).isoformat()
    filename = f"{command}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')}.json"
    (directory / filename).write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=True, indent=2))
    return 0 if report.get("returncode") == 0 else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("version", "help", "models-help", "models", "smoke", "hydrogen"))
    parser.add_argument("--recheck", action="store_true",
                        help="Explicit retry after official regional access is resolved; never changes proxy")
    options = parser.parse_args()
    sys.exit(run_diagnostic(options.command, recheck=options.recheck))
