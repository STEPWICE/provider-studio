"""Live two-turn test with one real, read-only sandbox tool and SSE reasoning.

Never executes model-supplied commands or arbitrary paths. Consumes subscription
quota for two Hydrogen turns; no paid API or automatic retries.
"""
import json
from pathlib import Path
import secrets
import tempfile
import urllib.error
import urllib.request


OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def stream(messages, tools, forced=False):
    payload = {"model": "gemini-4-hydrogen-high", "messages": messages,
               "tools": tools, "stream": True, "max_tokens": 512,
               "tool_choice": "required" if forced else "auto"}
    request = urllib.request.Request("http://127.0.0.1:8010/v1/chat/completions",
                                     data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    text, thoughts, calls, model, finished = "", "", [], None, None
    with OPENER.open(request, timeout=150) as response:
        for line in response:
            if not line.startswith(b"data: "):
                continue
            data = line[6:].strip()
            if data == b"[DONE]":
                break
            event = json.loads(data)
            if event.get("error"):
                raise RuntimeError("upstream_stream_error")
            model = event.get("model", model)
            for choice in event.get("choices", []):
                delta = choice.get("delta") or {}
                text += delta.get("content") or ""
                thoughts += delta.get("reasoning_content") or ""
                calls.extend(delta.get("tool_calls") or [])
                finished = choice.get("finish_reason") or finished
    return text, thoughts, calls, model, finished


def main():
    nonce = "file-" + secrets.token_hex(8)
    with tempfile.TemporaryDirectory(prefix="bridge-smoke-") as directory:
        fixture = Path(directory) / "nonce.txt"
        fixture.write_text(nonce, encoding="utf-8")
        tools = [{"type": "function", "function": {"name": "read_fixture",
                  "description": "Read nonce.txt from the test sandbox. This is the only way to learn its contents.",
                  "parameters": {"type": "object", "properties": {"path": {"type": "string", "enum": ["nonce.txt"]}},
                                 "required": ["path"], "additionalProperties": False}}}]
        messages = [{"role": "user", "content": "Use read_fixture to read nonce.txt. Then reply with its exact contents, nothing else."}]
        text, thoughts, calls, actual, finish = stream(messages, tools, True)
        if actual != "gemini-4-hydrogen" or finish != "tool_calls" or len(calls) != 1:
            print(json.dumps({"status": "failed", "stage": "tool_call", "actual_model": actual,
                              "finish_reason": finish, "calls": len(calls)}))
            return 1
        call = calls[0]
        fn = call.get("function") or {}
        if fn.get("name") != "read_fixture" or json.loads(fn.get("arguments", "{}")) != {"path": "nonce.txt"}:
            print(json.dumps({"status": "failed", "stage": "tool_arguments"}))
            return 1
        # The only real tool operation permitted by this harness.
        result = fixture.read_text(encoding="utf-8")
        clean_call = {key: call[key] for key in ("id", "type", "function")}
        messages.extend([{"role": "assistant", "content": text or None, "tool_calls": [clean_call]},
                         {"role": "tool", "tool_call_id": call["id"], "content": result}])
        # No more tools on the final turn: this is intentionally a final answer.
        answer, more_thoughts, more_calls, final_model, final_finish = stream(messages, None)
        passed = nonce in answer and not more_calls and final_model == actual and final_finish == "stop"
        print(json.dumps({"status": "passed" if passed else "failed", "actual_model": actual,
                          "real_file_read": True, "tool_result_received": nonce in answer,
                          "reasoning_received": bool(thoughts or more_thoughts), "rounds": 2,
                          "tool_protocol": "text_emulation"}))
        return 0 if passed else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (urllib.error.URLError, TimeoutError, ValueError, RuntimeError) as exc:
        print(json.dumps({"status": "failed", "error_type": type(exc).__name__}))
        raise SystemExit(1)
