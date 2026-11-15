"""Inspect only non-secret fields of an already running local bridge.

By default no login, generation, proxy changes, or account changes are performed.
--refresh invokes the existing bridge's session recovery (including its proxy policy).
"""
import json
import urllib.error
import urllib.request


def main():
    # Explicitly bypass system proxies for the loopback diagnostic.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="Initialize the existing web session; no generation")
    parser.add_argument("--recover", action="store_true", help="Recover browser cookies through the running bridge; may send a ping")
    args = parser.parse_args()
    paths = ("/health", "/auth/refresh", "/v1/models") if args.recover else (("/health", "/v1/models/refresh", "/v1/models") if args.refresh else ("/health", "/v1/models"))
    for path in paths:
        try:
            req = urllib.request.Request("http://127.0.0.1:8010" + path, method="POST" if path.endswith("/refresh") else "GET")
            with opener.open(req, timeout=180 if (args.refresh or args.recover) else 15) as response:
                body = json.load(response)
            if path == "/health":
                state = body.get("bridge") or {}
                errors = " ".join(str(state.get(key) or "") for key in (
                    "last_auth_error", "last_rotation_error",
                )).lower()
                diagnostics = {
                    "inflight": state.get("inflight_requests"),
                    "uptime_seconds": state.get("uptime_seconds"),
                    "failure_categories": [word for word in (
                        "429", "unauthenticated", "cookie", "timeout", "certificate",
                        "proxy", "location", "403", "401", "failed",
                    ) if word in errors],
                }
                body = {key: body.get(key) for key in (
                    "version", "cookies_configured", "client_active", "account_status",
                    "active_models", "degraded",
                )}
                body["diagnostics"] = diagnostics
            else:
                body = {key: body.get(key) for key in ("known", "account_models", "data")}
            print(json.dumps({"path": path, "result": body}, ensure_ascii=True, indent=2))
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace").lower()
            print(json.dumps({"path": path, "status": exc.code, "failure_categories": [
                word for word in ("429", "unauthenticated", "cookie", "timeout", "certificate", "proxy", "location", "401", "403", "failed", "closed", "known model") if word in raw
            ]}))
        except (urllib.error.URLError, TimeoutError, ValueError):
            print(json.dumps({"path": path, "status": "unreachable_or_invalid_response"}))


if __name__ == "__main__":
    main()
