"""Check the native Code Assist path: python codeassist_check.py <project-id>"""

import json
import sys

from codeassist import CodeAssist, build_request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

project = sys.argv[1] if len(sys.argv) > 1 else ""
ca = CodeAssist(project=project)

print("== token ==")
try:
    t = ca.token()
    print("  ok, len", len(t))
except Exception as e:
    print("  FAIL", e)
    sys.exit(1)

print("\n== onboard ==")
try:
    print(" ", json.dumps(ca.onboard(), ensure_ascii=False)[:300])
except Exception as e:
    print("  FAIL", e)

print("\n== status ==")
try:
    d = ca.status()
    print("  currentTier:", (d.get("currentTier") or {}).get("id"))
    print("  project:", d.get("cloudaicompanionProject"))
except Exception as e:
    print("  FAIL", e)

print("\n== models ==")
try:
    d = ca.models()
    names = [m.get("modelId") or m.get("name") for m in (d.get("models") or d.get("availableModels") or [])]
    print(" ", json.dumps(d, ensure_ascii=False)[:600] if not names else names[:20])
except Exception as e:
    print("  FAIL", e)

print("\n== native tool call ==")
tools = [{"type": "function", "function": {
    "name": "read_file", "description": "Read a file from disk",
    "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}}]
body = build_request(
    [{"role": "user", "content": "Read the file server.py using the read_file tool. Call the tool."}],
    tools=tools)
for model in ("gemini-2.5-flash", "gemini-3.1-pro", "gemini-2.5-pro"):
    try:
        text, calls = "", []
        for frame in ca.stream(model, body):
            for cand in frame.get("candidates", []):
                for part in (cand.get("content") or {}).get("parts", []):
                    if part.get("text"):
                        text += part["text"]
                    if part.get("functionCall"):
                        calls.append(part["functionCall"])
        print(f"  {model}: text={text[:60]!r} functionCall={json.dumps(calls, ensure_ascii=False)[:200]}")
        if calls:
            print("  >>> NATIVE FUNCTION CALLING WORKS")
            break
    except Exception as e:
        print(f"  {model}: FAIL {str(e)[:200]}")