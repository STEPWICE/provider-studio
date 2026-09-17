import http from "node:http";
import path from "node:path";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { exec } from "node:child_process";
import {
  readConfig, readConfigAtPath, upsertProviderAsDefault, opencodeSummary, setDefaultModel,
  planProviderChange, planProviderRemoval, removeProvider, renameProvider,
  listOpencodeConfigs, writeConfigText, commitPlan,
} from "./src/opencode.mjs";
import { buildPreview } from "./src/diff.mjs";
import { applyChangesVerified } from "./src/jsonc-edit.mjs";
import { buildAutoFixChanges, planRefresh, runSelfCheck, isFreeEntry, buildRefreshChanges } from "./src/doctor.mjs";
import { smartAudit } from "./src/smart-audit.mjs";
import { loadDigest } from "./src/digest.mjs";
import { buildManifest, buildGuide, TARGETS } from "./src/targets.mjs";
import { FORMATS, slugify, decodeApiKey, detectApiFormat, isCustomProviderBlock, looksLikePackage, modelEntryToForm } from "./src/formats.mjs";
import { PRESETS } from "./src/presets.mjs";
import {
  backupConfig, listBackups, restoreBackup, validateConfig, testConnection,
  fetchModels, testCompletion,
} from "./src/rescue.mjs";
import { loadCatalog, enrichModels } from "./src/catalog.mjs";
import { runBatch } from "./src/batch.mjs";
import { dataDir, ensureDir, writeFileAtomic } from "./src/paths.mjs";
import { readAsset, normaliseRel, isPackaged, publicDir } from "./src/assets.mjs";
import {
  lookupEnv, resolveKeyRef, keyRefProblem, setEnvCommand, clearEnvCache,
  ENV_NAME_RE, SETX_MAX_LENGTH, setUserEnvVar,
} from "./src/env.mjs";
import { proxyForUrl, describeProxy } from "./src/proxy.mjs";

// The store lives in the per-user data dir, not next to the source: a packaged
// exe sits in a read-only directory.
const STORE = () => path.join(dataDir(), "providers.json");
const WANTED = Number(process.env.PORT || 5173);
// Bind to loopback by default: the API is unauthenticated and can read the
// opencode config, so exposing it on the LAN would leak credentials.
const HOST = process.env.PS_HOST || "127.0.0.1";
const MAX_BODY = 1024 * 1024; // 1 MB
let PORT_ACTIVE = WANTED;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

// ---------- provider store ----------
// The on-disk file has historically held a bare object instead of an array;
// normalise so a legacy file can't take the whole server down.
function loadStore() {
  const file = STORE();
  if (!existsSync(file)) return [];
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch { return []; }
  if (Array.isArray(parsed)) return parsed.filter((p) => p && typeof p === "object");
  if (parsed && typeof parsed === "object") return [parsed];
  return [];
}

// API keys are never persisted here: the file sits inside the repo and would be
// trivially committed. Only the env-var reference is kept.
function stripSecrets(provider) {
  const { apiKey, ...rest } = provider || {};
  return { ...rest, apiKey: "" };
}

function saveStore(list) {
  ensureDir(dataDir());
  const safe = (Array.isArray(list) ? list : []).map(stripSecrets);
  // Atomic: a crash mid-write would otherwise leave a truncated store that
  // loadStore() silently reads as "no providers".
  writeFileAtomic(STORE(), JSON.stringify(safe, null, 2));
}

// Providers are identified by their opencode key so that Apply followed by
// Import doesn't create a near-duplicate entry for the same provider.
function providerKeyOf(p) {
  return slugify(p && p.name);
}

// ---------- undo (single-level rollback of the last write) ----------
// Every successful config mutation records how to revert itself: the snapshot
// taken immediately before the write. The record survives restarts (it lives
// in the data dir next to backups), but it is deliberately single-level — a
// history UI would suggest safety this file-level rollback cannot promise
// once external edits land in between.
const LAST_WRITE_FILE = () => path.join(dataDir(), "last-write.json");

function readUndo() {
  try {
    const v = JSON.parse(readFileSync(LAST_WRITE_FILE(), "utf8"));
    if (!v || typeof v !== "object") return null;
    if (typeof v.configPath !== "string" || !v.configPath) return null;
    if (typeof v.label !== "string") return null;
    return v;
  } catch { return null; }
}

function clearUndo() {
  try { unlinkSync(LAST_WRITE_FILE()); } catch { /* already gone */ }
}

// What the UI may offer to revert. Scoped to the file currently being viewed:
// an undo entry for another config would revert the wrong file.
function currentUndo(configPath) {
  const u = readUndo();
  if (!u || u.configPath !== configPath) return null;
  return { label: u.label, time: u.time || 0 };
}

// Remembers how to revert the write that just landed. preFile is the snapshot
// taken immediately before the write (null when the file was created from
// scratch); afterHash lets an undo-of-creation refuse when the file has since
// moved on. Never throws: undo is a convenience, and a write must not fail
// because the convenience bookkeeping did.
function recordUndo(configPath, preFile, label, afterHash = "") {
  try {
    ensureDir(dataDir());
    writeFileAtomic(LAST_WRITE_FILE(), JSON.stringify({
      configPath,
      file: preFile ? path.basename(String(preFile)) : null,
      label, afterHash: afterHash || "",
      created: !preFile, time: Date.now(),
    }));
  } catch { /* ignore */ }
}

/**
 * Works out which key a probe should actually send for a form payload.
 *
 * Two cases the UI cannot resolve on its own:
 *  1. The provider was imported from the opencode config, so the key field is
 *     empty and the real value lives behind `{env:VAR}`. Probing with "" would
 *     report a 401 the user cannot act on.
 *  2. The form is in $ENV mode. The literal key typed into the field is
 *     discarded on write, so probing with it would report success for a config
 *     that is going to fail. The variable is what must be probed.
 *
 * Returns { apiKey, blocker }. A non-empty `blocker` means the probe is
 * pointless and the message explains why in terms the user can fix.
 */
