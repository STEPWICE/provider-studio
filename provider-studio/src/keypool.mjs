// src/keypool.mjs
// Пул API-ключей с умным автопереключением.
//
// Зачем отдельный модуль, а не поле в formats.mjs:
//   - opencode принимает ровно один `options.apiKey` на провайдера, поэтому
//     «пул» не пишется в конфиг как массив — он разворачивается либо в N
//     блоков-шардов (по одному ключу в каждом), либо в один блок + плагин,
//     который переставляет ключи уже в рантайме opencode;
//   - секреты не должны пересекать HTTP-границу туда-обратно: сюда приходят
//     сырые ключи из формы, а наружу уходят только маски и вердикты.
//     Хранятся ключи только в переменных окружения ОС (см. src/env.mjs),
//     в файлах лежат лишь ссылки `{env:...}`.
//
// Чего модуль НЕ делает:
//   - не пишет на диск (это делают server.mjs через commitPlan и запись
//     плагина рядом с конфигом);
//   - не обещает универсальный «баланс»: единый API баланса есть только
//     у отдельных шлюзов (OpenRouter), у остальных — лишь классификация
//     ошибки живого запроса (401/402/429/«insufficient balance»).

import { proxyForUrl, proxyFetch } from "./proxy.mjs";
import { slugify, suggestEnvVarName } from "./formats.mjs";

/** Больше ключей за раз не принимаем: каждый ключ — это живые запросы. */
export const MAX_POOL_KEYS = 20;

/** Минимум символов, короче — почти наверняка обрезанная вставка. */
export const MIN_KEY_LENGTH = 8;

/**
 * Разбирает многострочное поле «по ключу с новой строки».
 * Пустые строки пропускаются молча, дубли отбрасываются с подсчётом,
 * хвост сверх MAX_POOL_KEYS отрезается (truncated = сколько отрезано).
 */
export function parseKeyPool(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const keys = [];
  const seen = new Set();
  let emptyLines = 0;
  let droppedDuplicates = 0;
  for (const line of lines) {
    const k = line.trim();
    if (!k) { emptyLines++; continue; }
    if (seen.has(k)) { droppedDuplicates++; continue; }
    seen.add(k);
    keys.push(k);
  }
  let truncated = 0;
  if (keys.length > MAX_POOL_KEYS) {
    truncated = keys.length - MAX_POOL_KEYS;
    keys.length = MAX_POOL_KEYS;
  }
  return { keys, emptyLines, droppedDuplicates, truncated };
}

/** Маска для UI/ответов: виден только хвост, восстановить ключ нельзя. */
export function maskKey(key) {
  const k = String(key || "");
  if (k.length <= 8) return "••••";
  return `••••${k.slice(-4)}`;
}

/**
 * Имена переменных под пул: первая сохраняет базовое имя (совместимость
 * с уже записанным `{env:BASE}`), остальные — с числовым суффиксом.
 */
export function poolEnvNames(envBase, count) {
  const base = String(envBase || "").trim() || "PROVIDER_API_KEY";
  const n = Math.max(1, Math.min(MAX_POOL_KEYS, Number(count) || 1));
  if (n === 1) return [base];
  return Array.from({ length: n }, (_, i) => (i === 0 ? base : `${base}_${i + 1}`));
}

/** База env-имени из названия провайдера, как в одиночном режиме. */
export function poolEnvBaseFor(providerKeyOrName) {
  return suggestEnvVarName(slugify(providerKeyOrName || "provider"));
}

/**
 * Валидация пула до любых сетевых проб. Возвращает "" когда всё хорошо.
 */
export function validateKeyPool(keys) {
  const list = Array.isArray(keys) ? keys : [];
  if (!list.length) return "Вставь хотя бы один ключ (по одному на строке)";
  if (list.length > MAX_POOL_KEYS) return `Слишком много ключей: ${list.length}. Максимум ${MAX_POOL_KEYS}.`;
  const short = list.findIndex((k) => String(k).length < MIN_KEY_LENGTH);
  if (short >= 0) return `Ключ №${short + 1} короче ${MIN_KEY_LENGTH} символов — похоже на обрезанную вставку`;
  return "";
}

