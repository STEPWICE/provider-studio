// src/zengate.mjs — локальный шлюз пула аккаунтов Zen для OpenCode/OpenChamber.
//
// Zen отдаёт бесплатные модели двум способом: анонимно (квота на exit IP)
// и по логину/ключу аккаунта (квота на аккаунт). Шлюз крутит и то и другое:
// сначала аккаунты напрямую, затем те же аккаунты и анонимные попытки через
// живые выходы VPNLiberty/Hynet (src/exits.mjs). Суточная квота аккаунта
// выводит его из ротации до следующих суток UTC, 429/5xx — кулдаун,
// региональный отказ — следующий выход с тем же аккаунтом.
//
// Секреты живут в переменных окружения ZEN_API_KEY[_N] или в
// data/zen-accounts.json (OAuth-токены), в код не попадают.

import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ExitManager, loadNodes } from "./exits.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ZEN_BASE = "https://opencode.ai/inference/openai/v1";
const ACCOUNTS_FILE = path.join(HERE, "..", "data", "zen-accounts.json");

const DAILY_RE = /requests per day|tokens per day|free-models-per-day|per-day|daily.?limit|usage limit reached|used today's free messages|free messages/i;
const RATE_RE = /rate.?limit|too many requests|请求过于频繁|限流/i;
const REGION_RE = /not available in|region|country|географ|регион|недоступн.*в (вашей|этой) (стране|регионе)/i;
const BADKEY_RE = /invalid api[ _-]?key|valid api[ _-]?key|unauthorized|authentication/i;

export const FREE_MODELS = [
  "hy4-flash-free", "deepseek-v4.1-flash-free", "glm-5.3-flash-free",
  "mimo-v2.6-flash-free", "nemotron-3-ultra-free", "nemotron-3.5-lightning-free",
  "nemotron-3.5-super-vl-free", "big-pickle", "iceman-free", "beam-free",
  "flint-40b-free", "longcat-2.5-free", "inkling-2-small-free",
];

function nextUtcMidnight() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

export function loadCredentials() {
  const creds = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (/^ZEN_API_KEY(_\d+)?$/.test(name) && (value || "").trim()) {
      creds.push({ id: name, kind: "key", value: value.trim() });
    }
  }
  try {
    const file = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
    for (const acc of Array.isArray(file) ? file : file.accounts || []) {
      if (acc && acc.token) creds.push({ id: acc.id || acc.email || `oauth-${creds.length}`, kind: "oauth", value: acc.token });
    }
  } catch {}
  return creds;
}

function createState(creds) {
  return creds.map((c) => ({ ...c, dead: false, dailyUntil: 0, cooldownUntil: 0, fails: 0, used: 0, lastError: "" }));
}

function alive(state, now) {
  return state.filter((s) => !s.dead && s.dailyUntil <= now && s.cooldownUntil <= now);
}

function note(state, status, text) {
  const now = Date.now();
  if (status === 401 || (status === 403 && BADKEY_RE.test(text))) { state.dead = true; state.lastError = `bad key (${status})`; return "dead"; }
  if (DAILY_RE.test(text)) { state.dailyUntil = nextUtcMidnight(); state.lastError = "daily quota"; return "daily"; }
  if (status === 429 || RATE_RE.test(text)) {
    state.fails += 1;
    state.cooldownUntil = now + Math.min(300000, 60000 * 2 ** Math.min(3, state.fails - 1));
    state.lastError = `rate (${status})`;
    return "rate";
  }
  if (status === 402 || /insufficient|balance|credit|billing|quota/i.test(text)) { state.dailyUntil = nextUtcMidnight(); state.lastError = `billing (${status})`; return "daily"; }
  if (status >= 500) { state.cooldownUntil = now + 30000; state.lastError = `server (${status})`; return "rate"; }
  if (status === 403 && REGION_RE.test(text)) { state.lastError = `region (${status})`; return "region"; }
  state.lastError = `${status}: ${text.slice(0, 120)}`;
  return "other";
}

/** CONNECT-туннель через mixed-порт xray: возвращает streaming-ответ. */
function tunnelRequest(proxy, target, { method, headers, body, timeoutMs = 60000 }) {
  return new Promise((resolve, reject) => {
    const u = new URL(target);
    const req = http.request({
      host: proxy.host, port: proxy.port, method: "CONNECT",
      path: `${u.hostname}:${u.port || 443}`, timeout: timeoutMs,
    });
    const fail = (e) => { req.destroy(); reject(e); };
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return reject(new Error(`proxy ${res.statusCode}`)); }
      const tlsSock = tls.connect({ socket, servername: u.hostname, ALPNProtocols: ["http/1.1"] });
      tlsSock.on("error", reject);
      const inner = http.request({
        hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
        method, headers, createConnection: () => tlsSock, timeout: timeoutMs,
      }, resolve);
      inner.on("timeout", () => { inner.destroy(new Error("upstream timeout")); });
      inner.on("error", reject);
      if (body) inner.write(body);
      inner.end();
    });
    req.on("timeout", () => fail(new Error("proxy connect timeout")));
    req.on("error", fail);
    req.end();
  });
}