function probeCredentials(p) {
  const provider = p || {};
  // In $ENV mode the variable wins over the field, mirroring what gets written.
  const ref = provider.useEnvVar && provider.envVarName
    ? `{env:${String(provider.envVarName).trim()}}`
    : String(provider.apiKey || "").trim();
  const resolved = resolveKeyRef(ref);
  if (resolved.isRef && !resolved.resolved) {
    return { apiKey: "", blocker: keyRefProblem(ref) };
  }
  return { apiKey: resolved.value, blocker: "" };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    // Buffers are collected and decoded once at the end. Concatenating chunks as
    // strings splits multi-byte UTF-8 sequences across chunk boundaries, which
    // corrupted any non-ASCII provider name that happened to straddle one.
    const chunks = [];
    let size = 0;
    let done = false;
    let overflow = false;
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY) {
        // Drain, don't destroy: the client is still uploading, and a torn-down
        // socket turns the 413 below into an ECONNRESET the client cannot read.
        // Buffered chunks are dropped so a huge body is not held in memory.
        // Past 10x the limit patience ends — that is abuse, not a big form.
        overflow = true;
        chunks.length = 0;
        if (size > MAX_BODY * 10) {
          done = true;
          reject(Object.assign(new Error("Тело запроса слишком большое"), { statusCode: 413 }));
          req.destroy();
        }
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      if (overflow) {
        // Carries its own status: the generic catch below answers 500, but a
        // client that sent megabytes of JSON has a request problem, not our bug.
        reject(Object.assign(new Error("Тело запроса слишком большое"), { statusCode: 413 }));
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      try { resolve(text ? JSON.parse(text) : {}); } catch (e) { reject(e); }
    });
    req.on("error", (e) => { if (!done) { done = true; reject(e); } });
  });
}

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": MIME[".json"] });
  res.end(JSON.stringify(obj, null, 2));
}

// ---------- request guards ----------
const ALLOWED_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const LOOPBACK_ONLY = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";

// Blocks DNS rebinding: a hostile domain resolving to 127.0.0.1 would otherwise
// let a remote page talk to this API. Skipped when the operator deliberately
// bound to a non-loopback interface, since then any Host is legitimate.
function hostAllowed(req) {
  if (!LOOPBACK_ONLY) return true;
  const raw = String(req.headers.host || "");
  const hostname = raw.replace(/:\d+$/, "").toLowerCase();
  return ALLOWED_HOSTNAMES.has(hostname);
}

