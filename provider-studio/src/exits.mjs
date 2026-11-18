// src/exits.mjs — пул «живых выходов»: отдельные xray-процессы на ноды v2rayN.
//
// Зачем: бесплатная квота Zen и региональные блокировки привязаны к exit IP.
// Когда текущий узел v2rayN умирает (или его IP выжжен толпой), шлюз должен
// сам поднять прокси через живую ноду VPNLiberty/Hynet и повторить запрос.
// Конфиги нод берутся из guiNDB.db самого v2rayN — подписки обновляются там,
// здесь ничего не дублируется. Секреты (UUID/пароли) остаются в локальных
// временных конфигах xray и наружу не печатаются.

import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import tls from "node:tls";

export const V2RAYN_DB = "C:/Users/STEPWICE/Desktop/Programms/Hynet V2rayN Launcher/app/guiConfigs/guiNDB.db";
export const XRAY_BIN = "C:/Users/STEPWICE/Desktop/Programms/Hynet V2rayN Launcher/app/bin/xray/xray.exe";

/** ConfigType v2rayN: 1 VMess, 3 SS, 5 VLESS, 6 Trojan — остальные не трогаем. */
const SUPPORTED = new Set([1, 3, 5, 6]);

function protoExtra(raw) {
  try { return JSON.parse(raw || "{}") || {}; } catch { return {}; }
}

