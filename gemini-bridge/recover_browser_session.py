"""Reopen only the bridge-owned saved Chrome profile; no automatic login."""
from browser_session import reopen_saved_profile


if __name__ == "__main__":
    if reopen_saved_profile():
        print("Saved bridge browser ready. No automatic login or credentials printed.")
    else:
        print("Saved browser unavailable. Use login.cmd for initial setup if needed.")