// Blocks CSRF: any page the user has open could otherwise POST to localhost and
// rewrite the opencode config. Same-origin requests carry the server's own host.
function originAllowed(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (curl) send no Origin
  try {
    const u = new URL(origin);
    const host = u.hostname.toLowerCase();
    if (ALLOWED_HOSTNAMES.has(host)) return true;
    // When bound beyond loopback, accept the host the page was actually served from.
    return !LOOPBACK_ONLY && host === String(req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
  } catch { return false; }
}

// Static files come from src/assets.mjs, which hides whether they live in
// ./public or are embedded in a single-executable build. `path.join` alone was
// never enough here: on Windows a percent-encoded backslash (%5c) survives URL
// parsing and acts as a separator, so `/..%5c..%5cserver.mjs` escapes the
// directory. normaliseRel() rejects those outright.
function serveStatic(res, urlPath) {
  const rel = normaliseRel(urlPath);
  if (rel === null) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }
  const body = readAsset(rel);
  if (body) {
    const ext = path.extname(rel).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(body);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (!hostAllowed(req)) {
      return json(res, 403, { ok: false, error: "Недопустимый Host — открой интерфейс по адресу http://localhost:" + PORT_ACTIVE });
    }
    if (req.method !== "GET" && req.method !== "HEAD" && !originAllowed(req)) {
      return json(res, 403, { ok: false, error: "Запрос отклонён: посторонний Origin" });
    }

    if (url.pathname === "/api/state" && req.method === "GET") {
      // Scoped to the file the UI is viewing: hash, undo entry and provider
      // list all belong to it. Without this every read showed the default file
      // while writes went to the picked one.
      const cfg = readConfig(url.searchParams.get("configPath") || "");
      return json(res, 200, {
        providers: loadStore(),
        targets: TARGETS,
        formats: Object.entries(FORMATS).map(([id, f]) => ({ id, label: f.label })),
        // Ready-made endpoints for the wizard: the base URL is the one field a
        // newcomer cannot guess, and a wrong guess only fails much later.
        presets: PRESETS,
        port: PORT_ACTIVE,
        backups: listBackups(),
        undo: currentUndo(cfg.path),
        opencode: {
          path: cfg.path,
          exists: !!cfg.config,
          error: cfg.error || null,
          comments: !!cfg.comments,
          // The client echoes this back on write so a file that changed in the
          // meantime is refused instead of silently overwritten.
          hash: cfg.hash || "",
          providers: cfg.config ? openCodeProviderList(cfg.config) : [],
        },
      });
    }

    if (url.pathname === "/api/apply" && req.method === "POST") {
      const body = await readBody(req);
      const provider = body.provider || {};
      const targets = Array.isArray(body.targets) && body.targets.length ? body.targets : ["opencode"];
      const setAsDefault = provider.setAsDefault !== false;
      const results = {};
      let backupFile = null;

      if (!slugify(provider.name) || !String(provider.name || "").trim()) {
        return json(res, 400, { ok: false, error: "Поле Name обязательно" });
      }

      // 1. Persist to our own store (so it survives & can be reused), without secrets.
      const store = loadStore();
      const key = providerKeyOf(provider);
      const existingIdx = store.findIndex((p) => providerKeyOf(p) === key);
      const record = { id: provider.id || Date.now(), ...provider };
      if (existingIdx >= 0) store[existingIdx] = record; else store.push(record);
      saveStore(store);

      // 2. Apply to each target.
      for (const t of targets) {
        if (t === "opencode") {
          // The backup is taken by the writer, immediately before the write, so
          // there is no window where a snapshot is missing or already stale.
          const r = upsertProviderAsDefault(provider, {
            setAsDefault,
            configPath: body.configPath,
            defaultModelId: body.defaultModelId || provider.defaultModelId || "",
            previousKey: body.previousKey || "",
            expectedHash: body.hash,
            backup: (p) => backupConfig(p, "before-" + (provider.name || "apply")),
          });
          if (r.backupFile) backupFile = r.backupFile;
          if (!r.ok && r.conflict) {
            return json(res, 409, { ok: false, error: r.error, conflict: true, path: r.configPath });
          }
          results.opencode = {
            ok: r.ok,
            error: r.error || null,
            path: r.configPath,
            model: r.defaultModel || null,
            created: !!r.created,
            commentsLost: !!r.commentsLost,
            hash: r.hash || "",
            previousKey: r.previousKey || "",
          };
        } else {
          // Manifest + guide for the other harnesses.
          const target = TARGETS.find((x) => x.id === t) || { label: t, id: t };
          results[t] = {
            ok: true,
            manifest: buildManifest(provider),
            guide: buildGuide(provider, target),
            formatLabel: (FORMATS[provider.apiFormat] || FORMATS["openai-chat"]).label,
          };
        }
      }
      const oc = results.opencode;
      if (oc && oc.ok) {
        recordUndo(oc.path || "", backupFile, `Применение провайдера «${provider.name || ""}»`, oc.hash || "");
      }
      return json(res, 200, {
        ok: true,
        results,
        providerKey: opencodeSummary(provider),
        backupFile,
        providers: loadStore(),
      });
    }

    // Shows what a save would change, without touching the file. The plan is
    // recomputed on commit rather than stored, so a stale preview can never be
    // replayed against a file that has since moved on.
    if (url.pathname === "/api/preview" && req.method === "POST") {
      const body = await readBody(req);
      const provider = body.provider || {};
      const plan = planProviderChange(provider, {
        configPath: body.configPath,
        setAsDefault: provider.setAsDefault !== false,
        defaultModelId: body.defaultModelId || provider.defaultModelId || "",
        previousKey: body.previousKey || "",
      });
      if (!plan.ok) return json(res, 400, { ok: false, error: plan.error, path: plan.configPath });
      return json(res, 200, {
        ok: true,
        path: plan.configPath,
        providerKey: plan.providerKey,
        previousKey: plan.previousKey || "",
        defaultModel: plan.defaultModel,
        created: plan.created,
        hash: plan.hash,
        diff: buildPreview(plan.before, plan.after),
      });
    }

    // Preview of a removal, so the user sees the block disappear plus whatever
    // repointing that forces on `model` / `small_model`.
    if (url.pathname === "/api/preview-remove" && req.method === "POST") {
      const body = await readBody(req);
      const plan = planProviderRemoval(body.key || body.name, { configPath: body.configPath });
      if (!plan.ok) {
        return json(res, 400, {
          ok: false, error: plan.error, path: plan.configPath,
          notFound: plan.notFound === true,
        });
      }
      return json(res, 200, {
        ok: true,
        path: plan.configPath,
        providerKey: plan.providerKey,
        orphaned: plan.orphaned,
        hash: plan.hash,
        diff: buildPreview(plan.before, plan.after),
      });
    }

    // Removes a provider from the opencode config, not just from our own store.
    if (url.pathname === "/api/remove-provider" && req.method === "POST") {
      const body = await readBody(req);
      const r = removeProvider(body.key || body.name, {
        configPath: body.configPath,
        expectedHash: body.hash,
        backup: (p) => backupConfig(p, "before-remove"),
      });
      if (!r.ok) return json(res, r.conflict ? 409 : 400, r);
      recordUndo(r.configPath || "", r.backupFile, `Удаление провайдера «${r.providerKey || ""}»`, r.hash || "");
      // Keep our store in step so the UI does not show a provider that is gone.
      const store = loadStore().filter((p) => providerKeyOf(p) !== r.providerKey);
      saveStore(store);
      return json(res, 200, { ...r, providers: loadStore(), backups: listBackups() });
    }

    if (url.pathname === "/api/set-default-model" && req.method === "POST") {
      // Repoints the top-level `model` without touching provider blocks. The
      // diagnostics panel offers this when the default points at a dead
      // provider while a working one is already configured.
      const body = await readBody(req);
      const r = setDefaultModel(body.model || body.modelId, {
        configPath: body.configPath,
        expectedHash: body.hash,
        backup: (p) => backupConfig(p, "before-default-model"),
      });
      if (!r.ok) return json(res, r.conflict ? 409 : 400, r);
      recordUndo(r.configPath || "", r.backupFile, `Модель по умолчанию: ${r.modelId || ""}`, r.hash || "");
      return json(res, 200, { ...r, backups: listBackups() });
    }

    if (url.pathname === "/api/rename-provider" && req.method === "POST") {
      const body = await readBody(req);
      const r = renameProvider(body.from, body.to, {
        configPath: body.configPath,
        expectedHash: body.hash,
        backup: (p) => backupConfig(p, "before-rename"),
      });
      if (!r.ok) return json(res, r.conflict ? 409 : 400, r);
      recordUndo(r.configPath || "", r.backupFile, `Переименование: ${r.previousKey || ""} → ${r.providerKey || ""}`, r.hash || "");
      return json(res, 200, { ...r, backups: listBackups() });
    }

    // Which config files exist, so the user can choose which one to edit.
    if (url.pathname === "/api/configs" && req.method === "GET") {
      return json(res, 200, { ok: true, configs: listOpencodeConfigs() });
    }

    // Does the environment variable the config will point at actually exist?
    // Writing `{env:FOO}` while FOO is unset is the most common way to end up
    // with a config that looks right and authenticates with an empty string.
    // Only presence and length are reported — never the value.
    if (url.pathname === "/api/envcheck" && req.method === "POST") {
      const body = await readBody(req);
      const name = String(body.name || "").trim();
      if (!ENV_NAME_RE.test(name)) {
        return json(res, 200, { ok: false, error: "Недопустимое имя переменной" });
      }
      // Bypass the cache on an explicit check: the user may have just run setx
      // in another window and pressed the button to see the result.
      clearEnvCache();
      const info = lookupEnv(name, { useCache: false });
      // `value` must not cross the HTTP boundary — only presence, scope and
      // length. Length alone cannot reconstruct a secret but does catch a
      // truncated paste or a variable holding only whitespace.
      let note = "";
      if (!info.set) {
        note = `Переменная не найдена ни в текущем процессе, ни в постоянных настройках Windows. Создай её: ${setEnvCommand(name)}`;
      } else if (!info.scopes.includes("process")) {
        // Found in the registry but not inherited here: opencode launched from
        // a *new* terminal will see it, already-open terminals will not.
        note = "Переменная задана в системе, но появилась после запуска уже открытых терминалов — opencode нужно запускать из нового окна терминала.";
      } else if (info.length > SETX_MAX_LENGTH) {
        note = `Длина ${info.length} символов — setx обрезает значение на ${SETX_MAX_LENGTH}, ключ может быть неполным.`;
      }
      return json(res, 200, {
        ok: true,
        name,
        set: info.set,
        length: info.length,
        scope: info.scope,
        scopes: info.scopes,
        note,
      });
    }

    // Creates the variable the config points at. Without this the tool writes a
    // config referencing {env:KEY}, says "готово", and leaves the step that
    // actually makes it work to the user.
    if (url.pathname === "/api/setenv" && req.method === "POST") {
      const body = await readBody(req);
      const name = String(body.name || "").trim();
      const value = String(body.value ?? "");
      const r = setUserEnvVar(name, value);
      // The value is never echoed back, not even on success.
      if (!r.ok) {
        return json(res, 200, { ok: false, error: r.error, command: r.command || null, manual: !!r.manual });
      }
      return json(res, 200, {
        ok: true, name: r.name, length: r.length, scope: r.scope,
        note: "Переменная задана для текущего пользователя. Уже открытые терминалы её не увидят — opencode запускай из нового окна.",
      });
    }

    // The real check: one minimal completion. "Применено" only means the file
    // was written; this is what proves the provider actually answers.
    if (url.pathname === "/api/testchat" && req.method === "POST") {
      const body = await readBody(req);
      const p = body.provider || {};
      const creds = probeCredentials(p);
      if (creds.blocker) return json(res, 200, { ok: true, result: { ok: false, fault: "key", message: creds.blocker } });
      const modelId = String(body.modelId || body.model || "").trim()
        || (Array.isArray(p.models) && p.models.length ? (p.models[0].id || p.models[0]) : "");
      const result = await testCompletion({
        baseURL: p.baseURL,
        apiKey: creds.apiKey,
        apiFormat: p.apiFormat || "openai-chat",
        modelId,
      });
      return json(res, 200, { ok: true, result });
    }

    // Bulk live check. Same probe as /api/testchat, run across many models with
    // pacing — see src/batch.mjs for why it throttles and when it gives up.
    if (url.pathname === "/api/testchat-batch" && req.method === "POST") {
      const body = await readBody(req);
      const p = body.provider || {};
      const creds = probeCredentials(p);
      if (creds.blocker) {
        return json(res, 200, { ok: true, result: { ok: false, stopped: { reason: "auth", message: creds.blocker }, results: [], tested: 0, total: 0 } });
      }
      const ids = Array.isArray(body.modelIds) && body.modelIds.length
        ? body.modelIds
        : (Array.isArray(p.models) ? p.models : []).map((m) => (typeof m === "string" ? m : m?.id));
      // A live request per model costs the user money and time; refuse an
      // unbounded list rather than quietly running for ten minutes.
      if (ids.length > 200) {
        return json(res, 200, { ok: true, result: { ok: false, stopped: { reason: "too-many", message: `Слишком много моделей за раз: ${ids.length}. Максимум 200.` }, results: [], tested: 0, total: ids.length } });
      }
      const result = await runBatch(ids, (modelId) => testCompletion({
        baseURL: p.baseURL,
        apiKey: creds.apiKey,
        apiFormat: p.apiFormat || "openai-chat",
        modelId,
      }), { concurrency: Number(body.concurrency) || undefined, gapMs: Number(body.gapMs) || undefined });
      return json(res, 200, { ok: true, result });
    }

    if (url.pathname === "/api/validate" && req.method === "GET") {
      const cfg = readConfig(url.searchParams.get("configPath") || "");
      const issues = cfg.config ? validateConfig(cfg.config) : [{ severity: "error", id: "parse", message: cfg.error || "Не удалось прочитать конфиг" }];
      return json(res, 200, { ok: true, path: cfg.path, issues, backups: listBackups() });
    }

    if (url.pathname === "/api/test" && req.method === "POST") {
      const body = await readBody(req);
      const p = body.provider || body;
      const probe = probeCredentials(p);
      // A reference to a variable that does not exist cannot succeed: opencode
      // would send an empty bearer token. Report that directly instead of
      // returning a provider 401 the user then has to interpret.
      if (probe.blocker) return json(res, 200, { ok: true, result: { ok: false, message: probe.blocker } });
      const result = await testConnection({ ...p, apiKey: probe.apiKey });
      return json(res, 200, { ok: true, result });
    }

    if (url.pathname === "/api/discover" && req.method === "POST") {
      const body = await readBody(req);
      const p = body.provider || body;
      const probe = probeCredentials(p);
      if (probe.blocker) return json(res, 200, { ok: true, result: { ok: false, message: probe.blocker } });
      // apiFormat has to be forwarded: an anthropic-style endpoint authenticates
      // with `x-api-key`, and sending `Authorization: Bearer` instead produced a
      // 401 that looked like a bad key.
      const result = await fetchModels({
        baseURL: p.baseURL,
        apiKey: probe.apiKey,
        apiFormat: p.apiFormat || "openai-chat",
      });
      // Some gateways answer with nothing but an id. Fill the blanks from the
      // models.dev catalogue where its sources agree, so the user is not left
      // hand-typing context windows for dozens of models. Never fills a price,
      // and never overwrites what this provider reported about itself.
      if (result.ok && Array.isArray(result.models) && result.models.length && body.enrich !== false) {
        const cat = await loadCatalog();
        if (cat.ok) {
          const e = enrichModels(cat, result.models);
          result.models = e.models;
          result.enriched = { matched: e.matched, filled: e.filled, source: "models.dev" };
        } else {
          // Say why rather than silently returning bare ids; the catalogue being
          // down is not the same as the models having no specs.
          result.enriched = { matched: 0, filled: 0, error: cat.error };
        }
      }
      return json(res, 200, { ok: true, result });
    }

    if (url.pathname === "/api/diagnostics" && req.method === "GET") {
      // Full health check: config issues + connectivity of every provider.
      const cfg = readConfig(url.searchParams.get("configPath") || "");
      const issues = cfg.config ? validateConfig(cfg.config) : [{ severity: "error", id: "parse", message: cfg.error || "не удалось прочитать конфиг" }];
      // Probed in parallel: each endpoint can take up to 8s, so a serial loop
      // over a dozen providers meant a two-minute request that usually timed out
      // in the browser before it ever returned.
      const entries = Object.entries(cfg.config?.provider || {})
        .filter(([, p]) => p && typeof p === "object" && p.type !== "local");
      const providers = await Promise.all(entries.map(async ([key, p]) => {
        const base = p.options?.baseURL || p.baseURL || "";
        // An unresolved {env:VAR} would be sent as the literal key; resolve it
        // so the probe reflects what opencode itself would send.
        const decoded = decodeApiKey(p.options?.apiKey);
        // lookupEnv, not process.env: a variable set with setx after this
        // process started is invisible to process.env, and reporting "key not
        // sent" in that case blames the wrong thing.
        const envHit = decoded.useEnvVar ? lookupEnv(decoded.envVarName) : null;
        const apiKey = decoded.useEnvVar ? (envHit?.value || "") : decoded.apiKey;
        // A provider without its own baseURL (opencode zen, a plain @ai-sdk/*
        // package) talks to the endpoint baked into the package. There is
        // nothing here to probe, and calling that "недоступен" is a false alarm
        // about a provider that works fine.
        const conn = base
          ? await testConnection({ baseURL: base, apiKey, apiFormat: detectApiFormat(p) })
          : {
              ok: true, reach: "unknown",
              message: "Проба невозможна: у провайдера нет своего Base URL — адрес берётся из npm-пакета",
            };
        return {
          key,
          baseURL: base,
          nModels: Object.keys(p.models || {}).length,
          isDefault: String(cfg.config?.model || "").startsWith(key + "/"),
          ok: conn.ok,
          conn: conn.message,
          // reach/fault let the UI separate "their server is down" from "your
          // key is wrong" instead of showing one undifferentiated red line.
          reach: conn.reach || null,
          fault: conn.fault || null,
          kind: conn.kind || null,
          viaProxy: Boolean(conn.viaProxy),
          models: Object.keys(p.models || {}),
        };
      }));
      // Naming the proxy once, at the top level, saves the user from guessing
      // whether the probes went out directly or through a tunnel.
      const proxyUsed = describeProxy(proxyForUrl("https://example.com"));
      // Умный аудит — чистая статика, считается миллисекунды, поэтому едет
      // в том же ответе: свеж при каждой диагностике без отдельного запроса.
      return json(res, 200, {
        ok: true, path: cfg.path, issues, providers,
        model: cfg.config?.model || null, backups: listBackups(),
        proxy: proxyUsed || null,
        smart: smartAudit(cfg.config),
      });
    }

    // Автоисправление: что именно будет поправлено — сначала diff, потом запись.
    // Ничего не пишется без подтверждения: preview только считает, apply пишет.
    if (url.pathname === "/api/autofix-preview" && req.method === "POST") {
      const body = await readBody(req);
      const cfg = readConfig(body.configPath);
      if (!cfg.config) {
        return json(res, 400, { ok: false, error: "opencode config не разобран: " + (cfg.error || "неизвестная ошибка"), path: cfg.path });
      }
      const { changes, fixes, skipped } = buildAutoFixChanges(cfg.config);
      if (!changes.length) {
        return json(res, 200, {
          ok: true, path: cfg.path, fixes, skipped, hash: cfg.hash || "",
          diff: buildPreview(cfg.raw, cfg.raw), remaining: validateConfig(cfg.config),
        });
      }
      const applied = applyChangesVerified(cfg.raw, changes);
      if (!applied.ok) return json(res, 400, { ok: false, error: applied.error, path: cfg.path });
      return json(res, 200, {
        ok: true, path: cfg.path, fixes, skipped, hash: cfg.hash || "",
        diff: buildPreview(cfg.raw, applied.text), remaining: validateConfig(applied.value),
      });
    }

    if (url.pathname === "/api/autofix-apply" && req.method === "POST") {
      const body = await readBody(req);
      const cfg = readConfig(body.configPath);
      if (!cfg.config) {
        return json(res, 400, { ok: false, error: "opencode config не разобран: " + (cfg.error || "неизвестная ошибка"), path: cfg.path });
      }
      const { changes, fixes, skipped } = buildAutoFixChanges(cfg.config);
      if (!changes.length) {
        return json(res, 200, { ok: true, noop: true, path: cfg.path, fixed: fixes, skipped, hash: cfg.hash || "", backups: listBackups() });
      }
      const applied = applyChangesVerified(cfg.raw, changes);
      if (!applied.ok) return json(res, 400, { ok: false, error: applied.error, path: cfg.path });
      const remaining = validateConfig(applied.value);
      const committed = commitPlan(
        { ok: true, configPath: cfg.path, before: cfg.raw, after: applied.text, changes, hash: cfg.hash || "" },
        { expectedHash: body.hash, backup: (p) => backupConfig(p, "before-autofix") },
      );
      if (!committed.ok) return json(res, committed.conflict ? 409 : 400, committed);
      recordUndo(committed.configPath || "", committed.backupFile, "Автоисправление конфига", committed.hash || "");
      return json(res, 200, {
        ok: true, path: committed.configPath, fixed: fixes, skipped, remaining,
        hash: committed.hash || "", backupFile: committed.backupFile || null,
        backups: listBackups(), diff: buildPreview(cfg.raw, applied.text),
      });
    }

    // Обновление моделей: сверяет конфиг с живым /models каждого провайдера.
    // По умолчанию только план (apply:false). С apply:true добавляет недостающие
    // модели, а с prune:true ещё и удаляет те, что сервер больше не отдаёт.
    // Существующие записи не перезаписываются — ручные правки сохраняются.
    if (url.pathname === "/api/refresh-models" && req.method === "POST") {
      const body = await readBody(req);
      const cfg = readConfig(body.configPath);
      if (!cfg.config) {
        return json(res, 400, { ok: false, error: "opencode config не разобран: " + (cfg.error || "неизвестная ошибка"), path: cfg.path });
      }
      const keys = Array.isArray(body.providers) && body.providers.length ? body.providers : null;
      const prune = body.prune === true;
      const enrich = body.enrich === true;
      const plan = await planRefresh(cfg.config, { providerKeys: keys, prune, enrich });
      // В превью pending раскрывается с free-меткой, чтобы интерфейс мог
      // предложить «только бесплатные» без повторного опроса серверов.
      const withFree = plan.map((p) => ({
        ...p,
        added: (p.pending || []).map((x) => ({
          id: x.id,
          free: isFreeEntry(x.entry),
          ...(x.entry?.cost ? { cost: x.entry.cost } : {}),
        })),
      }));
      if (!body.apply) {
        return json(res, 200, {
          ok: true, path: cfg.path, hash: cfg.hash || "",
          providers: withFree.map(({ pending, ...rest }) => ({
            ...rest, addedCount: (rest.added || []).length,
            removedCount: (rest.removed || []).length,
          })),
        });
      }
      // Белый список моделей из превью: так «только бесплатные» применяется
      // ровно к тому, что пользователь видел, а не к свежему опросу.
      const changes = buildRefreshChanges(plan, { only: body.models ?? null, prune, enrich });
      if (!changes.length) {
        return json(res, 200, {
          ok: true, noop: true, path: cfg.path, hash: cfg.hash || "",
          providers: plan, backups: listBackups(),
        });
      }
      const applied = applyChangesVerified(cfg.raw, changes);
      if (!applied.ok) return json(res, 400, { ok: false, error: applied.error, path: cfg.path });
      const committed = commitPlan(
        { ok: true, configPath: cfg.path, before: cfg.raw, after: applied.text, changes, hash: cfg.hash || "" },
        { expectedHash: body.hash, backup: (p) => backupConfig(p, "before-refresh-models") },
      );
      if (!committed.ok) return json(res, committed.conflict ? 409 : 400, committed);
      recordUndo(committed.configPath || "", committed.backupFile, "Обновление моделей", committed.hash || "");
      return json(res, 200, {
        ok: true, path: committed.configPath, providers: plan,
        hash: committed.hash || "", backupFile: committed.backupFile || null,
        backups: listBackups(), diff: buildPreview(cfg.raw, applied.text),
      });
    }

    // Самодиагностика инструмента: Node, каталоги, конфиг, прокси, каталог.
    if (url.pathname === "/api/selfcheck" && req.method === "GET") {
      const result = await runSelfCheck({ configPath: url.searchParams.get("configPath") || "" });
      return json(res, 200, { ok: true, ...result, backups: listBackups() });
    }

    // Reverts the last write recorded by recordUndo. The current file is
    // snapshotted first ("before-undo"), so even a mistaken undo is recoverable
    // from the backup list. Single-level by design: after reverting there is
    // nothing left to revert to.
    if (url.pathname === "/api/undo" && req.method === "POST") {
      const body = await readBody(req);
      const cfg = readConfig(body.configPath);
      const entry = readUndo();
      if (!entry || entry.configPath !== cfg.path) {
        return json(res, 200, { ok: false, error: "Откатывать нечего" });
      }
      if (entry.created) {
        // Undoing a creation removes the file — but only if it is still exactly
        // what the write produced. Otherwise the file holds someone else's
        // edits and deleting it would destroy them.
        if (!cfg.config || (cfg.hash || "") !== (entry.afterHash || "")) {
          clearUndo();
          return json(res, 200, { ok: false, error: "Файл изменился после записи — откат небезопасен, восстанови из бэкапа вручную" });
        }
        backupConfig(cfg.path, "before-undo");
        try { unlinkSync(cfg.path); } catch (e) {
          return json(res, 200, { ok: false, error: "Не удалось удалить файл: " + (e?.message || e) });
        }
        clearUndo();
        return json(res, 200, { ok: true, label: entry.label, removed: true, hash: "", backups: listBackups(), undo: null });
      }
      const snap = restoreBackup(entry.file);
      if (!snap.ok) {
        clearUndo();
        return json(res, 200, { ok: false, error: "Снапшот потерян (" + snap.error + ") — откат невозможен" });
      }
      // The file must still be what the reverted write produced. Otherwise an
      // external edit landed in between, and restoring the snapshot would
      // silently destroy it — the same loss the hash guard prevents on every
      // other write path. Old records (before afterHash existed) carry "" and
      // skip the check: refusing them all would strand previously valid undos.
      if (entry.afterHash && cfg.config && (cfg.hash || "") !== entry.afterHash) {
        return json(res, 200, {
          ok: false,
          error: "Файл изменился после записи — откат затёр бы чужие правки. Восстанови из бэкапа вручную",
        });
      }
      let preFile = null;
      if (cfg.config) preFile = backupConfig(cfg.path, "before-undo");
      writeConfigText(snap.raw, cfg.path);
      clearUndo();
      const after = readConfig(cfg.path);
      return json(res, 200, {
        ok: true, label: entry.label, file: snap.file, preFile,
        hash: after.hash || "", backups: listBackups(), undo: null,
      });
    }

    // Ежедневный дайджест халявы и новостей (борд Ailyre, публичные JSON-фиды).
    // Только чтение: кэш на 6 часов лежит в dataDir, при недоступности сети
    // отдаётся протухший кэш с пометкой, а refresh=1 дёргает сеть принудительно.
    if (url.pathname === "/api/digest" && req.method === "GET") {
      try {
        const digest = await loadDigest({ refresh: url.searchParams.get("refresh") === "1" });
        return json(res, 200, { ok: true, ...digest });
      } catch (e) {
        return json(res, 200, { ok: false, error: `Дайджест недоступен: ${e?.message || e}`, perks: [], news: [] });
      }
    }

    if (url.pathname === "/api/backup" && req.method === "POST") {
      const body = await readBody(req);
      const cfg = readConfig(body.configPath);
      const file = cfg.config ? backupConfig(cfg.path, "manual") : null;
      return json(res, 200, { ok: true, file, backups: listBackups() });
    }

    if (url.pathname === "/api/restore" && req.method === "POST") {
      const body = await readBody(req);
      const r = restoreBackup(body.file);
      if (!r.ok) return json(res, 400, { ok: false, error: r.error });
      // A backup belongs to the file it was taken from, not to the file the UI
      // happens to be viewing: restoring B's snapshot into A is a silent
      // cross-file overwrite. Snapshots that predate the origin index have no
      // origin recorded and fall back to the requested file, as before.
      const cfg = r.origin ? readConfigAtPath(r.origin) : readConfig(body.configPath);
      // Safety: snapshot current config before overwriting.
      let preFile = null;
      if (cfg.config) preFile = backupConfig(cfg.path, "before-restore");
      // Restores the exact bytes of the snapshot. Re-serialising the parsed
      // object instead would silently strip the comments the backup preserved.
      const written = writeConfigText(r.raw, cfg.path);
      if (!written.ok) return json(res, 400, { ok: false, error: written.error, path: cfg.path });
      recordUndo(cfg.path, preFile, "Восстановление из бэкапа", written.hash || "");
      return json(res, 200, {
        ok: true, file: r.file, path: cfg.path, origin: r.origin || null,
        preFile, hash: written.hash || "", backups: listBackups(),
      });
    }

    if (url.pathname === "/api/import" && req.method === "POST") {
      // Load providers already present in the opencode config into our store so they can be edited.
      const body = await readBody(req);
      const cfg = readConfig(body.configPath);
      if (!cfg.config) return json(res, 400, { ok: false, error: "opencode config не прочитан" });
      const store = loadStore();
      const imported = [];
      for (const [key, p] of Object.entries(cfg.config.provider || {})) {
        if (!isCustomProviderBlock(p)) continue; // built-in providers need no manual block
        if (store.some((s) => providerKeyOf(s) === key)) continue;
        store.push(decodeOpenProvider(key, p));
        imported.push(key);
      }
      saveStore(store);
      return json(res, 200, { ok: true, imported, providers: loadStore() });
    }

    if (url.pathname === "/api/delete" && req.method === "POST") {
      const body = await readBody(req);
      const key = slugify(body.name);
      const store = loadStore().filter((p) => providerKeyOf(p) !== key);
      saveStore(store);
      return json(res, 200, { ok: true, providers: loadStore() });
    }

    return serveStatic(res, url.pathname);
  } catch (e) {
    const code = Number(e?.statusCode) >= 400 && Number(e?.statusCode) < 600 ? Number(e.statusCode) : 500;
    return json(res, code, { ok: false, error: String(e && e.message || e) });
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    const next = PORT_ACTIVE + 1;
    if (next > WANTED + 20) {
      console.error("\n  Все порты с " + WANTED + " по " + (WANTED + 20) + " заняты.\n");
      process.exit(1);
    }
    PORT_ACTIVE = next;
    server.listen(next, HOST, () => announce(next));
  } else {
    console.error("\n  Сервер не смог запуститься:", err.message, "\n");
    process.exit(1);
  }
});