/**
 * Решает, есть ли смысл пробовать следующий ключ пула после такой ошибки.
 *
 * Карта повторяет классификацию src/rescue.mjs (fault), но отвечает на
 * другой вопрос: не «кто виноват», а «поможет ли другой ключ»:
 *   - key/plan/quota/blocked/transient/endpoint/timeout — да, следующий ключ
 *     либо рабочий, либо со своим лимитом/балансом;
 *   - model (404 неверный id), nokey (ключ вообще не отправлен — битый конфиг),
 *     proxy (сеть не вышла наружу) — нет, следующий ключ даст то же самое.
 */
export function shouldRotate(result) {
  const r = result && typeof result === "object" ? result : {};
  const fault = String(r.fault || "");
  const status = Number(r.status) || 0;
  if (r.ok) return { rotate: false, cooldownMs: 0, reason: "ok" };
  if (fault === "model" || fault === "nokey" || fault === "proxy") {
    return { rotate: false, cooldownMs: 0, reason: fault || "config" };
  }
  // 429 без разбора fault тоже ротируем: лимит почти всегда именно на ключ.
  if (status === 429) return { rotate: true, cooldownMs: 60_000, reason: "rate-limited" };
  if (fault === "quota") return { rotate: true, cooldownMs: 60_000, reason: "quota" };
  if (fault === "plan") return { rotate: true, cooldownMs: 0, reason: "plan" };
  if (fault === "key") return { rotate: true, cooldownMs: 0, reason: "key" };
  if (fault === "blocked" || r.transient === true) return { rotate: true, cooldownMs: 10_000, reason: "transient" };
  // 5xx сервера — временное, следующий ключ (другой аккаунт/квота) может пройти.
  if (status >= 500 && status < 600) return { rotate: true, cooldownMs: 30_000, reason: "server" };
  // Сеть/таймаут без статуса: запрос никуда не дошёл, смена ключа не вредит.
  if (!status) return { rotate: true, cooldownMs: 0, reason: "transport" };
  return { rotate: false, cooldownMs: 0, reason: "endpoint" };
}

/**
 * Состояние ротации для одного процесса: round-robin с пропуском мёртвых
 * и находящихся на кулдауне ключей.
 */
export function createPoolState(size) {
  const n = Math.max(1, Math.min(MAX_POOL_KEYS, Number(size) || 1));
  return {
    size: n,
    cursor: 0,
    // failures[i] — подряд идущие ротации с ключа i; cooldownUntil[i] — ms-epoch.
    failures: Array(n).fill(0),
    cooldownUntil: Array(n).fill(0),
    dead: Array(n).fill(false),
  };
}

/** Следующий живой индекс, начиная с курсора. -1, когда живых нет. */
export function pickPoolIndex(state, now = Date.now()) {
  const n = state?.size || 0;
  if (!n) return -1;
  for (let step = 0; step < n; step++) {
    const i = (state.cursor + step) % n;
    if (state.dead[i]) continue;
    if (state.cooldownUntil[i] > now) continue;
    state.cursor = (i + 1) % n;
    return i;
  }
  return -1;
}

/**
 * Учёт исхода запроса через ключ i. Неверный ключ (fault key) умирает сразу
 * и навсегда до ручного сброса; квота — уходит на кулдаун с ростом;
 * успех — обнуляет счётчик ключа.
 */
export function recordPoolResult(state, index, result, now = Date.now()) {
  if (!state || index < 0 || index >= state.size) return;
  const r = result && typeof result === "object" ? result : {};
  if (r.ok) {
    state.failures[index] = 0;
    state.cooldownUntil[index] = 0;
    return;
  }
  const decision = shouldRotate(r);
  state.failures[index] += 1;
  if (String(r.fault || "") === "key" || Number(r.status) === 401) {
    state.dead[index] = true;
    state.cooldownUntil[index] = 0;
    return;
  }
  if (decision.rotate && decision.cooldownMs > 0) {
    const backoff = Math.min(300_000, decision.cooldownMs * 2 ** Math.min(3, state.failures[index] - 1));
    state.cooldownUntil[index] = now + backoff;
  }
}

