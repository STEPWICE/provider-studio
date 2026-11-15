"""Offline safety regressions; these do not simulate successful model generation."""
import hashlib
import io
import json
import os
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

import probe
import download_cli


class ProbeSafetyTests(unittest.TestCase):
    def test_secret_environment_not_forwarded(self):
        source = {"PATH": "runtime", "LOCALAPPDATA": "local", "GEMINI_API_KEY": "private",
                  "GOOGLE_APPLICATION_CREDENTIALS": "private.json", "AGY_ADC_AUTH": "true",
                  "HTTP_PROXY": "http://private", "HTTPS_PROXY": "http://private",
                  "ALL_PROXY": "private", "GOOGLE_GEMINI_BASE_URL": "https://private"}
        with patch.dict(os.environ, source, clear=True):
            env = probe.safe_environment()
        self.assertEqual(env["PATH"], "runtime")
        self.assertEqual(env["LOCALAPPDATA"], "local")
        self.assertNotIn("GEMINI_API_KEY", env)
        self.assertNotIn("GOOGLE_APPLICATION_CREDENTIALS", env)
        self.assertNotIn("AGY_ADC_AUTH", env)
        self.assertNotIn("HTTPS_PROXY", env)
        self.assertNotIn("GOOGLE_GEMINI_BASE_URL", env)

    def test_unknown_command_rejected_without_process(self):
        with patch("probe.subprocess.run") as run:
            with self.assertRaises(ValueError):
                probe.run_diagnostic("login")
            run.assert_not_called()

    def test_common_sensitive_output_redacted(self):
        text = probe.redact("name@example.com Bearer abcd123 ya29.private 1//private")
        for secret in ("name@example.com", "abcd123", "ya29.private", "1//private"):
            self.assertNotIn(secret, text)

    @unittest.skipUnless(os.name == "nt", "Windows portable downloader")
    def test_download_preserves_other_staging_file(self):
        payload = b"fixture-only-not-an-executable"
        url = "https://storage.googleapis.com/test/agy.exe"
        manifest = {"url": url, "version": "fixture",
                    "sha512": hashlib.sha512(payload).hexdigest()}
        response = io.BytesIO(payload)
        response.url = url
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = root / ".runtime"
            runtime.mkdir()
            other = runtime / "agy.download"
            other.write_bytes(b"another download owns this")
            with patch.object(download_cli, "ROOT", root), \
                 patch.object(download_cli.platform, "machine", return_value="AMD64"), \
                 patch.object(download_cli, "build_opener") as factory:
                factory.return_value.open.side_effect = [
                    io.BytesIO(json.dumps(manifest).encode()), response]
                download_cli.download()
            self.assertEqual(other.read_bytes(), b"another download owns this")
            self.assertEqual((runtime / "agy.exe").read_bytes(), payload)
            self.assertEqual(list(runtime.glob("agy-*.download")), [])

    def test_project_billing_and_permission_guards(self):
        settings = json.loads((probe.ROOT / "smoke-settings.json").read_text(encoding="utf-8"))
        self.assertEqual(settings["modelProvider"], "")
        self.assertIs(settings["useG1Credits"], False)
        self.assertEqual(settings["toolPermission"], "strict")
        self.assertFalse(settings["allowNonWorkspaceAccess"])
        for rule in ("command(*)", "write_file(*)", "mcp(*)"):
            self.assertIn(rule, settings["permissions"]["deny"])


if __name__ == "__main__":
    unittest.main()
