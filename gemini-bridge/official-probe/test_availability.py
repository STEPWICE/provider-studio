"""Evidence and retry safety, independent of any real account or model."""
import json
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

import availability
import probe


class AvailabilityTests(unittest.TestCase):
    def test_catalog_does_not_prove_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "results").mkdir()
            (root / "results/models.json").write_text(json.dumps({
                "command": "models", "returncode": 0,
                "stdout": "gemini-4-hydrogen-high\tHydrogen\nOrchestrator (Argon)\tPlanner\n"}))
            report = availability.summarize(root)
        self.assertEqual(report["targets"]["Hydrogen"]["cli_catalog"], "listed")
        self.assertEqual(report["targets"]["Hydrogen"]["generation"], "not_verified")
        self.assertEqual(report["targets"]["Argon"]["cli_catalog"], "not_listed")
        self.assertEqual(report["targets"]["Orchestrator (Argon)"]["cli_catalog"], "listed")
        self.assertEqual(report["web_screenshot"]["Carbon"], "locked")

    def test_failed_refresh_does_not_reuse_stale_success(self):
        reports = [("old", {"command": "models", "returncode": 0, "stdout": "model"}),
                   ("new", {"command": "models", "returncode": 1})]
        self.assertIsNone(availability.latest_models(reports))

    def test_region_failure_blocks_before_subprocess(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "results").mkdir()
            (root / "results/error.json").write_text(json.dumps({
                "command": "smoke", "stderr": availability.REGION_ERROR}))
            with patch.object(probe, "ROOT", root), patch("probe.subprocess.run") as run:
                self.assertEqual(probe.run_diagnostic("smoke"), 1)
                run.assert_not_called()

    def test_generation_denied_without_fresh_catalog(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(probe, "ROOT", Path(directory)), patch("probe.subprocess.run") as run:
                self.assertEqual(probe.run_diagnostic("hydrogen", recheck=True), 1)
                run.assert_not_called()

    def test_settings_tampering_blocks_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "results").mkdir()
            (root / "results/models.json").write_text(json.dumps({"command": "models", "returncode": 0,
                "stdout": "gemini-4-hydrogen-high\tHydrogen"}))
            (root / "smoke-settings.json").write_text(json.dumps({"useG1Credits": True}))
            with patch.object(probe, "ROOT", root), patch("probe.subprocess.run") as run:
                self.assertEqual(probe.run_diagnostic("hydrogen", recheck=True), 1)
                run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