// ------------------------------------------------------------ баланс ключа

/**
 * Best-effort баланс одного ключа. Сейчас поддерживается OpenRouter
 * (GET {base}/key -> {data:{limit,usage}}); для остальных возвращается
 * {supported:false} — вердикт даёт живая проба (fault plan/quota/key),
 * а не выдуманная цифра.
 */
export async function fetchKeyBalance({ baseURL, apiKey, timeoutMs = 10000 } = {}) {
  const base = String(baseURL || "").trim().replace(/\/+$/, "");
  const key = String(apiKey || "").trim();
  if (!base || !key) return { supported: false, ok: false, note: "Нужны Base URL и ключ" };
  let u;
  try { u = new URL(base); } catch { return { supported: false, ok: false, note: "Некорректный Base URL" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { supported: false, ok: false, note: "Нужен http(s) URL" };
  }
  const host = u.hostname.toLowerCase();
  const isOpenRouter = host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  if (!isOpenRouter) return { supported: false, ok: false, note: "Провайдер не отдаёт баланс через API — вердикт даст живая проба" };

  const target = `${base}/key`;
  const headers = { Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": "provider-studio/1.0" };
  let r;
  try {
    const proxy = proxyForUrl(target);
    if (proxy) {
      r = await proxyFetch(target, { headers, timeoutMs, proxy });
    } else {
      r = await fetch(target, { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    }
  } catch (e) {
    return { supported: true, ok: false, note: `Не удалось спросить баланс: ${e?.message || e}` };
  }
  let body = "";
  try { body = await r.text(); } catch { body = ""; }
  if (!r.ok) {
    return { supported: true, ok: false, status: r.status, note: `Баланс не отдан (HTTP ${r.status})` };
  }
  try {
    const j = JSON.parse(body);
    const d = j?.data || j;
    const limit = Number(d?.limit);
    const usage = Number(d?.usage);
    const out = { supported: true, ok: true, label: typeof d?.label === "string" ? d.label : "" };
    if (Number.isFinite(limit)) out.limit = limit;
    if (Number.isFinite(usage)) out.usage = usage;
    if (Number.isFinite(limit) && Number.isFinite(usage)) out.remaining = limit - usage;
    return out;
  } catch {
    return { supported: true, ok: false, note: "Неразборчивый ответ баланса" };
  }
}

// ------------------------------------------------------- развёртка в конфиг

/**
 * Строит N форм провайдеров-шардов из одной логической формы + пула.
 * Первый шард сохраняет исходный ключ/имя (обратная совместимость:
 * уже настроенный `model: slug/...` продолжает работать), остальные
 * получают суффиксы `-2..N` и `envBase_2..N`.
 */
export function buildPoolShards(provider, envBase, keys) {
  const list = Array.isArray(keys) ? keys : [];
  const base = String(envBase || "").trim() || poolEnvBaseFor(provider?.name);
  const p = provider && typeof provider === "object" ? provider : {};
  const baseName = String(p.displayName || p.name || "provider").trim() || "provider";
  const baseKey = String(p.key || p.name || baseName).trim() || baseName;
  return list.map((k, i) => ({
    ...p,
    key: i === 0 ? baseKey : `${baseKey}-${i + 1}`,
    name: baseName,
    displayName: i === 0 ? baseName : `${baseName} ${i + 1}`,
    useEnvVar: true,
    envVarName: i === 0 ? base : `${base}_${i + 1}`,
    // Сырой ключ живёт только до записи в env; в store/конфиг он не попадает
    // (server.mjs срезает его через stripSecrets, в opencode пишется ссылка).
    apiKey: String(k || ""),
  }));
}

/** Имя файла плагина рядом с конфигом: keypool-<slug>.mjs */
export function poolPluginFileName(providerKey) {
  return `keypool-${slugify(providerKey || "provider")}.mjs`;
}

/**
 * Исходник opencode-плагина автопереключения. Секретов внутри нет —
 * только имена переменных и адрес; ключи читаются из process.env
 * в момент запроса, поэтому `setx` без правок файла подхватывается
 * после перезапуска opencode.
 *
 * Плагин патчит globalThis.fetch при загрузке: запросы на baseURL
 * идут с ротацией Authorization, ответы-классификаторы (401/402/429/5xx,
 * «insufficient balance/credit», «rate limit») переключают на следующий
 * ключ и повторяют запрос (тело — только строковое/пустое, иначе повтор
 * небезопасен и возвращается первый ответ).
 */
export function buildKeypoolPlugin({ providerKey, displayName, baseURL, apiFormat, envNames }) {
  const base = String(baseURL || "").trim().replace(/\/+$/, "");
  const names = (Array.isArray(envNames) ? envNames : []).map((n) => String(n || "").trim()).filter(Boolean);
  const fileName = poolPluginFileName(providerKey);
  const anthropic = String(apiFormat || "").includes("anthropic");
  // Display text lands inside // line comments of generated code that opencode
  // executes. A newline in the name would break out of the comment and inject
  // arbitrary JS into the plugin (e.g. an imported config with a crafted name),
  // so it is flattened to a single line; */ is neutralised for the same reason.
  const safeLabel = String(displayName || providerKey || "provider").replace(/[\r\n]+/g, " ").replace(/\*\//g, "* /").slice(0, 120);
  const safeKey = String(providerKey || "pool").replace(/[^a-z0-9-]/gi, "");
  const lines = [
    `// ${fileName} — автопереключение пула ключей «${safeLabel}».`,
    `// Сгенерировано Provider Studio. Секретов здесь нет: ключи берутся из переменных`,
    `// окружения (${names.join(", ") || "—"}) в момент запроса.`,
    `// Логика: round-robin, пропуск мёртвых (401) и кулдаун квоты (429/5xx/balance).`,
    ``,
    `const POOL_ENVS = ${JSON.stringify(names)};`,
    `const POOL_BASE = ${JSON.stringify(base)};`,
    `const POOL_ANTHROPIC = ${anthropic ? "true" : "false"};`,
    ``,
    `const poolState = { cursor: 0, dead: new Set(), cooldownUntil: new Map(), fails: new Map() };`,
    ``,
    `function poolKeys() {`,
    `  const now = Date.now();`,
    `  const alive = [];`,
    `  for (const env of POOL_ENVS) {`,
    `    const v = (process.env[env] || "").trim();`,
    `    if (!v) continue;`,
    `    if (poolState.dead.has(env)) continue;`,
    `    if ((poolState.cooldownUntil.get(env) || 0) > now) continue;`,
    `    alive.push({ env, key: v });`,
    `  }`,
    `  return alive;`,
    `}`,
    ``,
    `function poolAuthHeaders(key) {`,
    `  if (POOL_ANTHROPIC) return { "x-api-key": key, "anthropic-version": "2023-06-01" };`,
    `  return { Authorization: "Bearer " + key };`,
    `}`,
    ``,
    `const BALANCE_RE = /(insufficient|balance|credit|quota|out of (credit|funds)|payment required|billing|rate.?limit|too many requests|429)/i;`,
    `async function poolShouldRotate(res) {`,
    `  if (!res) return { rotate: true, cooldownMs: 0 };`,
    `  const s = res.status || 0;`,
    `  if (s === 401) return { rotate: true, dead: true };`,
    `  if (s === 402 || s === 429 || (s >= 500 && s < 600)) return { rotate: true, cooldownMs: s === 429 ? 60000 : 30000 };`,
    `  if (s === 400 || s === 403 || s === 404) {`,
    `    let text = "";`,
    `    try { text = await res.clone().text(); } catch { text = ""; }`,
    `    if (BALANCE_RE.test(text)) return { rotate: true, cooldownMs: 0 };`,
    `    return { rotate: false };`,
    `  }`,
    `  return { rotate: false };`,
    `}`,
    ``,
    `function poolNote(env, decision, status) {`,
    `  if (decision.dead) {`,
    `    poolState.dead.add(env);`,
    `    console.error("[keypool ${safeKey}] ключ " + env + " отклонён (" + status + ") — выведен из ротации");`,
    `  } else if (decision.cooldownMs) {`,
    `    const fails = (poolState.fails.get(env) || 0) + 1;`,
    `    poolState.fails.set(env, fails);`,
    `    poolState.cooldownUntil.set(env, Date.now() + Math.min(300000, decision.cooldownMs * 2 ** Math.min(3, fails - 1)));`,
    `  }`,
    `}`,
    ``,
    `if (typeof globalThis.fetch === "function" && !globalThis.__psKeypoolPatched) {`,
    `  const origFetch = globalThis.fetch.bind(globalThis);`,
    `  globalThis.__psKeypoolPatched = true;`,
    `  globalThis.fetch = async function poolFetch(input, init) {`,
    `    let url = "";`,
    `    try { url = String(typeof input === "string" ? input : input?.url || ""); } catch { url = ""; }`,
    `    const headers = new Headers((init && init.headers) || (typeof input !== "string" && input?.headers) || {});`,
    `    const hasAuth = headers.has("authorization") || headers.has("x-api-key");`,
    `    if (!POOL_BASE || !url.startsWith(POOL_BASE) || !hasAuth) return origFetch(input, init);`,
    `    const body = init?.body;`,
    `    const replayable = body == null || typeof body === "string";`,
    `    const alive = poolKeys();`,
    `    if (!alive.length) return origFetch(input, init);`,
    `    // Начинаем с ключа, который opencode уже подставил, если он из пула, — иначе round-robin.`,
    `    const current = String(headers.get("authorization") || headers.get("x-api-key") || "").replace(/^Bearer\\s+/i, "");`,
    `    let order = alive.slice();`,
    `    const hit = order.findIndex((e) => e.key === current);`,
    `    if (hit > 0) order = order.slice(hit).concat(order.slice(0, hit));`,
    `    else if (poolState.cursor > 0) order = order.slice(poolState.cursor).concat(order.slice(0, poolState.cursor));`,
    `    let lastRes = null;`,
    `    for (let i = 0; i < order.length; i++) {`,
    `      const h = new Headers(headers);`,
    `      for (const [k, v] of Object.entries(poolAuthHeaders(order[i].key))) h.set(k, v);`,
    `      let res;`,
    `      try {`,
    `        res = await origFetch(typeof input === "string" ? input : input?.url || input, { ...init, headers: h });`,
    `      } catch (e) {`,
    `        // Транспортная ошибка: следующий ключ (другой аккаунт/квота) может пройти.`,
    `        poolState.cursor = (poolState.cursor + 1) % Math.max(1, alive.length);`,
    `        lastRes = null;`,
    `        continue;`,
    `      }`,
    `      if (res.ok) { poolState.fails.set(order[i].env, 0); return res; }`,
    `      const decision = await poolShouldRotate(res);`,
    `      poolNote(order[i].env, decision, res.status);`,
    `      lastRes = res;`,
    `      if (!decision.rotate || !replayable) return res;`,
    `      // Следующая итерация — следующий ключ.`,
    `    }`,
    `    return lastRes || origFetch(input, init);`,
    `  };`,
    `}`,
    ``,
    `export default {};`,
    ``,
  ];
  return { fileName, source: lines.join("\n") };
}

/**
 * Добавляет запись плагина в top-level `plugin` конфига без дублей.
 * Принимает/возвращает массив значений (строки или [имя, опции]).
 */
export function mergePluginEntry(existing, entry) {
  const list = Array.isArray(existing) ? existing.slice() : [];
  const nameOf = (v) => (typeof v === "string" ? v : Array.isArray(v) ? String(v[0] || "") : "");
  if (!list.some((v) => nameOf(v) === nameOf(entry))) list.push(entry);
  return list;
}
