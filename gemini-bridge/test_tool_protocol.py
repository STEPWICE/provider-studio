"""Offline tests for the text tool protocol and the prompt it builds.

server.py is not imported: it reads the live Google session at import time.
The real definitions are extracted from its AST and executed instead, so these
tests exercise the shipped code rather than a copy of it.
"""
import ast
import base64
import json
import os
import re
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Union
import unittest

SOURCE = Path(__file__).with_name("server.py").read_text(encoding="utf-8")
TREE = ast.parse(SOURCE)

WANTED_FUNCTIONS = {
    "normalize_stops", "output_limits", "repair_json", "match_tool_name",
    "extract_tool_calls", "strip_tool_call_blocks", "collect_tool_names",
    "safe_stream_prefix", "parse_openai_messages", "save_upload_bytes_to_disk",
    "detect_file_extension", "looks_like_stall", "nudge_budget",
    "is_google_glitch_text",
}
WANTED_CLASSES = {"ChatMessage"}
WANTED_CONSTANTS = {
    "ARG_KEYS", "TOOL_FENCE_TAGS", "XML_OPEN", "FENCE_BLOCK_RE",
    "MAX_PROMPT_CHARS", "MAX_REMOTE_MEDIA_BYTES", "UPLOAD_CACHE_DIR",
    "CONTINUE_NUDGES", "_STALL_MARKERS",
}


def load_namespace():
    import tempfile
    from pydantic import BaseModel

    nodes = []
    for node in TREE.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in WANTED_FUNCTIONS:
            node.decorator_list = []
            nodes.append(node)
        elif isinstance(node, ast.ClassDef) and node.name in WANTED_CLASSES:
            node.decorator_list = []
            nodes.append(node)
        elif isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id in WANTED_CONSTANTS for t in node.targets):
            nodes.append(node)
    ns = dict(
        json=json, re=re, os=os, base64=base64, Path=Path, tempfile=tempfile,
        urllib=urllib, BaseModel=BaseModel, print=lambda *a, **k: None,
        Any=Any, Dict=Dict, List=List, Optional=Optional, Union=Union,
        uuid=__import__("uuid"),
    )
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "server.py", "exec"), ns)
    return ns


NS = load_namespace()
ChatMessage = NS["ChatMessage"]


def msg(role, content=None, **kw):
    return ChatMessage(role=role, content=content, **kw)


class OutputLimitTests(unittest.TestCase):
    def test_finished_answer_keeps_its_tail(self):
        text = "The answer is 42."
        cap, reason = NS["output_limits"](text, ["<|end|>"], None, complete=True)
        self.assertEqual(text[:cap], text)
        self.assertIsNone(reason)

    def test_partial_text_holds_back_a_split_stop(self):
        text = "answer<|en"
        cap, reason = NS["output_limits"](text, ["<|end|>"], None)
        self.assertLess(cap, len(text))
        self.assertIsNone(reason)

    def test_stop_wins_over_max_tokens_when_it_binds_first(self):
        cap, reason = NS["output_limits"]("abcSTOPdef", ["STOP"], 1000, complete=True)
        self.assertEqual(cap, 3)
        self.assertEqual(reason, "stop")

    def test_max_tokens_wins_when_it_binds_first(self):
        cap, reason = NS["output_limits"]("x" * 40 + "STOP", ["STOP"], 2, complete=True)
        self.assertEqual(cap, 8)
        self.assertEqual(reason, "length")


class ToolCallExtractionTests(unittest.TestCase):
    def test_no_argument_call_survives_next_to_a_call_with_arguments(self):
        text = (
            "```tool_call\n"
            '{"name": "write", "arguments": {"path": "a.txt", "content": "hi"}}\n'
            "```\n"
            "```tool_call\n"
            '{"name": "list_files"}\n'
            "```"
        )
        calls = NS["extract_tool_calls"](text, {"write", "list_files"})
        self.assertEqual({c["function"]["name"] for c in calls}, {"write", "list_files"})
        empty = next(c for c in calls if c["function"]["name"] == "list_files")
        self.assertEqual(json.loads(empty["function"]["arguments"]), {})

    def test_config_sample_is_still_not_a_tool_call(self):
        text = '```json\n{"name": "my-app", "version": "1.0.0"}\n```'
        self.assertIsNone(NS["extract_tool_calls"](text, {"write", "read"}))
        self.assertEqual(NS["strip_tool_call_blocks"](text, {"write", "read"}), text.strip())

    def test_unknown_tool_name_is_never_executed(self):
        for text in ('```json\n{"name": "my-app", "arguments": {}}\n```',
                     '```tool_call\n{"name": "drop_table", "arguments": {}}\n```'):
            self.assertIsNone(NS["extract_tool_calls"](text, {"list_files", "read"}))


