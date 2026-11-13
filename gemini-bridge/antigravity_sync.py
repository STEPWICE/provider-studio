import os
import json
from pathlib import Path
import urllib.request

def get_antigravity_daemon_info():
    daemon_dir = Path.home() / ".gemini" / "antigravity" / "daemon"
    if not daemon_dir.exists():
        return None
    hub_files = [f for f in daemon_dir.glob("hub_*.json") if f.stat().st_size > 0]
    if not hub_files:
        return None
    # Sort by mtime descending
    newest = max(hub_files, key=lambda f: f.stat().st_mtime)
    try:
        data = json.loads(newest.read_text(encoding="utf-8"))
        return {
            "httpPort": data.get("httpPort"),
            "httpsPort": data.get("httpsPort"),
            "csrfToken": data.get("csrfToken"),
            "pid": data.get("pid")
        }
    except Exception:
        return None

def fetch_antigravity_live_quota():
    """Queries Antigravity local LanguageServer daemon via Connect-RPC for live user status and quota."""
    info = get_antigravity_daemon_info()
    if not info or not info.get("httpPort") or not info.get("csrfToken"):
        return None

    headers = {
        "x-codeium-csrf-token": info["csrfToken"],
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1"
    }

    port = info["httpPort"]
    # 1. Fetch User Quota Summary
    quota_res = {}
    try:
        url_q = f"http://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary"
        req_q = urllib.request.Request(url_q, data=b"{}", headers=headers, method="POST")
        with urllib.request.urlopen(req_q, timeout=3) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            groups = data.get("response", {}).get("groups", [])
            for g in groups:
                g_name = g.get("displayName", "")
                buckets = g.get("buckets", [])
                quota_res[g_name] = {}
                for b in buckets:
                    w = b.get("window", "")
                    rem_frac = b.get("remainingFraction", 1.0)
                    quota_res[g_name][w] = {
                        "remaining_pct": round(rem_frac * 100, 1),
                        "remaining_fraction": rem_frac,
                        "reset_time": b.get("resetTime")
                    }
    except Exception as ex:
        print("[ANTIGRAVITY-SYNC] RetrieveUserQuotaSummary error:", ex)
        return None

    # 2. Fetch User Status
    user_status = {}
    try:
        url_u = f"http://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/GetUserStatus"
        req_u = urllib.request.Request(url_u, data=b"{}", headers=headers, method="POST")
        with urllib.request.urlopen(req_u, timeout=3) as resp:
            u_data = json.loads(resp.read().decode("utf-8"))
            u_info = u_data.get("userStatus", {})
            user_status = {
                "name": u_info.get("name", "User"),
                "email": u_info.get("email", ""),
                "tier": u_info.get("planStatus", {}).get("planInfo", {}).get("planName", "Pro"),
            }
    except Exception as ex:
        print("[ANTIGRAVITY-SYNC] GetUserStatus error:", ex)

    return {
        "source": "antigravity_daemon",
        "port": port,
        "pid": info.get("pid"),
        "user": user_status,
        "quotas": quota_res
    }

if __name__ == "__main__":
    res = fetch_antigravity_live_quota()
    print("Live result:", json.dumps(res, indent=2, ensure_ascii=False))