function announce(port) {
  PORT_ACTIVE = port;
  const url = `http://localhost:${port}`;
  console.log(`\n  Provider Studio running:  ${url}\n`);
  console.log(`  opencode config: ${readConfig().path}`);
  if (HOST !== "127.0.0.1" && HOST !== "localhost") {
    console.log(`\n  ВНИМАНИЕ: сервер слушает ${HOST} — API без авторизации и отдаёт конфиг с ключами.`);
  }
  // Both spellings are honoured: NO_OPEN was the original, PS_NO_OPEN matches
  // the PS_ prefix used by every other switch.
  if (process.env.NO_OPEN !== "1" && process.env.PS_NO_OPEN !== "1") {
    const cmd = process.platform === "win32" ? `start "" "${url}"` : `open "${url}"`;
    exec(cmd, () => {});
  }
}

// The packaged build needs to prove the embedded UI is actually reachable, and
// importing the bundle needs to be possible without binding a port. Both are
// opt-in so the normal path is untouched.
if (process.env.PS_NO_LISTEN === "1") {
  // Loaded for inspection only (used by the build to catch top-level crashes).
} else if (process.env.PS_SELFTEST === "1") {
  runSelfTest();
} else {
  // The EADDRINUSE handler registered above walks to the next free port, so no
  // extra error handling belongs here: a second one would pre-empt it and turn
  // "port busy" back into a hard failure.
  server.listen(WANTED, HOST, () => announce(WANTED));
}