class PromptHistoryTests(unittest.TestCase):
    def test_tool_result_is_labelled_with_the_tool_name_not_the_id(self):
        messages = [
            msg("user", "read the file"),
            msg("assistant", None, tool_calls=[
                {"id": "call_aaa", "type": "function",
                 "function": {"name": "read", "arguments": '{"path": "a.txt"}'}}]),
            msg("tool", "file body", tool_call_id="call_aaa"),
        ]
        prompt, _ = NS["parse_openai_messages"](messages, None)
        self.assertIn("Tool Result (read, call: call_aaa): file body", prompt)
        self.assertNotIn("Tool Result (call_aaa", prompt)

    def test_parallel_results_keep_their_own_identity(self):
        messages = [
            msg("user", "read both"),
            msg("assistant", None, tool_calls=[
                {"id": "call_1", "type": "function",
                 "function": {"name": "read", "arguments": '{"path": "a"}'}},
                {"id": "call_2", "type": "function",
                 "function": {"name": "bash", "arguments": '{"command": "ls"}'}}]),
            msg("tool", "AAA", tool_call_id="call_1"),
            msg("tool", "BBB", tool_call_id="call_2"),
        ]
        prompt, _ = NS["parse_openai_messages"](messages, None)
        self.assertIn("Tool Result (read, call: call_1): AAA", prompt)
        self.assertIn("Tool Result (bash, call: call_2): BBB", prompt)

    def test_explicit_tool_name_still_wins(self):
        messages = [msg("tool", "out", name="bash", tool_call_id="call_x")]
        prompt, _ = NS["parse_openai_messages"](messages, None)
        self.assertIn("Tool Result (bash, call: call_x): out", prompt)

    def test_history_tool_call_block_is_valid_json(self):
        messages = [
            msg("assistant", None, tool_calls=[
                {"id": "c1", "type": "function",
                 "function": {"name": 'odd"name', "arguments": '{"a": 1}'}}]),
        ]
        prompt, _ = NS["parse_openai_messages"](messages, None)
        block = prompt.split("```tool_call\n", 1)[1].split("\n```", 1)[0]
        self.assertEqual(json.loads(block)["name"], 'odd"name')


class ContinuationBudgetTests(unittest.TestCase):
    def test_completed_agent_turn_costs_at_most_one_extra_generation(self):
        answer = "Created hello.py and read it back. Its contents are print('BRIDGE-OK')."
        self.assertEqual(NS["nudge_budget"](answer, True), 1)

    def test_recognised_stall_keeps_the_full_budget(self):
        for stall in ("Here's the plan: first I would...", "I cannot access the filesystem.", ""):
            self.assertEqual(NS["nudge_budget"](stall, True), NS["CONTINUE_NUDGES"])

    def test_plain_user_turn_is_never_nudged(self):
        self.assertEqual(NS["nudge_budget"]("Paris is the capital of France.", False), 0)

    def test_stalled_user_turn_is_still_rescued(self):
        self.assertEqual(NS["nudge_budget"]("Would you like me to proceed?", False),
                         NS["CONTINUE_NUDGES"])

    def test_invented_tool_budget_is_treated_as_a_stall(self):
        # Seen live from gemini-4-hydrogen while OpenCode was still offering all
        # 12 tools with no tool_choice: the claim is a refusal, not a real limit.
        for excuse in (
            "I ran out of tool calls before executing the script.",
            "The environment reported that the maximum number of tool calls has been exceeded (0 remaining).",
            "Tool execution is currently disabled in this environment (0 tool calls remaining).",
            "The maximum steps for this agent have been reached.",
        ):
            self.assertTrue(NS["looks_like_stall"](excuse), excuse)
            self.assertEqual(NS["nudge_budget"](excuse, True), NS["CONTINUE_NUDGES"], excuse)

    def test_a_real_tool_call_is_never_a_stall(self):
        self.assertFalse(NS["looks_like_stall"](
            'Done.\n```tool_call\n{"name": "bash", "arguments": {"command": "ls"}}\n```'))


