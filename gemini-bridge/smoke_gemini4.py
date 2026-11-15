"""One bounded Gemini4 request; refuses absent models and never substitutes Lite.

Uses the local bridge only; no API keys or paid services. Success checks a
fresh nonce in the reply, not the model's self-reported identity. Registry
identity is transport evidence, not independent proof of server model weights.
"""
import argparse
import json
import secrets
import sys
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="gemini-4-hydrogen")
    parser.add_argument("--timeout", type=int, default=150)
    parser.add_argument("--no-thinking", action="store_true")
    args = parser.parse_args()
    if args.model not in ("gemini-4-hydrogen", "gemini-4-argon", "gemini-4-carbon"):
        parser.error("Only explicit Gemini4 families are allowed")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open("http://127.0.0.1:8010/v1/models", timeout=15) as response:
        catalog = json.load(response)
    row = next((r for r in catalog.get("data", []) if r.get("id") == args.model and r.get("available")), None)
    if not row:
        print(json.dumps({"status": "blocked", "reason": "model_not_in_web_catalog", "requested_model": args.model,
                          "account_models": catalog.get("account_models", [])}))
        return 2
    nonce = "bridge-" + secrets.token_hex(6)
    payload = {"model": args.model + ("@think=false" if args.no_thinking else ""), "messages": [{"role": "user", "content": "Reply with exactly: " + nonce}],
               "stream": False, "max_tokens": 64}
    request = urllib.request.Request("http://127.0.0.1:8010/v1/chat/completions",
                                     data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    try:
        with opener.open(request, timeout=max(15, min(args.timeout, 300))) as response:
            result = json.load(response)
    except urllib.error.HTTPError as exc:
        print(json.dumps({"status": "failed", "http_status": exc.code}))
        return 1
    except (urllib.error.URLError, TimeoutError):
        print(json.dumps({"status": "failed", "reason": "transport_timeout_or_connection_failure", "automatic_retry": False}))
        return 1
    text = ((result.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    same_model = result.get("model") == row.get("resolved_model")
    passed = nonce in text and same_model and not (result.get("bridge") or {}).get("fallback")
    print(json.dumps({"status": "passed" if passed else "failed", "requested_model": args.model,
                      "actual_model": result.get("model"), "nonce_received": nonce in text, "identity_matches_registry": same_model}))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