// Starts the server, fetches the pages the UI cannot work without, and exits
// non-zero if anything is missing. This is what makes "the exe built" mean "the
// exe works" rather than just "postject did not complain".
async function runSelfTest() {
  const failures = [];
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(WANTED, HOST, resolve);
  }).catch((err) => {
    console.error(`selftest: could not listen on ${HOST}:${WANTED} — ${err.message}`);
    process.exit(1);
  });
  PORT_ACTIVE = WANTED;
  const base = `http://127.0.0.1:${WANTED}`;
  console.log(`selftest: listening on ${base}`);
  console.log(`selftest: packaged=${isPackaged()} publicDir=${publicDir() || "(embedded)"}`);

  const expect = async (label, urlPath, check) => {
    try {
      const r = await fetch(base + urlPath, { headers: { Host: `localhost:${WANTED}` } });
      const body = await r.text();
      const bad = check(r, body);
      if (bad) failures.push(`${label}: ${bad}`);
      else console.log(`selftest: ${label} ok (${body.length} bytes)`);
    } catch (err) {
      failures.push(`${label}: request failed — ${err.message}`);
    }
  };

  await expect("GET /", "/", (r, b) =>
    r.status !== 200 ? `status ${r.status}` : !b.includes("Provider Studio") ? "index.html has no title" : "");
  await expect("GET /app.js", "/app.js", (r, b) =>
    r.status !== 200 ? `status ${r.status}` : !b.includes("/api/preview") ? "app.js looks truncated" : "");
  await expect("GET /style.css", "/style.css", (r, b) =>
    r.status !== 200 ? `status ${r.status}` : b.length < 100 ? "style.css looks empty" : "");
  await expect("GET /api/state", "/api/state", (r, b) => {
    if (r.status !== 200) return `status ${r.status}`;
    try {
      const j = JSON.parse(b);
      // Without these the front end cannot render its form at all.
      if (!Array.isArray(j.formats) || !j.formats.length) return "no formats";
      if (!Array.isArray(j.targets) || !j.targets.length) return "no targets";
      if (!j.opencode || typeof j.opencode.path !== "string") return "no opencode summary";
      return "";
    } catch { return "response is not JSON"; }
  });
  // The traversal guard must survive bundling: in a SEA build there is no
  // filesystem to fall back on, so a regression here fails open.
  await expect("traversal blocked", "/..%5c..%5cserver.mjs", (r) =>
    r.status === 200 ? "escaped the asset root" : "");
  await expect("missing asset 404s", "/nope.txt", (r) =>
    r.status !== 404 ? `status ${r.status}` : "");

  // Calling process.exit() while the handle is still closing trips a libuv
  // assertion on Windows ("!(handle->flags & UV_HANDLE_CLOSING)"), which the
  // build would report as a failed self-test even though every check passed.
  // Wait for the close callback and let the event loop drain on its own.
  await new Promise((resolve) => server.close(resolve));

  if (failures.length) {
    console.error("\nselftest FAILED:");
    for (const f of failures) console.error("  - " + f);
    process.exitCode = 1;
    return;
  }
  console.log("selftest: all checks passed");
  process.exitCode = 0;
}

