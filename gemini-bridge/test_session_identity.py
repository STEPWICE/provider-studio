"""Offline tests for session identity: guest vs signed-in vs CAPTCHA.

The bridge once adopted guest cookies from a signed-out Chrome profile over a
working AI Pro session. These tests pin the behaviour that prevents it.
"""
import ast
import asyncio
import os
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, Optional
import unittest

from browser_session import inspect_app_page
from model_routing import selectable_models

SOURCE = Path(__file__).with_name("server.py").read_text(encoding="utf-8")
TREE = ast.parse(SOURCE)


def definitions(names, namespace):
    nodes = [node for node in TREE.body
             if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
    for node in nodes:
        node.decorator_list = []
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "server.py", "exec"), namespace)
    return namespace


class AppPageClassification(unittest.TestCase):
    def test_empty_account_field_is_a_guest(self):
        state = inspect_app_page('prefix "S06Grb":"","S6lZl":1 suffix')
        self.assertIs(state["authenticated"], False)
        self.assertEqual(state["reason"], "guest_session")

    def test_account_marker_is_signed_in(self):
        state = inspect_app_page('"S06Grb":"dev@example.com"')
        self.assertIs(state["authenticated"], True)
        self.assertEqual(state["account"], "dev@example.com")

    def test_sign_in_button_without_the_field_is_still_a_guest(self):
        state = inspect_app_page('<a aria-label="Sign in" href="https://accounts.google.com/ServiceLogin">')
        self.assertIs(state["authenticated"], False)

    def test_captcha_block_is_named_not_called_a_dead_cookie(self):
        state = inspect_app_page("unusual traffic from your computer network", 403)
        self.assertTrue(state["captcha"])
        self.assertEqual(state["reason"], "captcha")

    def test_unfamiliar_page_is_unknown_not_a_sign_out(self):
        self.assertIsNone(inspect_app_page("<html>something new</html>")["authenticated"])


class CookieAdoption(unittest.TestCase):
    def run_refresh(self, identity, harvested):
        stored = {}
        ns = definitions({"refresh_cookies_from_browser"}, dict(
            asyncio=asyncio, os=os, time=time, Optional=Optional,
            browser_debug_alive=lambda: True,
            harvest_cookies=lambda: harvested,
            probe_session=lambda *a, **k: identity,
            update_env_file=lambda psid=None, psidts=None: stored.update(psid=psid, psidts=psidts),
            reopen_saved_profile=lambda: True,
            bridge_state={}, GEMINI_PROXY=None,
            print=lambda *a, **k: None,
        ))
        os.environ["GEMINI_SECURE_1PSID"] = "old-psid"
        os.environ["GEMINI_SECURE_1PSIDTS"] = "old-psidts"
        adopted = asyncio.run(ns["refresh_cookies_from_browser"]())
        return adopted, stored, ns["bridge_state"] if "bridge_state" in ns else None

    def test_guest_cookies_are_refused(self):
        adopted, stored, _ = self.run_refresh(
            {"authenticated": False, "reason": "guest_session"},
            {"__Secure-1PSID": "guest-psid", "__Secure-1PSIDTS": "guest-psidts"})
        self.assertFalse(adopted)
        self.assertEqual(stored, {})
        self.assertEqual(os.environ["GEMINI_SECURE_1PSID"], "old-psid")

    def test_captcha_cookies_are_refused(self):
        adopted, stored, _ = self.run_refresh(
            {"authenticated": False, "reason": "captcha"},
            {"__Secure-1PSID": "blocked-psid"})
        self.assertFalse(adopted)
        self.assertEqual(stored, {})

    def test_signed_in_cookies_are_adopted(self):
        adopted, stored, _ = self.run_refresh(
            {"authenticated": True, "account": "dev@example.com", "reason": "account_email"},
            {"__Secure-1PSID": "good-psid", "__Secure-1PSIDTS": "good-psidts"})
        self.assertTrue(adopted)
        self.assertEqual(stored["psid"], "good-psid")

    def test_unknown_identity_does_not_block_recovery(self):
        adopted, stored, _ = self.run_refresh(
            {"authenticated": None, "reason": "probe_failed"},
            {"__Secure-1PSID": "maybe-psid"})
        self.assertTrue(adopted)
        self.assertEqual(stored["psid"], "maybe-psid")


class SuppressionUnlock(unittest.TestCase):
    def models(self):
        return [SimpleNamespace(model_name="gemini-flash-lite", is_available=True),
                SimpleNamespace(model_name="gemini-4-hydrogen", is_available=False),
                SimpleNamespace(model_name="gemini-pro", is_available=False)]

    def test_verified_account_unlocks_the_hidden_models(self):
        models = self.models()
        ns = definitions({"unlock_verified_models"}, dict(
            bridge_state={"session_identity": {"authenticated": True, "account": "d@e.com"}}))
        client = SimpleNamespace(list_models=lambda: models)
        self.assertEqual(ns["unlock_verified_models"](client), 2)
        self.assertEqual(len(selectable_models(models)), 3)

    def test_unverified_account_never_unlocks_anything(self):
        for identity in ({"authenticated": False}, {"authenticated": None}, {}):
            models = self.models()
            ns = definitions({"unlock_verified_models"}, dict(bridge_state={"session_identity": identity}))
            client = SimpleNamespace(list_models=lambda: models)
            self.assertEqual(ns["unlock_verified_models"](client), 0)
            self.assertEqual(len(selectable_models(models)), 1)


class Diagnosis(unittest.TestCase):
    def diagnose(self, identity, models):
        ns = definitions({"session_diagnosis"}, dict(
            Dict=Dict, Any=Any, selectable_models=selectable_models,
            bridge_state={"session_identity": identity},
            client_instance=SimpleNamespace(_running=True, list_models=lambda: models),
        ))
        return ns["session_diagnosis"]()

    def test_signed_out_names_login_as_the_action(self):
        result = self.diagnose({"authenticated": False, "reason": "guest_session"},
                               [SimpleNamespace(model_name="gemini-flash-lite", is_available=True)])
        self.assertEqual(result["problem"], "signed_out")
        self.assertIn("login.cmd", result["action"])

    def test_captcha_is_reported_as_captcha(self):
        result = self.diagnose({"authenticated": False, "reason": "captcha"}, [])
        self.assertEqual(result["problem"], "captcha")

    def test_healthy_session_has_no_problem(self):
        models = [SimpleNamespace(model_name=n, is_available=True)
                  for n in ("gemini-flash-lite", "gemini-4-hydrogen", "gemini-pro")]
        result = self.diagnose({"authenticated": True, "account": "d@e.com"}, models)
        self.assertIsNone(result["problem"])
        self.assertTrue(result["signed_in"])


if __name__ == "__main__":
    unittest.main()