export function loadNodes(dbPath = V2RAYN_DB) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT p.IndexId, p.ConfigType, p.Address, p.Port, p.Id, p.Password, p.AlterId, p.Security,
             p.Network, p.Remarks, p.StreamSecurity, p.AllowInsecure, p.Flow, p.Sni,
             p.Alpn, p.Fingerprint, p.PublicKey, p.ShortId, p.SpiderX, p.ProtoExtra, p.Subid,
             s.Remarks AS subRemarks, e.Delay AS lastDelay
      FROM ProfileItem p
      LEFT JOIN SubItem s ON s.Id = p.Subid
      LEFT JOIN ProfileExItem e ON e.IndexId = p.IndexId
    `).all();
    return rows
      .filter((r) => SUPPORTED.has(r.ConfigType) && r.Address && r.Port)
      .map((r) => ({
        id: r.IndexId,
        type: r.ConfigType,
        address: r.Address,
        port: r.Port,
        secret: r.Id || r.Password || "",
        alterId: r.AlterId || 0,
        security: r.Security || "",
        network: r.Network || "raw",
        remarks: r.Remarks || "",
        streamSecurity: r.StreamSecurity || "",
        allowInsecure: !!r.AllowInsecure,
        flow: r.Flow || protoExtra(r.ProtoExtra).Flow || "",
        sni: r.Sni || "",
        alpn: r.Alpn || "",
        fingerprint: r.Fingerprint || "chrome",
        publicKey: r.PublicKey || "",
        shortId: r.ShortId || "",
        spiderX: r.SpiderX || "",
        sub: r.subRemarks || "manual",
        lastDelay: r.lastDelay ?? -1,
      }));
  } finally {
    db.close();
  }
}

function streamSettings(node) {
  const s = {
    network: node.network === "tcp" ? "raw" : node.network,
    security: node.streamSecurity || "none",
  };
  if (node.streamSecurity === "reality") {
    s.realitySettings = {
      serverName: node.sni,
      fingerprint: node.fingerprint,
      publicKey: node.publicKey,
      shortId: node.shortId,
      spiderX: node.spiderX,
    };
  } else if (node.streamSecurity === "tls") {
    s.tlsSettings = {
      serverName: node.sni,
      allowInsecure: node.allowInsecure,
      fingerprint: node.fingerprint,
      alpn: node.alpn ? node.alpn.split(",").map((x) => x.trim()).filter(Boolean) : undefined,
    };
  }
  return s;
}

export function xrayConfigFor(node, port) {
  let outbound;
  if (node.type === 5) {
    outbound = {
      tag: "proxy",
      protocol: "vless",
      settings: { vnext: [{ address: node.address, port: node.port, users: [{ id: node.secret, encryption: "none", flow: node.flow }] }] },
    };
  } else if (node.type === 6) {
    outbound = {
      tag: "proxy",
      protocol: "trojan",
      settings: { servers: [{ address: node.address, port: node.port, password: node.secret }] },
    };
  } else if (node.type === 3) {
    outbound = {
      tag: "proxy",
      protocol: "shadowsocks",
      settings: { servers: [{ address: node.address, port: node.port, method: node.security, password: node.secret }] },
    };
  } else {
    outbound = {
      tag: "proxy",
      protocol: "vmess",
      settings: { vnext: [{ address: node.address, port: node.port, users: [{ id: node.secret, alterId: node.alterId, security: node.security || "auto" }] }] },
    };
  }
  outbound.streamSettings = streamSettings(node);
  outbound.mux = { enabled: false };
  return {
    log: { loglevel: "warning" },
    inbounds: [{
      tag: "in",
      listen: "127.0.0.1",
      port,
      protocol: "mixed",
      settings: { auth: "noauth", udp: true },
      sniffing: { enabled: true, destOverride: ["http", "tls"] },
    }],
    outbounds: [outbound, { tag: "direct", protocol: "freedom" }],
    routing: { domainStrategy: "AsIs", rules: [{ type: "field", ip: ["geoip:private"], outboundTag: "direct" }] },
  };
}

/** Проба живости тем же путём, что и рабочие запросы: CONNECT + TLS до Zen.
 * Plain-HTTP gstatic давал ложные «dead» на double-hop через TUN. */
export function probePort(port, timeoutMs = 8000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const done = (alive, status) => resolve({ alive, ms: Date.now() - started, status });
    const req = http.request({
      host: "127.0.0.1", port, method: "CONNECT",
      path: "opencode.ai:443", timeout: timeoutMs,
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return done(false, res.statusCode); }
      const tlsSock = tls.connect({ socket, servername: "opencode.ai", ALPNProtocols: ["http/1.1"] });
      tlsSock.on("error", () => done(false, 0));
      const inner = http.request({
        hostname: "opencode.ai", path: "/inference/v1/models", method: "GET",
        createConnection: () => tlsSock, timeout: timeoutMs,
      }, (r) => { r.resume(); done(r.statusCode === 200, r.statusCode); });
      inner.on("timeout", () => { inner.destroy(); done(false, 0); });
      inner.on("error", () => done(false, 0));
      inner.end();
    });
    req.on("timeout", () => { req.destroy(); done(false, 0); });
    req.on("error", () => done(false, 0));
    req.end();
  });
}

export class ExitManager {
  constructor({ xrayBin = XRAY_BIN, basePort = 10900 } = {}) {
    this.xrayBin = xrayBin;
    this.basePort = basePort;
    this.dir = mkdtempSync(path.join(tmpdir(), "ps-exits-"));
    this.exits = new Map(); // id -> {node, port, child, alive, ms, checkedAt}
    this.nextPort = basePort;
  }

  async start(node) {
    if (this.exits.has(node.id)) return this.exits.get(node.id);
    // Порт не переиспользуется: убитый xray отпускает его не мгновенно,
    // и новый процесс падал бы на bind с тем же номером.
    const port = this.nextPort++;
    const file = path.join(this.dir, `${node.id}.json`);
    writeFileSync(file, JSON.stringify(xrayConfigFor(node, port)));
    const child = spawn(this.xrayBin, ["run", "-c", file], {
      stdio: "ignore",
      windowsHide: true,
      // geoip.dat/geosite.dat лежат в bin v2rayN, а не рядом с xray.exe
      env: { ...process.env, XRAY_LOCATION_ASSET: path.dirname(path.dirname(this.xrayBin)) },
    });
    const entry = { node, port, child, alive: false, ms: -1, checkedAt: 0, quotaUntil: 0 };
    this.exits.set(node.id, entry);
    child.on("exit", () => { entry.alive = false; });
    await new Promise((r) => setTimeout(r, 350));
    await this.check(node.id);
    return entry;
  }

  async check(id) {
    const entry = this.exits.get(id);
    if (!entry) return null;
    if (entry.child.exitCode !== null) { entry.alive = false; return entry; }
    // Жёсткий race: проба не имеет права вешать менеджер навсегда.
    const guard = new Promise((r) => { const t = setTimeout(() => r({ alive: false, ms: -1, status: 0 }), 7000); t.unref(); });
    const res = await Promise.race([probePort(entry.port, 5000), guard]);
    entry.alive = res.alive;
    entry.ms = res.ms;
    entry.checkedAt = Date.now();
    return entry;
  }

  async checkAll() {
    for (const id of this.exits.keys()) await this.check(id);
    return this.live();
  }

  live() {
    const now = Date.now();
    return [...this.exits.values()]
      .filter((e) => e.alive && (e.quotaUntil || 0) <= now)
      .sort((a, b) => a.ms - b.ms);
  }

  stop(id) {
    const entry = this.exits.get(id);
    if (!entry) return;
    entry.child.kill();
    this.exits.delete(id);
  }

  stopAll() {
    for (const id of [...this.exits.keys()]) this.stop(id);
    try { rmSync(this.dir, { recursive: true, force: true }); } catch {}
  }

  status() {
    return [...this.exits.values()].map((e) => ({
      id: e.node.id, remarks: e.node.remarks, sub: e.node.sub, port: e.port,
      alive: e.alive, ms: e.ms, checkedAt: e.checkedAt,
    }));
  }
}

/** CLI: node src/exits.mjs probe [--subs VPNLiberty,Hynet] [--limit N] */
async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== "probe") { console.log("usage: node src/exits.mjs probe [--subs a,b] [--limit N]"); return; }
  const subsArg = args.includes("--subs") ? args[args.indexOf("--subs") + 1] : "";
  const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : 10;
  const subs = subsArg ? subsArg.split(",").map((s) => s.trim().toLowerCase()) : null;
  const nodes = loadNodes().filter((n) => !subs || subs.includes(n.sub.toLowerCase()));
  const mgr = new ExitManager({ basePort: 11900 });
  const results = [];
  for (const node of nodes.slice(0, limit)) {
    const entry = await mgr.start(node);
    results.push({ alive: entry.alive, ms: entry.ms, remarks: node.remarks, sub: node.sub });
    console.log(`${entry.alive ? "LIVE" : "dead"} ${String(entry.ms).padStart(5)}ms :${entry.port} [${node.sub}] ${node.remarks}`);
    mgr.stop(node.id);
  }
  mgr.stopAll();
  const live = results.filter((r) => r.alive);
  console.log(`\n${live.length}/${results.length} живых`);
}

if (process.argv[1] && process.argv[1].endsWith("exits.mjs")) main();