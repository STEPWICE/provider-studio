import unittest
from types import SimpleNamespace

from model_routing import ModelSelectionError, model_catalog, select_model


def model(name, aliases=(), available=True):
    return SimpleNamespace(model_name=name, aliases=aliases, is_available=available)


class RoutingTests(unittest.TestCase):
    def setUp(self):
        self.models = [model("gemini-hydrogen", ["gemini-4-hydrogen"]),
                       model("gemini-argon", ["gemini-4-argon"]),
                       model("gemini-carbon", ["gemini-4-carbon"]), model("gemini-flash-lite")]

    def test_argon_never_becomes_hydrogen(self):
        for name in ("gemini-4-argon", "gemini-4-argon-high", "gemini-argon"):
            self.assertEqual(select_model(self.models, name).model, "gemini-argon")

    def test_family_aliases(self):
        for family in ("hydrogen", "argon", "carbon"):
            selected = select_model(self.models, "gemini-4-" + family)
            self.assertEqual(selected.model, "gemini-" + family)

    def test_explicit_unavailable_does_not_fallback(self):
        with self.assertRaises(ModelSelectionError) as error:
            select_model([model("gemini-flash-lite")], "gemini-4-hydrogen")
        self.assertEqual(error.exception.code, "model_unavailable")

    def test_empty_registry_fails_closed(self):
        with self.assertRaises(ModelSelectionError) as error:
            select_model([], "gemini-4-hydrogen")
        self.assertEqual(error.exception.code, "model_catalog_unknown")

    def test_unknown_name_is_not_substring_routed(self):
        for name in ("fake-high", "not-a-pro", "gemini-4-argon-wrong", "fake-orchestrator"):
            with self.assertRaises(ModelSelectionError):
                select_model(self.models, name)

    def test_unselectable_is_not_advertised(self):
        catalog = model_catalog([model("gemini-argon", ["gemini-4-argon"], False)])
        self.assertEqual(catalog["data"], [])
        self.assertIn("gemini-4-argon", catalog["unavailable_models"])

    def test_thinking(self):
        self.assertTrue(select_model(self.models, "gemini-4-hydrogen-high").thinking)
        self.assertFalse(select_model(self.models, "gemini-4-argon-high@think=false").thinking)
        self.assertTrue(select_model(self.models, "gemini-4-hydrogen@think=true").thinking)
        self.assertFalse(select_model(self.models, "gemini-flash-lite").thinking)
        with self.assertRaises(ModelSelectionError):
            select_model(self.models, "gemini-4-hydrogen@think=garbage")

    def test_auto_depth_prefers_argon_and_does_not_require_carbon(self):
        selected = select_model(self.models, "gemini-orchestrator", "gemini-carbon")
        self.assertEqual(selected.model, "gemini-argon")
        self.assertTrue(selected.router)
        self.assertEqual(select_model(self.models[:1], "gemini-orchestrator", "gemini-carbon").model,
                         "gemini-hydrogen")

    def test_router_does_not_disguise_lite_as_gemini4(self):
        with self.assertRaises(ModelSelectionError):
            select_model([model("gemini-flash-lite")], "gemini-orchestrator")

    def test_catalog_discovers_unknown_canonical_ids(self):
        catalog = model_catalog(self.models + [model("gemini-future")])
        rows = {row["id"]: row for row in catalog["data"]}
        self.assertEqual(rows["gemini-4-argon"]["resolved_model"], "gemini-argon")
        self.assertFalse(rows["gemini-4-argon"]["generation_verified"])
        self.assertIn("gemini-future", rows)
        self.assertFalse(catalog["native_function_calling"])


if __name__ == "__main__":
    unittest.main()
