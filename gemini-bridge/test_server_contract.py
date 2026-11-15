"""Offline contract tests execute actual endpoint definitions without importing
server.py (which reads the live session and initializes runtime state).
Google generation is replaced only here; live smoke scripts test it separately.
"""
import ast
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

from fastapi import HTTPException
from pydantic import BaseModel
from model_routing import select_model, ModelSelectionError, model_catalog


SOURCE = Path(__file__).with_name("server.py").read_text(encoding="utf-8")
TREE = ast.parse(SOURCE)


def definitions(names, namespace):
    nodes = [node for node in TREE.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name in names]
    for node in nodes:
        node.decorator_list = []
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "server.py", "exec"), namespace)
    return namespace


class EndpointContracts(unittest.TestCase):
    def test_actual_catalog_endpoint_uses_shared_resolution(self):
        models = [SimpleNamespace(model_name="gemini-argon", aliases=["gemini-4-argon"], is_available=True)]
        ns = definitions({"list_models"}, {"client_instance": SimpleNamespace(_running=True, list_models=lambda: models), "model_catalog": model_catalog, "session_diagnosis": lambda: {"problem": None}})
        result = asyncio.run(ns["list_models"]())
        self.assertIn("gemini-4-argon", [row["id"] for row in result["data"]])
        self.assertNotIn("gemini-4-hydrogen", [row["id"] for row in result["data"]])

    def test_responses_keeps_actual_model(self):
        import time
        import uuid
        from typing import Dict, Any, List
        ns = definitions({"chat_result_to_response"}, dict(time=time, uuid=uuid, Dict=Dict, Any=Any, List=List))
        result = ns["chat_result_to_response"]({"model": "gemini-argon", "choices": [{"message": {"content": "OK"}}]}, "gemini-4-argon")
        self.assertEqual(result["model"], "gemini-argon")

    def test_same_family_refresh_returns_new_canonical_identity(self):
        ns = definitions({"resolve_available_model"}, {"select_model": select_model, "ModelSelectionError": ModelSelectionError, "HTTPException": HTTPException})
        new_client = SimpleNamespace(list_models=lambda: [SimpleNamespace(model_name="gemini-hydrogen", aliases=["gemini-4-hydrogen"], is_available=True)])
        self.assertEqual(ns["resolve_available_model"](new_client, "gemini-4-hydrogen"), "gemini-hydrogen")
        with self.assertRaises(HTTPException):
            ns["resolve_available_model"](new_client, "gemini-4-argon")

    def test_local_title_requires_explicit_local_model(self):
        function = next(node for node in TREE.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "chat_completions")
        assignment = next(node for node in function.body if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "is_title_request" for t in node.targets))
        code = compile(ast.Expression(assignment.value), "server.py", "eval")
        for requested in ("gemini-4-hydrogen", "gemini-4-argon", "invalid"):
            self.assertFalse(eval(code, {"req": SimpleNamespace(model=requested, tools=None), "last_user_text": "reply with only the title"}))
        self.assertTrue(eval(code, {"req": SimpleNamespace(model="gemini-local-title", tools=None), "last_user_text": "reply with only the title"}))

    def test_proxy_probe_requires_tls_verification(self):
        tree = ast.parse(Path(__file__).with_name("vpn_pool.py").read_text(encoding="utf-8"))
        calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "get" and isinstance(node.func.value, ast.Name) and node.func.value.id == "curl_requests"]
        self.assertEqual(len(calls), 2)
        for call in calls:
            verify = next(kw.value for kw in call.keywords if kw.arg == "verify")
            self.assertTrue(isinstance(verify, ast.Constant) and verify.value is True)


if __name__ == "__main__":
    unittest.main()