// ---------- opencode -> form provider mapping ----------
// Reconstruct an editable provider object from an opencode config block.
function decodeOpenProvider(key, p) {
  const base = p.options?.baseURL || p.baseURL || "";
  // Earlier versions of this tool (and hand-edited configs) put the key on the
  // provider root, where opencode never reads it. Fall back to it so importing
  // such a block does not lose the key that is plainly written in the file.
  const { useEnvVar, envVarName, apiKey } = decodeApiKey(p.options?.apiKey ?? p.apiKey);
  // One canonical translator, shared with the manage view: the inline copy
  // used 0 for unknown limits, and 0 counts as "submitted" for managed keys —
  // so re-saving an imported provider silently deleted every limit it had.
  const models = Object.entries(p.models || {}).map(([id, m]) => modelEntryToForm(id, m));
  return {
    id: Date.now() + Math.floor(Math.random() * 1000),
    fromOpenCode: true,
    // The real config key, so the UI can preview which key a name maps to and
    // warn before an accidental overwrite of a different provider.
    key,
    // `name` doubles as the display label and the source of the opencode key.
    // Ignore it when it actually holds a package (a bug in earlier versions).
    name: !looksLikePackage(p.name) && slugify(p.name) === key ? p.name : key,
    baseURL: base,
    apiKey,
    useEnvVar,
    envVarName,
    apiFormat: detectApiFormat(p),
    // Carried through the round trip so a re-save preserves them. They are only
    // set when the config actually has them: an undefined `headers` means "the
    // form never submitted one", which is what stops buildProviderChanges from
    // treating an ordinary save as a request to delete them.
    ...(p.options?.headers ? { headers: p.options.headers } : {}),
    ...(p.options?.timeout ? { timeout: p.options.timeout } : {}),
    models,
  };
}

function openCodeProviderList(config) {
  return Object.entries(config.provider || {})
    .filter(([, p]) => isCustomProviderBlock(p))
    .map(([key, p]) => decodeOpenProvider(key, p));
}