class CannedNonAnswerTests(unittest.TestCase):
    def test_web_refusal_shell_is_recognised(self):
        # Observed live: HTTP 200, finish_reason "stop", 7 chunks, and the agent
        # treated this as the model's final answer to a coding task.
        refusal = ("I'm having a hard time fulfilling your request. "
                   "Can I help you with something else instead?")
        self.assertTrue(NS["is_google_glitch_text"](refusal))

    def test_transient_error_pages_are_recognised(self):
        for glitch in ("Something went wrong, please try again.",
                       "Gemini is temporarily unavailable."):
            self.assertTrue(NS["is_google_glitch_text"](glitch))

    def test_real_answer_about_errors_is_left_alone(self):
        answer = ("If an error occurred, please try again after checking the log. "
                  "Here is the handler:\n```python\ntry:\n    run()\nexcept Exception:\n"
                  "    log.exception('failed')\n```")
        self.assertFalse(NS["is_google_glitch_text"](answer))

    def test_long_prose_is_never_a_glitch(self):
        self.assertFalse(NS["is_google_glitch_text"](
            "Please try again later if the build fails. " + "context " * 60))

    def test_empty_reply_is_not_a_glitch(self):
        self.assertFalse(NS["is_google_glitch_text"](""))


class TextOnlyTurnTests(unittest.TestCase):
    def test_turn_without_tools_does_not_claim_tool_access(self):
        prompt, _ = NS["parse_openai_messages"]([msg("user", "What is 2+2?")], None)
        self.assertNotIn("workspace tools listed below", prompt)
        self.assertNotIn("Available tools:", prompt)
        self.assertIn("answer in text", prompt)

    def test_turn_with_tools_still_advertises_them(self):
        tools = [{"type": "function", "function": {"name": "read",
                 "parameters": {"type": "object", "properties": {"path": {"type": "string"}},
                                "required": ["path"]}}}]
        prompt, _ = NS["parse_openai_messages"]([msg("user", "read a.txt")], tools)
        self.assertIn("workspace tools listed below", prompt)
        self.assertIn("Available tools:", prompt)

    def test_instruction_never_names_the_failure_it_forbids(self):
        tools = [{"type": "function", "function": {"name": "read",
                 "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}}}]
        prompt, _ = NS["parse_openai_messages"]([msg("user", "read a.txt")], tools)
        lowered = prompt.lower()
        for priming in ("no limit on tool calls", "0 tool calls", "step budget", "tools are disabled"):
            self.assertNotIn(priming, lowered)


class ContextTruncationTests(unittest.TestCase):
    def setUp(self):
        self._limit = NS["MAX_PROMPT_CHARS"]

    def tearDown(self):
        NS["MAX_PROMPT_CHARS"] = self._limit

    def test_truncation_never_leaves_an_orphan_tool_result(self):
        NS["MAX_PROMPT_CHARS"] = 4000
        messages = [msg("user", "start")]
        for i in range(40):
            messages.append(msg("assistant", None, tool_calls=[
                {"id": f"c{i}", "type": "function",
                 "function": {"name": "read", "arguments": json.dumps({"path": f"f{i}"})}}]))
            messages.append(msg("tool", "x" * 400, tool_call_id=f"c{i}"))
        prompt, _ = NS["parse_openai_messages"](messages, None)
        body = prompt.split("### System Instructions:", 1)[-1]
        first_turn = next((line for line in body.splitlines()
                           if line.startswith(("User:", "Assistant:", "Tool Result (", "["))), "")
        self.assertFalse(first_turn.startswith("Tool Result ("), first_turn)

    def test_two_huge_turns_are_still_capped(self):
        NS["MAX_PROMPT_CHARS"] = 5000
        messages = [msg("user", "u" * 20000), msg("tool", "t" * 20000, name="read")]
        prompt, _ = NS["parse_openai_messages"](messages, None)
        self.assertLessEqual(len(prompt), 5000)
        self.assertIn("trimmed to fit", prompt)


if __name__ == "__main__":
    unittest.main()