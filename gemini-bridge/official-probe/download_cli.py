"""Portable copy from Google's official release manifest; no PATH/setup changes."""
import hashlib
import json
import os
import platform
from pathlib import Path
import tempfile
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, build_opener

ROOT = Path(__file__).resolve().parent
BASE = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app"


def download(proxy=None):
    if os.name != "nt" or platform.machine().lower() not in ("amd64", "arm64"):
        raise RuntimeError("This prototype supports Windows AMD64/ARM64 only")
    arch = "arm64" if platform.machine().lower() == "arm64" else "amd64"
    opener = build_opener(ProxyHandler({"https": proxy} if proxy else {}))
    with opener.open(f"{BASE}/manifests/windows_{arch}.json", timeout=45) as response:
        manifest = json.load(response)
    url = manifest["url"]
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname != "storage.googleapis.com":
        raise RuntimeError("Unexpected release host; manual review needed")
    expected = manifest["sha512"].lower()
    if len(expected) != 128 or any(c not in "0123456789abcdef" for c in expected):
        raise RuntimeError("Invalid SHA512 manifest")
    runtime = ROOT / ".runtime"
    runtime.mkdir(exist_ok=True)
    target = runtime / "agy.exe"
    if target.exists():
        if hashlib.sha512(target.read_bytes()).hexdigest() != expected:
            raise RuntimeError("Existing CLI differs from release; refusing overwrite")
        print("Existing CLI matches release")
        return
    # Each invocation owns its staging file; never delete another download.
    fd, name = tempfile.mkstemp(prefix="agy-", suffix=".download", dir=runtime)
    os.close(fd)
    staging = Path(name)
    try:
        digest = hashlib.sha512()
        size = 0
        with opener.open(url, timeout=90) as response, staging.open("wb") as output:
            if urlsplit(response.url).hostname != parsed.hostname:
                raise RuntimeError("Unexpected binary redirect")
            while block := response.read(1024 * 1024):
                size += len(block)
                if size > 500 * 1024 * 1024:
                    raise RuntimeError("Release size exceeds safety limit")
                digest.update(block)
                output.write(block)
        if digest.hexdigest() != expected:
            raise RuntimeError("SHA512 mismatch; binary will not be executed")
        staging.rename(target)
    finally:
        staging.unlink(missing_ok=True)
    receipt = {"version": manifest.get("version"), "url": url,
               "sha512": expected, "size": size, "source": BASE}
    (runtime / "release.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
    print(json.dumps({"downloaded": str(target), "version": receipt["version"],
                      "sha512_verified": True, "bytes": size}))


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--proxy", help="Explicit local proxy, used for download only")
    args = parser.parse_args()
    if args.proxy:
        value = urlsplit(args.proxy)
        if value.scheme != "http" or value.hostname not in ("localhost", "127.0.0.1"):
            parser.error("Only a loopback HTTP proxy is accepted")
    download(args.proxy)
