// src/proxy.mjs
// Outbound proxy support for the network probes.
//
// Why this exists: Node does not honour HTTP_PROXY/HTTPS_PROXY on its own.
// `fetch()` goes straight out, so behind a corporate proxy or a VPN client
// every probe times out and the UI blames the provider ("сервер недоступен")
// when the real problem is that the request never left the machine.
//
// Node 24 has `--use-env-proxy`, but it is deliberately not used here:
//   - it is process-wide, so a local provider (ollama on 127.0.0.1) would be
//     sent through the proxy too;
//   - it is a startup flag, so it cannot react to a proxy the user configures
//     while the app is running;
//   - it does not exist before Node 24, and the packaged exe should not pin
//     the runtime that tightly.
// Instead the proxy is resolved per request, and only for hosts that actually
// need it.

import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { isIP } from "node:net";
import { IS_WINDOWS } from "./paths.mjs";

/** Proxy settings are re-read at most this often. */
const CACHE_TTL_MS = 5000;
let cache = { at: 0, value: null };

export function clearProxyCache() {
  cache = { at: 0, value: null };
}

/**
 * Parses a proxy URL as found in HTTP_PROXY / the registry.
 * A bare `host:port` is accepted: Windows writes it that way, and users type it
 * that way more often than not.
 */
export function parseProxyUrl(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let u;
  try { u = new URL(withScheme); } catch { return null; }
  // SOCKS needs a different handshake entirely; claiming support would turn a
  // clear failure into a hang.
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  const port = u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    host: u.hostname.replace(/^\[|\]$/g, ""),
    port,
    protocol: u.protocol,
    username: decodeURIComponent(u.username || ""),
    password: decodeURIComponent(u.password || ""),
  };
}

/** `.example.com`, `example.com`, `*.example.com` and `*` are all honoured. */
export function matchesNoProxy(hostname, noProxy) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  const list = String(noProxy || "").split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!host || !list.length) return false;
  for (const entry of list) {
    if (entry === "*") return true;
    // A port suffix in NO_PROXY is ignored: matching on host alone is the
    // conservative choice, since the cost of an unexpected direct connection is
    // higher than that of an unnecessary proxy hop.
    const bare = entry.replace(/^\*?\./, "").replace(/:\d+$/, "");
    if (!bare) continue;
    if (host === bare || host.endsWith(`.${bare}`)) return true;
  }
  return false;
}

/**
 * Loopback and RFC1918 literals, plus the local-only names.
 *
 * Kept here rather than reusing rescue.mjs's `isPrivateHost` to avoid an import
 * cycle (rescue imports this module). The rule is also narrower on purpose:
 * this decides "skip the proxy", so it only matches addresses that are
 * unambiguously on this machine or this LAN, never a bare public name.
 */
export function isLocalTarget(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h) return false;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const kind = isIP(h);
  if (kind === 4) {
    const p = h.split(".").map(Number);
    const [a, b] = p;
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (kind === 6) {
    if (h === "::1" || h === "::") return true;
    return h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd");
  }
  return false;
}

function envProxy(env, targetProtocol) {
  const pick = (...names) => {
    for (const n of names) {
      const v = env[n];
      if (v && String(v).trim()) return { raw: v, name: n };
    }
    return null;
  };
  // Lowercase wins: it is the de-facto convention, and on Windows the uppercase
  // form can be inherited from a shell the user has forgotten about.
  const hit = targetProtocol === "https:"
    ? pick("https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY")
    : pick("http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY");
  if (!hit) return null;
  const parsed = parseProxyUrl(hit.raw);
  return parsed ? { ...parsed, source: hit.name } : null;
}

/**
 * Windows stores the setting configured in "Proxy settings" here, and a GUI
 * user has usually never set an environment variable at all.
 */
export function readWindowsProxy() {
  if (!IS_WINDOWS) return null;
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  let out;
  try {
    out = execFileSync("reg", ["query", key], { encoding: "utf8", timeout: 4000, windowsHide: true });
  } catch { return null; }
  const value = (name) => {
    const m = out.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, "mi"));
    return m ? m[1].trim() : "";
  };
  if (!/^0x1$/i.test(value("ProxyEnable"))) return null;
  const server = value("ProxyServer");
  if (!server) return null;
  // Either "host:port" or "http=host:port;https=host:port".
  let spec = server;
  if (server.includes("=")) {
    const map = Object.fromEntries(
      server.split(";").map((p) => p.split("=")).filter((p) => p.length === 2).map(([k, v]) => [k.trim().toLowerCase(), v.trim()]),
    );
    spec = map.https || map.http || "";
  }
  const parsed = parseProxyUrl(spec);
  if (!parsed) return null;
  return { ...parsed, source: "Windows: настройки прокси", override: value("ProxyOverride") };
}

/**
 * The proxy to use for one target URL, or null for a direct connection.
 *
 * Loopback and RFC1918 targets are never proxied: a local model server is the
 * one case where going through the proxy is guaranteed to be wrong, and
 * `<local>` is not always present in the Windows override list.
 */