async function readText(res, limit = 20000) {
  if (typeof res.text === "function") return (await res.text()).slice(0, limit);
  return await new Promise((resolve) => {
    let buf = "";
    res.setEncoding("utf8");
    res.on("data", (c) => { buf += c; if (buf.length > limit) res.destroy(); });
    res.on("end", () => resolve(buf.slice(0, limit)));
    res.on("error", () => resolve(buf));
  });
}

function pipeToClient(upstream, clientRes, isFetch) {
  const headers = {};
  if (isFetch) {
    upstream.headers.forEach((v, k) => { headers[k] = v; });
  } else {
    for (const [k, v] of Object.entries(upstream.headers)) headers[k] = v;
  }
  delete headers["content-encoding"];
  delete headers["content-length"];
  delete headers["transfer-encoding"];
  clientRes.writeHead(upstream.status || upstream.statusCode, headers);
  if (isFetch) {
    const reader = upstream.body.getReader();
    const pump = () => reader.read().then(({ done, value }) => {
      if (done) return clientRes.end();
      clientRes.write(Buffer.from(value));
      return pump();
    });
    pump().catch(() => clientRes.end());
  } else {
    upstream.pipe(clientRes);
  }
}

export function createZenGate({ port = 8790, subs = ["VPNLiberty", "Hynet"], maxExits = 3 } = {}) {
  let state = createState(loadCredentials());
  const mgr = new ExitManager();
  const stats = { requests: 0, ok: 0, rotated: 0, exitUsed: 0, lastError: "" };
  let cursor = 0;
  let candidates = [];
  let candidateAt = 0;
  const deadSkip = new Map();

  function refreshCandidates() {
    const now = Date.now();
    if (now - candidateAt < 60000 && candidates.length) return candidates;
    candidateAt = now;
    const want = subs.map((s) => s.toLowerCase());
    const bySub = new Map(want.map((s) => [s, []]));
    for (const n of loadNodes()) {
      const key = n.sub.toLowerCase();
      if (bySub.has(key)) bySub.get(key).push(n);
    }
    for (const list of bySub.values()) {
      list.sort((a, b) => (a.lastDelay < 0 ? 1e9 : a.lastDelay) - (b.lastDelay < 0 ? 1e9 : b.lastDelay));
    }
    // Чередуем подписки: мёртвая подписка не должна съедать весь прогрев.
    const mixed = [];
    for (let i = 0; mixed.length < [...bySub.values()].reduce((s, l) => s + l.length, 0); i++) {
      for (const list of bySub.values()) if (list[i]) mixed.push(list[i]);
    }
    candidates = mixed;
    return candidates;
  }

  async function ensureExits() {
    const live = mgr.live();
    if (live.length >= Math.min(maxExits, 1)) return live;
    refreshCandidates();
    for (const node of candidates) {
      if (mgr.exits.has(node.id)) { await mgr.check(node.id); continue; }
      if ((deadSkip.get(node.id) || 0) > Date.now()) continue;
      if (mgr.exits.size >= maxExits) {
        const worst = [...mgr.exits.values()].sort((a, b) => (a.alive ? 1 : 0) - (b.alive ? 1 : 0) || b.ms - a.ms)[0];
        if (worst && worst.alive) break;
        mgr.stop(worst.node.id);
      }
      console.error(`[zenpool] start exit ${node.sub} ${node.remarks}`);
      const entry = await mgr.start(node);
      console.error(`[zenpool] exit ${node.remarks} alive=${entry.alive} ms=${entry.ms}`);
      // Hynet — личный VPS: его IP не выжжен толпой, ретраим чаще общих нод.
      if (!entry.alive) deadSkip.set(node.id, Date.now() + (node.sub.toLowerCase() === "hynet" ? 90000 : 300000));
      // Одного живого выхода достаточно для фолбэка; остальные добираем
      // фоновым обновлением, иначе запрос ждёт перебора всех мёртвых нод.
      if (mgr.live().length >= 1) break;
    }
    return mgr.live();
  }

  async function attempt(cred, exit, url, method, headers, body) {
    const h = { ...headers };
    delete h.host; delete h["content-length"]; delete h.connection;
    if (cred && cred.kind !== "anon") h.authorization = `Bearer ${cred.value}`;
    else delete h.authorization;
    if (exit) return await tunnelRequest({ host: "127.0.0.1", port: exit.port }, url, { method, headers: h, body });
    const res = await fetch(url, { method, headers: h, body: body || undefined });
    return res;
  }

  async function handleChat(req, res, body) {
    stats.requests += 1;
    const now = Date.now();
    const url = `${ZEN_BASE}/chat/completions`;
    const headers = { "content-type": "application/json" };
    const order = alive(state, now);
    if (order.length) {
      const hit = cursor % order.length;
      order.push(...order.splice(0, hit));
    }
    const anon = { id: "anon", kind: "anon", value: "" };
    let last = null;
    // Второй круг: если все выходы первого круга упёрлись в квоту IP,
    // ensureExits поднимет следующие ноды и анонимные попытки пойдут через них.
    for (let round = 0; round < 2; round++) {
      const tries = [];
      if (round === 0) for (const c of order) tries.push({ cred: c, exit: null });
      const exits = await ensureExits();
      for (const exit of exits) {
        for (const c of order) tries.push({ cred: c, exit });
        tries.push({ cred: anon, exit });
      }
      if (!tries.length) tries.push({ cred: anon, exit: null });
      let quotaHit = false;
      for (const { cred, exit } of tries) {
        let upstream = null;
        let isFetch = false;
        try {
          upstream = await attempt(cred, exit, url, "POST", headers, body);
          isFetch = typeof upstream.text === "function";
        } catch (e) {
          stats.lastError = `transport: ${e.message}`;
          if (exit) { exit.alive = false; }
          continue;
        }
        const status = upstream.status || upstream.statusCode;
        if (status >= 200 && status < 300) {
          if (cred.kind !== "anon") { cred.used += 1; cred.fails = 0; cursor = (state.indexOf(cred) + 1) % Math.max(1, state.length); }
          if (exit) stats.exitUsed += 1;
          stats.ok += 1;
          pipeToClient(upstream, res, isFetch);
          return;
        }
        const text = await readText(upstream);
        last = { status, text };
        stats.lastError = `${status} ${text.slice(0, 160)}`;
        if (cred.kind === "anon") {
          if (exit && (status === 403 || status === 429 || DAILY_RE.test(text))) {
            exit.alive = false;
            exit.quotaUntil = Date.now() + 600000;
            quotaHit = true;
          }
          continue;
        }
        const verdict = note(cred, status, text);
        stats.rotated += 1;
        if (verdict === "daily" || verdict === "rate") quotaHit = true;
        if (verdict === "region" && exit) { exit.alive = false; exit.quotaUntil = Date.now() + 600000; quotaHit = true; continue; }
        if (verdict === "other" && status === 400) break;
      }
      if (!quotaHit || round === 1) break;
    }
    res.writeHead(last?.status || 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `zenpool: все аккаунты и выходы исчерпаны (${last?.status || "transport"})`, detail: last?.text?.slice(0, 400) || stats.lastError } }));
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://local");
    if (u.pathname === "/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        stats,
        creds: state.map((s) => ({ id: s.id, kind: s.kind, dead: s.dead, daily: s.dailyUntil > Date.now(), cooldown: s.cooldownUntil > Date.now(), used: s.used, lastError: s.lastError })),
        exits: mgr.status(),
      }, null, 2));
      return;
    }
    if (u.pathname === "/reload" && req.method === "POST") {
      state = createState(loadCredentials());
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, creds: state.length }));
      return;
    }
    if (u.pathname === "/v1/models" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: FREE_MODELS.map((id) => ({ id, object: "model", owned_by: "zenpool" })) }));
      return;
    }
    if (u.pathname === "/v1/chat/completions" && req.method === "POST") {
      let buf = "";
      req.on("data", (c) => { buf += c; });
      req.on("end", () => { handleChat(req, res, buf).catch((e) => { if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: e.message } })); }); });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `zenpool: неизвестный путь ${u.pathname}` } }));
  });

  const timer = setInterval(() => { ensureExits().catch((e) => console.error("[zenpool] ensureExits error:", e.message)); }, 60000);
  timer.unref();

  return {
    server,
    mgr,
    stats,
    reloadCredentials() { state = createState(loadCredentials()); },
    start() {
      return new Promise((r) => server.listen(port, "127.0.0.1", () => { ensureExits().catch((e) => console.error("[zenpool] ensureExits error:", e.message)); r(); }));
    },
    stop() { clearInterval(timer); mgr.stopAll(); server.close(); },
  };
}

if (process.argv[1] && process.argv[1].endsWith("zengate.mjs")) {
  const gate = createZenGate();
  gate.start().then(async () => {
    console.log(`zenpool gateway on http://127.0.0.1:8790/v1 (creds: ${loadCredentials().length})`);
    const live = await gate.mgr.checkAll();
    console.log("exits:", gate.mgr.status().map((e) => `${e.alive ? "LIVE" : "dead"} ${e.remarks}`).join(" | ") || "none");
  });
  process.on("SIGINT", () => { gate.stop(); process.exit(0); });
  process.on("SIGTERM", () => { gate.stop(); process.exit(0); });
}