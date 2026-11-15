"""Automatic exit-node pool for the Gemini bridge, built on v2rayN's own cores.

Google throttles the exit IP, not the account: the same cookies generate fine
through one node and answer 429 through another. The bridge therefore cannot
depend on whichever node v2rayN happens to have selected. This module reads the
node profiles v2rayN already stores (read-only), starts a private Xray process
with one local inbound per candidate and probes each exit against
gemini.google.com. The bridge then points GEMINI_PROXY at the exit that actually
answers.

Hard rules:
- v2rayN's database, config and active node are never written to.
- Node UUIDs/passwords never leave this module: statuses expose labels,
  countries, latency and exit IPs only.
- The generated Xray config contains credentials, so it lives in .vpn-pool/,
  which is gitignored.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import re
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

# v2rayN EConfigType values that the bundled Xray can serve. 7 is Hysteria2
# (sing-box only) and is skipped on purpose.
SUPPORTED_CONFIG_TYPES = {1: "vmess", 3: "shadowsocks", 5: "vless", 6: "trojan"}

GEMINI_PROBE_URL = "https://gemini.google.com/app"
IP_PROBE_URL = "https://api.ipify.org?format=json"

# An authenticated Gemini app page is ~900 KB. A sign-in/consent page is much
# smaller, so body size separates "the session works through this exit" from
# "Google answered 200 with a login form".
MIN_GEMINI_BODY = 300_000


class VpnUnavailable(RuntimeError):
    """Raised when the v2rayN installation or its Xray binary cannot be used."""


@dataclass
class Node:
    index_id: int
    config_type: int
    remarks: str
    address: str
    port: int
    network: str
    security: str
    country: str
    password: str = field(default="", repr=False)
    sni: str = ""
    fingerprint: str = ""
    public_key: str = field(default="", repr=False)
    short_id: str = field(default="", repr=False)
    spider_x: str = ""
    allow_insecure: bool = False
    alpn: str = ""
    proto: Dict[str, Any] = field(default_factory=dict, repr=False)
    trans: Dict[str, Any] = field(default_factory=dict, repr=False)

    @property
    def label(self) -> str:
        return self.remarks or f"{self.address}:{self.port}"


def _json_dict(raw: Any) -> Dict[str, Any]:
    if not raw:
        return {}
    try:
        value = json.loads(raw)
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def country_from_remarks(remarks: str) -> str:
    """Extracts the ISO country from the flag emoji v2rayN puts in Remarks."""
    letters: List[str] = []
    for ch in remarks or "":
        code = ord(ch)
        if 0x1F1E6 <= code <= 0x1F1FF:
            letters.append(chr(ord("A") + code - 0x1F1E6))
            if len(letters) == 2:
                return "".join(letters)
        else:
            letters.clear()
    return ""


def _is_loopback_or_private(host: str) -> bool:
    host = (host or "").strip().lower()
    if not host:
        return True
    if host in ("localhost", "127.0.0.1", "::1"):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback or ip.is_link_local


def find_v2rayn_home(explicit: Optional[str] = None) -> Optional[Path]:
    """Locates a v2rayN install that has both guiNDB.db and the Xray core.

    v2rayN runs elevated here, so its ExecutablePath/CommandLine are unreadable.
    Discovery therefore goes through V2RAYN_HOME, the usual install roots and a
    bounded scan of the user's Desktop/Downloads/Programs folders.
    """
    candidates: List[Path] = []
    for raw in (explicit, os.getenv("V2RAYN_HOME"), os.getenv("V2RAYN_PATH")):
        if raw:
            candidates.append(Path(raw).expanduser())

    home = Path.home()
    for root in (
        home / "Desktop" / "Programms",
        home / "Desktop" / "Programs",
        home / "Desktop",
        home / "Downloads",
        home / "Programs",
        Path(os.getenv("LOCALAPPDATA", home)) / "Programs",
        Path("C:/Program Files"),
        Path("C:/Program Files (x86)"),
    ):
        try:
            if root.is_dir():
                for child in root.iterdir():
                    if child.is_dir() and "v2ray" in child.name.lower():
                        candidates.append(child)
                        # The launcher layout keeps the real app one level down.
                        for grandchild in child.iterdir():
                            if grandchild.is_dir() and grandchild.name.lower() in ("app", "v2rayn"):
                                candidates.append(grandchild)
        except OSError:
            continue

    def valid(path: Path) -> bool:
        try:
            return ((path / "guiConfigs" / "guiNDB.db").is_file()
                    and (path / "bin" / "xray" / "xray.exe").is_file())
        except OSError:
            return False

    for path in candidates:
        if valid(path):
            return path

    # Last resort: shallow scan of Desktop/Downloads for v2rayN.exe.
    for root in (home / "Desktop", home / "Downloads"):
        if not root.is_dir():
            continue
        root_depth = len(root.parts)
        try:
            for dirpath, dirnames, filenames in os.walk(root):
                depth = len(Path(dirpath).parts) - root_depth
                if depth > 3:
                    dirnames[:] = []
                    continue
                if "v2rayN.exe" in filenames and valid(Path(dirpath)):
                    return Path(dirpath)
        except OSError:
            continue
    return None


class VpnPool:
    """Owns a private Xray process and its candidate inbounds."""

    def __init__(
        self,
        base_dir: Path,
        log: Optional[Callable[..., Any]] = None,
        v2rayn_home: Optional[str] = None,
        size: int = 10,
        probe_timeout: float = 12.0,
        probe_concurrency: int = 6,
        prefer_countries: str = "SE,FI,CH,FR,PL,DE,NL,GB,CA,US",
        min_body: int = MIN_GEMINI_BODY,
        preferred_index: Optional[int] = None,
    ) -> None:
        self.base_dir = Path(base_dir)
        self.work_dir = self.base_dir / ".vpn-pool"
        self.state_path = self.work_dir / "state.json"
        self.config_path = self.work_dir / "xray.json"
        self.log_path = self.work_dir / "xray.log"
        self._log = log or print
        self._explicit_home = v2rayn_home
        self.size = max(1, int(size))
        self.probe_timeout = float(probe_timeout)
        self.probe_concurrency = max(1, int(probe_concurrency))
        self.prefer_countries = [c.strip().upper() for c in prefer_countries.split(",") if c.strip()]
        self.min_body = int(min_body)
        self.preferred_index = preferred_index

        self.home: Optional[Path] = None
        self.xray_path: Optional[Path] = None
        self.nodes: List[Node] = []
        self.proc: Optional[subprocess.Popen] = None
        self.ports: Dict[int, Node] = {}
        self.created_at: Optional[float] = None
        self.last_error: Optional[str] = None
        self._starting = False

    # ------------------------------------------------------------- discovery
    def _resolve_home(self, force: bool = False) -> Path:
        if self.home is not None and not force:
            return self.home
        path = find_v2rayn_home(self._explicit_home)
        if path is None:
            raise VpnUnavailable(
                "v2rayN не найден. Укажите V2RAYN_HOME в .env — папку, где лежат "
                "guiConfigs\\guiNDB.db и bin\\xray\\xray.exe."
            )
        self.home = path
        self.xray_path = path / "bin" / "xray" / "xray.exe"
        return path

    def _load_nodes(self) -> List[Node]:
        home = self._resolve_home()
        db_path = home / "guiConfigs" / "guiNDB.db"
        last_error: Optional[Exception] = None

        # v2rayN may be writing to the DB at this exact moment. A read-only
        # connection normally works; if SQLite refuses it, fall back to a
        # temporary copy so the bridge never blocks the live UI.
        for attempt in range(2):
            try:
                if attempt == 0:
                    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=3)
                else:
                    tmp = Path(tempfile.gettempdir()) / f"guiNDB-{os.getpid()}.db"
                    tmp.write_bytes(db_path.read_bytes())
                    con = sqlite3.connect(str(tmp))
                con.row_factory = sqlite3.Row
                try:
                    rows = list(con.execute("SELECT * FROM ProfileItem"))
                finally:
                    con.close()
                break
            except Exception as exc:  # noqa: BLE001 - report discovery failure to caller
                last_error = exc
        else:
            raise VpnUnavailable(f"Не удалось прочитать профили v2rayN: {last_error}")

        nodes: List[Node] = []
        for row in rows:
            try:
                ctype = int(row["ConfigType"] or 0)
                if ctype not in SUPPORTED_CONFIG_TYPES:
                    continue
                address = str(row["Address"] or "").strip()
                port = int(row["Port"] or 0)
                if not address or not 1 <= port <= 65535 or _is_loopback_or_private(address):
                    continue
                network = (row["Network"] or "raw").strip().lower()
                if network == "tcp":
                    network = "raw"
                proto = _json_dict(row["ProtoExtra"])
                trans = _json_dict(row["TransportExtra"])
                remarks = str(row["Remarks"] or "").strip()
                nodes.append(Node(
                    index_id=int(row["IndexId"]),
                    config_type=ctype,
                    remarks=remarks,
                    address=address,
                    port=port,
                    network=network or "raw",
                    security=(row["StreamSecurity"] or "none").strip().lower(),
                    country=country_from_remarks(remarks),
                    password=str(row["Password"] or row["Id"] or ""),
                    sni=str(row["Sni"] or ""),
                    fingerprint=str(row["Fingerprint"] or ""),
                    public_key=str(row["PublicKey"] or ""),
                    short_id=str(row["ShortId"] or ""),
                    spider_x=str(row["SpiderX"] or ""),
                    allow_insecure=bool(row["AllowInsecure"]),
                    alpn=str(row["Alpn"] or ""),
                    proto=proto,
                    trans=trans,
                ))
            except Exception:
                continue
        return nodes

    def _select_candidates(self, nodes: Iterable[Node]) -> List[Node]:
        """Picks a small, diverse set: preferred regions, one per address first."""
        priority = {code: i for i, code in enumerate(self.prefer_countries)}

        def sort_key(node: Node) -> Tuple[int, int, str, int]:
            if self.preferred_index and node.index_id == self.preferred_index:
                index_rank = -1
            else:
                index_rank = priority.get(node.country, len(priority) + 1)
            # Non-Reality/TLS plain nodes are usually the least reliable.
            security_rank = 0 if node.security in ("reality", "tls") else 1
            return (index_rank, security_rank, node.remarks, node.port)

        ordered = sorted(nodes, key=sort_key)
        selected: List[Node] = []
        seen_addresses = set()
        for node in ordered:  # first pass: one profile per address
            key = node.address.lower()
            if key in seen_addresses:
                continue
            seen_addresses.add(key)
            selected.append(node)
            if len(selected) >= self.size:
                return selected
        for node in ordered:  # second pass: fill remaining slots
            if node in selected:
                continue
            selected.append(node)
            if len(selected) >= self.size:
                break
        return selected

    # ------------------------------------------------------------ xray config
    @staticmethod
    def _outbound(node: Node, tag: str) -> Optional[Dict[str, Any]]:
        ctype = node.config_type
        outbound: Dict[str, Any] = {"tag": tag, "protocol": "", "settings": {}}

        if ctype == 5:
            outbound["protocol"] = "vless"
            user = {
                "id": node.password,
                "encryption": node.proto.get("VlessEncryption") or "none",
            }
            flow = node.proto.get("Flow")
            if flow:
                user["flow"] = flow
            outbound["settings"] = {"vnext": [{
                "address": node.address, "port": node.port, "users": [user],
            }]}
        elif ctype == 1:
            outbound["protocol"] = "vmess"
            outbound["settings"] = {"vnext": [{
                "address": node.address, "port": node.port,
                "users": [{
                    "id": node.password,
                    "alterId": int(node.proto.get("AlterId") or 0),
                    "security": node.proto.get("VmessSecurity") or "auto",
                }],
            }]}
        elif ctype == 3:
            outbound["protocol"] = "shadowsocks"
            outbound["settings"] = {"servers": [{
                "address": node.address, "port": node.port,
                "method": node.proto.get("SsMethod") or "chacha20-ietf-poly1305",
                "password": node.password,
            }]}
        elif ctype == 6:
            outbound["protocol"] = "trojan"
            outbound["settings"] = {"servers": [{
                "address": node.address, "port": node.port, "password": node.password,
            }]}
        else:
            return None

        stream: Dict[str, Any] = {"network": node.network or "raw"}

        if node.security == "reality":
            stream["security"] = "reality"
            stream["realitySettings"] = {
                "serverName": node.sni or node.trans.get("Host") or "",
                "fingerprint": node.fingerprint or "chrome",
                "publicKey": node.public_key,
                "shortId": node.short_id,
                "spiderX": node.spider_x or "/",
            }
        elif node.security == "tls":
            stream["security"] = "tls"
            tls: Dict[str, Any] = {
                "serverName": node.sni or node.trans.get("Host") or "",
                "allowInsecure": node.allow_insecure,
                "fingerprint": node.fingerprint or "chrome",
            }
            if node.alpn:
                tls["alpn"] = [a.strip() for a in node.alpn.split(",") if a.strip()]
            stream["tlsSettings"] = tls
        else:
            stream["security"] = "none"

        network = node.network
        if network == "ws":
            stream["wsSettings"] = {
                "path": node.trans.get("Path") or "/",
                "headers": {"Host": node.trans.get("Host") or node.sni or ""},
            }
        elif network == "grpc":
            stream["grpcSettings"] = {
                "serviceName": node.trans.get("Path") or "",
            }
        elif network == "raw":
            header_type = (node.trans.get("RawHeaderType") or "none").lower()
            if header_type not in ("", "none"):
                header: Dict[str, Any] = {"type": header_type}
                if header_type == "http":
                    header["request"] = {
                        "path": [node.trans.get("Path") or "/"],
                        "headers": {"Host": [node.trans.get("Host") or node.sni or ""]},
                    }
                stream["rawSettings"] = {"header": header}

        outbound["streamSettings"] = stream
        return outbound

    def _build_config(self, nodes: List[Node]) -> Tuple[Dict[str, Any], Dict[int, Node]]:
        inbounds: List[Dict[str, Any]] = []
        outbounds: List[Dict[str, Any]] = []
        rules: List[Dict[str, Any]] = []
        ports: Dict[int, Node] = {}

        for i, node in enumerate(nodes):
            port = self._free_port()
            in_tag = f"in_{i}"
            out_tag = f"out_{i}"
            outbound = self._outbound(node, out_tag)
            if outbound is None:
                continue
            inbounds.append({
                "tag": in_tag,
                "listen": "127.0.0.1",
                "port": port,
                "protocol": "mixed",
                "settings": {"auth": "noauth", "udp": False},
            })
            outbounds.append(outbound)
            rules.append({
                "type": "field",
                "inboundTag": [in_tag],
                "outboundTag": out_tag,
            })
            ports[port] = node

        if not inbounds:
            raise VpnUnavailable("В базе v2rayN нет узлов, которые умеет обслуживать Xray.")
        return {
            "log": {"loglevel": "warning"},
            "inbounds": inbounds,
            "outbounds": outbounds,
            "routing": {"domainStrategy": "AsIs", "rules": rules},
        }, ports

    @staticmethod
    def _free_port() -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return int(sock.getsockname()[1])

    def is_running(self) -> bool:
        return self._is_running()

    def _is_running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    # --------------------------------------------------------------- lifecycle
    def ensure_started(self, force: bool = False) -> bool:
        """Starts (or restarts) the private Xray. Returns True when it is up."""
        if self._is_running() and not force:
            return True
        self.stop()

        try:
            self._resolve_home(force=force)
            all_nodes = self._load_nodes()
            self.nodes = self._select_candidates(all_nodes)
            config, self.ports = self._build_config(self.nodes)
        except VpnUnavailable as exc:
            self.last_error = str(exc)
            self._log(f"[VPN] {exc}")
            return False
        except Exception as exc:  # noqa: BLE001 - never take the bridge down
            self.last_error = f"Не удалось собрать пул узлов: {exc}"
            self._log(f"[VPN] {self.last_error}")
            return False

        self.work_dir.mkdir(parents=True, exist_ok=True)
        self.config_path.write_text(
            json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
        try:
            self.log_path.write_text("", encoding="utf-8")
        except OSError:
            pass

        assert self.xray_path is not None
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
        try:
            stderr_file = open(self.log_path, "a", encoding="utf-8")
            self.proc = subprocess.Popen(
                [str(self.xray_path), "-c", str(self.config_path)],
                stdout=subprocess.DEVNULL,
                stderr=stderr_file,
                creationflags=creationflags,
            )
            self._stderr_file = stderr_file
        except Exception as exc:  # noqa: BLE001
            self.last_error = f"Xray не запустился: {exc}"
            self._log(f"[VPN] {self.last_error}")
            self.proc = None
            return False

        # Xray binds its inbounds in well under a second; poll instead of
        # sleeping a fixed amount so startup stays fast on a warm machine.
        deadline = time.time() + 8
        pending = set(self.ports)
        while pending and time.time() < deadline:
            for port in list(pending):
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.25):
                        pending.discard(port)
                except OSError:
                    continue
            if pending:
                time.sleep(0.1)

        if self.proc.poll() is not None or pending:
            detail = self._xray_error()
            self.last_error = f"Xray не поднял локальные порты{': ' + detail if detail else ''}"
            self._log(f"[VPN] {self.last_error}")
            self.stop()
            return False

        self.created_at = time.time()
        self.last_error = None
        self._log(f"[VPN] Приватный Xray поднят: {len(self.ports)} узлов "
                  f"на 127.0.0.1:{min(self.ports)}–{max(self.ports)}")
        return True

    def _xray_error(self) -> str:
        try:
            text = self.log_path.read_text(encoding="utf-8", errors="replace").strip()
            return text.splitlines()[-1][:200] if text else ""
        except OSError:
            return ""

    def stop(self) -> None:
        proc, self.proc = self.proc, None
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        stderr_file = getattr(self, "_stderr_file", None)
        if stderr_file is not None:
            try:
                stderr_file.close()
            except Exception:
                pass
            self._stderr_file = None
        self.ports = {}
        self.created_at = None

    # ----------------------------------------------------------------- probing
    async def probe(self, cookies: Optional[Dict[str, str]] = None,
                    exclude_ports: Optional[Iterable[int]] = None) -> List[Dict[str, Any]]:
        """Checks every candidate against the real Gemini endpoint."""
        if not self.ports:
            return []
        exclude = set(exclude_ports or ())
        ports = [p for p in self.ports if p not in exclude]
        semaphore = asyncio.Semaphore(self.probe_concurrency)

        async def one(port: int, node: Node) -> Dict[str, Any]:
            async with semaphore:
                result = await asyncio.to_thread(
                    self._probe_port, port, node, cookies or {})
            return result

        return list(await asyncio.gather(*(one(p, n) for p, n in ((p, self.ports[p]) for p in ports))))

    def _probe_port(self, port: int, node: Node, cookies: Dict[str, str]) -> Dict[str, Any]:
        proxy = f"http://127.0.0.1:{port}"
        result: Dict[str, Any] = {
            "port": port,
            "proxy": proxy,
            "index_id": node.index_id,
            "label": node.label,
            "country": node.country,
            "ok": False,
            "status": None,
            "body_bytes": 0,
            "latency_ms": None,
            "exit_ip": None,
            "error": None,
            "signed_in": None,
        }
        try:
            from curl_cffi import requests as curl_requests

            started = time.perf_counter()
            response = curl_requests.get(
                GEMINI_PROBE_URL,
                proxy=proxy,
                impersonate="chrome",
                cookies=cookies,
                timeout=self.probe_timeout,
                allow_redirects=False,
                verify=True,
            )
            result["latency_ms"] = int((time.perf_counter() - started) * 1000)
            result["status"] = response.status_code
            body = response.content or b""
            result["body_bytes"] = len(body)
            result["ok"] = (response.status_code == 200
                            and len(body) >= self.min_body)
            if not result["ok"] and response.status_code in (301, 302, 303, 307, 308):
                result["error"] = "redirect to sign-in"
            if result["ok"]:
                # Size alone cannot tell a signed-in page from a guest one: both
                # serve the full app shell. The body is already here, so reading
                # the account marker costs nothing and stops the pool from
                # choosing an exit where the session is actually guest level.
                from browser_session import inspect_app_page
                state = inspect_app_page(response.text or "", response.status_code)
                result["signed_in"] = state["authenticated"]
                if state["captcha"]:
                    result["ok"] = False
                    result["error"] = "captcha"
                elif state["authenticated"] is False:
                    result["error"] = "guest session"
        except Exception as exc:  # noqa: BLE001 - a dead node is expected
            result["error"] = _short_error(exc)
            return result

        if result["ok"]:
            try:
                from curl_cffi import requests as curl_requests
                ip_response = curl_requests.get(
                    IP_PROBE_URL,
                    proxy=proxy,
                    impersonate="chrome",
                    timeout=min(8.0, self.probe_timeout),
                    verify=True,
                )
                if ip_response.status_code == 200:
                    result["exit_ip"] = str(ip_response.json().get("ip") or "") or None
            except Exception:
                pass
        return result

    # ------------------------------------------------------------------ state
    def load_state(self) -> Dict[str, Any]:
        try:
            data = json.loads(self.state_path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def save_state(self, state: Dict[str, Any]) -> None:
        try:
            self.work_dir.mkdir(parents=True, exist_ok=True)
            tmp = self.state_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(self.state_path)
        except OSError:
            pass

    def public_state(self) -> Dict[str, Any]:
        return {
            "available": self.home is not None,
            "home": str(self.home) if self.home else None,
            "running": self._is_running(),
            "nodes": len(self.ports),
            "since": self.created_at,
            "last_error": self.last_error,
        }


def _short_error(exc: Exception) -> str:
    text = str(exc).replace("\n", " ").strip()
    match = re.search(r"curl: \((\d+)\)", text)
    if match:
        code = match.group(1)
        hint = "timeout" if code in ("28", "7") else "connection failed"
        return f"curl error {code} ({hint})"
    if "timed out" in text.lower():
        return "timeout"
    return text[:120]


def _main() -> int:
    """Manual probe: python vpn_pool.py [--size N] [--json]."""
    import argparse

    parser = argparse.ArgumentParser(description="Probe v2rayN exits against Gemini")
    parser.add_argument("--size", type=int, default=10)
    parser.add_argument("--timeout", type=float, default=12.0)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    base = Path(__file__).resolve().parent
    pool = VpnPool(base, size=args.size, probe_timeout=args.timeout)

    # Cookies are read from the same .env the bridge uses; the probe only needs
    # them to tell an authenticated page from a sign-in form.
    cookies: Dict[str, str] = {}
    env_path = base / ".env"
    if env_path.is_file():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            if not line or line.lstrip().startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key, value = key.strip(), value.strip()
            if key == "GEMINI_SECURE_1PSID":
                cookies["__Secure-1PSID"] = value
            elif key == "GEMINI_SECURE_1PSIDTS":
                cookies["__Secure-1PSIDTS"] = value

    if not pool.ensure_started():
        return 1
    try:
        results = asyncio.run(pool.probe(cookies))
    finally:
        pool.stop()

    results.sort(key=lambda r: (not r["ok"], r["latency_ms"] or 10**9))
    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        for result in results:
            state = "OK " if result["ok"] else "FAIL"
            print(f"{state} {result['country'] or '--':2} {result['label'][:34]:34} "
                  f"http={result['status']} body={result['body_bytes']:>7} "
                  f"ip={result['exit_ip'] or '-':15} {result['latency_ms'] or '-'}ms "
                  f"{result['error'] or ''}")
    return 0 if any(r["ok"] for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(_main())