export function proxyForUrl(target, { env = process.env, useCache = true, useSystem = true } = {}) {
  let u;
  try { u = new URL(String(target)); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isLocalTarget(host)) return null;

  const noProxy = env.no_proxy || env.NO_PROXY || "";
  if (matchesNoProxy(host, noProxy)) return null;

  const now = Date.now();
  const fresh = useCache && cache.value && now - cache.at < CACHE_TTL_MS && cache.value.protocol === u.protocol;
  let proxy = fresh ? cache.value.proxy : undefined;
  if (proxy === undefined) {
    proxy = envProxy(env, u.protocol) || (useSystem ? readWindowsProxy() : null);
    cache = { at: now, value: { protocol: u.protocol, proxy } };
  }
  if (!proxy) return null;
  if (proxy.override && matchesNoProxy(host, proxy.override.replace(/<local>/gi, ""))) return null;
  // Routing the proxy through itself would loop.
  if (proxy.host === host && String(proxy.port) === String(u.port || (u.protocol === "https:" ? 443 : 80))) return null;
  return proxy;
}

function proxyAuthHeader(proxy) {
  if (!proxy.username && !proxy.password) return null;
  const raw = `${proxy.username}:${proxy.password}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

/** Opens a CONNECT tunnel for an https target. */
function openTunnel(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = proxy.protocol === "https:" ? https : http;
    const headers = { Host: `${host}:${port}` };
    const auth = proxyAuthHeader(proxy);
    if (auth) headers["Proxy-Authorization"] = auth;
    const req = mod.request({
      host: proxy.host,
      port: proxy.port,
      method: "CONNECT",
      path: `${host}:${port}`,
      headers,
      timeout: timeoutMs,
      rejectUnauthorized: false, // proxies routinely use a private CA
    });
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    req.on("connect", (res, socket) => {
      if (res.statusCode === 200) return done(resolve, socket);
      socket.destroy();
      const why = res.statusCode === 407 ? "прокси требует авторизации (407)" : `прокси ответил ${res.statusCode}`;
      done(reject, Object.assign(new Error(why), { proxyStage: true }));
    });
    req.on("timeout", () => { req.destroy(Object.assign(new Error("прокси не отвечает (таймаут)"), { proxyStage: true })); });
    req.on("error", (e) => done(reject, Object.assign(e, { proxyStage: true })));
    req.end();
  });
}

/**
 * A request through a proxy, shaped like the part of `Response` the probes use.
 * Redirects are never followed: the caller inspects `status` and `location`
 * itself, because an automatic hop would bypass the SSRF checks.
 */
/**
 * Default ceiling on a response body. A probe reads a model list from an
 * endpoint we do not control, so an unbounded read is a memory hazard. Callers
 * that knowingly need more (the models.dev catalogue is ~4.4 MB) raise it.
 */
export const DEFAULT_MAX_BYTES = 2_000_000;

export async function proxyFetch(target, { headers = {}, timeoutMs = 10000, proxy, method = "GET", body = null, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const u = new URL(target);
  const isHttps = u.protocol === "https:";
  const port = Number(u.port) || (isHttps ? 443 : 80);
  const socket = isHttps ? await openTunnel(proxy, u.hostname, port, timeoutMs) : null;

  return new Promise((resolve, reject) => {
    const reqHeaders = { ...headers, Host: u.host };
    if (body != null) reqHeaders["Content-Length"] = Buffer.byteLength(body);
    const options = isHttps
      ? { socket, agent: false, servername: u.hostname, host: u.hostname, port, path: u.pathname + u.search, method, headers: reqHeaders }
      : { host: proxy.host, port: proxy.port, path: u.toString(), method, headers: reqHeaders };
    if (!isHttps) {
      const auth = proxyAuthHeader(proxy);
      if (auth) options.headers["Proxy-Authorization"] = auth;
    }

    const mod = isHttps ? https : http;
    let settled = false;
    // `timer` is declared here but armed only after `req` exists: the callback
    // destroys the request, and firing it earlier hit the TDZ on `req`.
    let timer = null;

    const req = mod.request(options, (res) => {
      let body = "";
      // Truncation used to be silent: the body was capped mid-JSON and handed
      // back as a success, so the caller saw "Unterminated string" and blamed
      // the server for sending garbage. Stop reading, but say so.
      let truncated = false;
      res.setEncoding("utf8");
      res.on("data", (d) => {
        if (body.length >= maxBytes) { truncated = true; return; }
        body += d;
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (socket) socket.end();
        const status = res.statusCode || 0;
        const fail = async () => {
          throw new Error(`Ответ обрезан на ${maxBytes} байт — тело больше допустимого`);
        };
        resolve({
          ok: status >= 200 && status < 300,
          status,
          viaProxy: true,
          truncated,
          headers: { get: (n) => res.headers[String(n).toLowerCase()] ?? null },
          // A truncated body is not the document that was sent. Returning it
          // would hand the caller a half-parsed lie.
          text: truncated ? fail : async () => body,
          json: truncated ? fail : async () => JSON.parse(body),
        });
      });
    });
    req.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) socket.destroy();
      reject(e);
    });

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      if (socket) socket.destroy();
      reject(Object.assign(new Error("таймаут"), { name: "TimeoutError" }));
    }, timeoutMs);

    if (body != null) req.write(body);
    req.end();
  });
}

/** Human-readable description for the diagnostics panel. */
export function describeProxy(proxy) {
  if (!proxy) return "";
  const auth = proxy.username ? `${proxy.username}@` : "";
  return `${proxy.protocol}//${auth}${proxy.host}:${proxy.port}`;
}
