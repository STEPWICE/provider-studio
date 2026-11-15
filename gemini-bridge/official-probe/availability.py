"""Offline evidence summary. Menu visibility and process exit are not generation proof."""
import json
from pathlib import Path

TARGETS = {
    "Hydrogen": "gemini-4-hydrogen",
    "Argon": "gemini-4-argon",
    "Carbon": "gemini-4-carbon",
    "Orchestrator (Argon)": "orchestrator",
}
REGION_ERROR = "User location is not supported for the API use"


def load_reports(root):
    reports = []
    for path in (root / "results").glob("*.json"):
        try:
            report = json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            continue
        if isinstance(report, dict):
            reports.append((path.name, report))
    return sorted(reports, key=lambda item: (item[1].get("recorded_at", ""), item[0]))


def latest_models(reports):
    for _, report in reversed(reports):
        if report.get("command") == "models":
            # Never fall back to an older success after a failed refresh.
            if report.get("returncode") != 0:
                return None
            return [line.split("\t", 1)[0].strip()
                    for line in report.get("stdout", "").splitlines() if line.strip()]
    return None


def blocked_generation(reports):
    # Persistent precondition failures require human resolution, not proxy/retry loops.
    for filename, report in reversed(reports):
        if REGION_ERROR in report.get("stdout", "") + report.get("stderr", ""):
            return filename
    return None


def summarize(root):
    reports = load_reports(root)
    models = latest_models(reports)
    targets = {}
    for name, prefix in TARGETS.items():
        matches = [] if models is None else [m for m in models if (
            m == prefix or m.startswith(prefix + "-") or
            (name == "Orchestrator (Argon)" and "orchestrator" in m.lower() and "argon" in m.lower()))]
        # Generic orchestrator IDs do not establish which planner is available.
        if name == "Orchestrator (Argon)":
            matches = [m for m in matches if "argon" in m.lower()]
        targets[name] = {"cli_catalog": "unknown" if models is None else (
            "listed" if matches else "not_listed"), "identifiers": matches,
            "generation": "not_verified"}
    return {
        "scope": "official CLI diagnostics; not a third-party model provider",
        "web_screenshot": {"source": "user supplied; not a live generation test",
                           "Pro_badge": "visible", "Hydrogen": "selectable",
                           "Argon": "visible_without_lock", "Carbon": "locked"},
        "cli_models": models,
        "targets": targets,
        "account_matches_web": "not_verified",
        "region_failure_evidence": blocked_generation(reports),
        "generation_recheck": "requires explicit --recheck after access is resolved",
    }


def main():
    root = Path(__file__).resolve().parent
    report = summarize(root)
    directory = root / "results"
    directory.mkdir(exist_ok=True)
    (directory / "availability-latest.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report, indent=2, ensure_ascii=True))


if __name__ == "__main__":
    main()
