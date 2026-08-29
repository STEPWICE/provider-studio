/**
 * A read-only reference built from models.dev.
 *
 * Why this exists: some gateways answer /models with nothing but an id. The
 * user then has to hand-type context windows and modality flags for dozens of
 * models, or leave the config blank and let opencode guess.
 *
 * Why it is deliberately timid: the catalogue lists the same model id under
 * many providers, and those entries disagree. Measured over models.dev
 * (1074 ids served by more than one provider):
 *
 *   context limit   74% agree within 5%   worst spread x8
 *   output limit    52% agree within 5%   worst spread x8.2
 *   input price     42% agree within 5%   worst spread x5
 *   attachment      441 all-true, 421 all-false, 212 disputed
 *
 * So a lookup by model id alone cannot tell you what *your* gateway does. The
 * rule here is therefore: fill a field only when the sources that mention it
 * agree, and never invent a price. A number the user did not ask for and cannot
 * check is worse than an empty field they can fill in themselves.
 *
 * Nothing in here writes to the config on its own; it returns suggestions with
 * their evidence attached so the caller can show where each number came from.
 */

import { proxyForUrl, proxyFetch, describeProxy } from "./proxy.mjs";

export const CATALOG_URL = "https://models.dev/api.json";

// Numbers written two ways ("1048576" and "1000000" are both a 1M window) are
// the same fact. Beyond this they are genuinely different claims.
export const AGREEMENT_TOLERANCE = 0.05;

// The payload is ~4.4 MB. Re-fetching it per model would be absurd, and it
// changes on the order of days, so an in-process cache with a long life is the
// right shape. It is not persisted: a stale file on disk that nobody expires is
// a worse failure than one extra download per session.
const CACHE_TTL_MS = 60 * 60 * 1000;
let cache = null;

export function clearCatalogCache() {
  cache = null;
}

/**
 * Are these numbers the same claim, allowing for rounding?
 * Zero is only ever equal to zero — treating "free" as within tolerance of a
 * real price is exactly the confusion this module refuses to make.
 */
export function agree(values, tolerance = AGREEMENT_TOLERANCE) {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (nums.length < 1) return false;
  const min = Math.min(...nums), max = Math.max(...nums);
  if (min <= 0) return min === max;
  return max / min <= 1 + tolerance;
}

/**
 * Collapse agreeing numbers to one value, or null when they conflict.
 * The minimum, not the mean: an invented average matches no provider, while the
 * smallest claim is at least a number somebody actually publishes.
 */
export function consensusNumber(values, tolerance = AGREEMENT_TOLERANCE) {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v) && v > 0);
  if (!nums.length) return null;
  if (!agree(nums, tolerance)) return null;
  return Math.min(...nums);
}

/** Booleans have no tolerance: unanimous or nothing. */
export function consensusBool(values) {
  const bools = values.filter((v) => typeof v === "boolean");
  if (!bools.length) return null;
  if (bools.every(Boolean)) return true;
  if (bools.every((v) => v === false)) return false;
  return null;
}

/** Modality lists are compared as sets; order is not a disagreement. */
export function consensusList(values) {
  const lists = values.filter((v) => Array.isArray(v) && v.length);
  if (!lists.length) return null;
  const keyed = lists.map((l) => [...new Set(l)].sort().join(","));
  return keyed.every((k) => k === keyed[0]) ? [...new Set(lists[0])].sort() : null;
}

/**
 * Fetch and index the catalogue. Returns { ok, byId, providers, error }.
 *
 * A failure here is never fatal to the caller: the catalogue is a convenience,
 * and the tool worked without it before.
 */
export async function loadCatalog({ timeoutMs = 20000, fetchImpl } = {}) {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  let db;
  // Behind a corporate proxy or VPN a plain fetch never leaves the machine, so
  // the catalogue has to take the same route every other outbound request does.
  const proxy = proxyForUrl(CATALOG_URL);
  try {
    // The catalogue is ~4.4 MB, well past the default probe ceiling; without
    // raising it the body comes back cut in half and fails to parse.
    const get = fetchImpl || ((u) => (proxy
      ? proxyFetch(u, { timeoutMs, proxy, maxBytes: 16_000_000 })
      : fetch(u, { signal: AbortSignal.timeout(timeoutMs) })));
    const r = await get(CATALOG_URL);
    if (!r.ok) {
      return { ok: false, error: `models.dev ответил ${r.status}`, byId: new Map(), providers: new Map() };
    }
    db = JSON.parse(await r.text());
  } catch (e) {
    const why = e && e.message ? e.message : String(e);
    return {
      ok: false,
      // Name the proxy when there is one: otherwise a broken tunnel reads as a
      // dead catalogue and the user looks for the fault in the wrong place.
      error: `Каталог models.dev недоступен: ${proxy ? `${describeProxy(proxy)}: ` : ""}${why}`,
      byId: new Map(),
      providers: new Map(),
    };
  }

  const byId = new Map();
  const providers = new Map();
  for (const [pid, p] of Object.entries(db || {})) {
    if (!p || typeof p !== "object") continue;
    providers.set(pid, { id: pid, name: p.name || pid, npm: p.npm || "", api: p.api || "", env: Array.isArray(p.env) ? p.env : [], doc: p.doc || "" });
    for (const [mid, m] of Object.entries(p.models || {})) {
      if (!m || typeof m !== "object") continue;
      if (!byId.has(mid)) byId.set(mid, []);
      byId.get(mid).push({ provider: pid, model: m });
    }
  }

  const value = { ok: true, byId, providers, count: byId.size, error: null };
  cache = { at: Date.now(), value };
  return value;
}

/**
 * Look one model up, matching on the exact id first and then on the id without
 * its vendor prefix ("anthropic/claude-x" -> "claude-x"), which is how the same
 * model is usually named behind a gateway.
 */
export function lookupModel(catalog, id) {
  const clean = String(id || "").trim();
  if (!clean || !catalog || !catalog.byId) return { entries: [], matchedBy: null };
  const exact = catalog.byId.get(clean);
  if (exact && exact.length) return { entries: exact, matchedBy: "exact" };

  const bare = clean.includes("/") ? clean.slice(clean.indexOf("/") + 1) : clean;
  // Strip an OpenRouter-style ":free"/":nitro" suffix — it marks a tier, not a
  // different model.
  const stem = bare.includes(":") ? bare.slice(0, bare.indexOf(":")) : bare;
  const hits = [];
  for (const [mid, list] of catalog.byId) {
    const mbare = mid.includes("/") ? mid.slice(mid.indexOf("/") + 1) : mid;
    const mstem = mbare.includes(":") ? mbare.slice(0, mbare.indexOf(":")) : mbare;
    if (mstem === stem) hits.push(...list);
  }
  return { entries: hits, matchedBy: hits.length ? "name" : null };
}

/**
 * Suggest specs for one model.
 *
 * Returns { found, sources, fields, conflicts, note }. `fields` holds only
 * values the sources agree on; everything contested lands in `conflicts` so the
 * UI can say "10 providers, and they disagree" instead of quietly picking one.
 *
 * Pricing is never suggested. It is the field that disagrees most (42% within
 * 5%, and 155 ids that are free at one provider and billed at another), and a
 * wrong price is the one error here that costs money.
 */
export function suggestSpecs(catalog, id) {
  const { entries, matchedBy } = lookupModel(catalog, id);
  if (!entries.length) {
    return { found: false, sources: 0, matchedBy: null, fields: {}, conflicts: [], note: "" };
  }

  const models = entries.map((e) => e.model);
  const fields = {};
  const conflicts = [];

  const num = (key, get) => {
    const vals = models.map(get);
    const v = consensusNumber(vals);
    if (v != null) fields[key] = v;
    else if (vals.some((x) => typeof x === "number" && x > 0)) {
      const nums = vals.filter((x) => typeof x === "number" && x > 0);
      conflicts.push({ field: key, min: Math.min(...nums), max: Math.max(...nums), n: nums.length });
    }
  };
  const bool = (key, get) => {
    const vals = models.map(get);
    const v = consensusBool(vals);
    if (v != null) fields[key] = v;
    else if (vals.some((x) => typeof x === "boolean")) {
      conflicts.push({ field: key, disputed: true, n: vals.filter((x) => typeof x === "boolean").length });
    }
  };

  num("contextWindow", (m) => m.limit?.context);
  num("maxOutput", (m) => m.limit?.output);
  bool("reasoning", (m) => m.reasoning);
  bool("toolUse", (m) => m.tool_call);
  bool("attachment", (m) => m.attachment);

  const inputs = consensusList(models.map((m) => m.modalities?.input));
  if (inputs) fields.inputTypes = inputs;
  else if (models.some((m) => Array.isArray(m.modalities?.input))) {
    conflicts.push({ field: "inputTypes", disputed: true, n: models.filter((m) => Array.isArray(m.modalities?.input)).length });
  }

  const named = models.find((m) => m.name);
  if (named) fields.name = named.name;

  return {
    found: true,
    sources: entries.length,
    matchedBy,
    providers: [...new Set(entries.map((e) => e.provider))],
    fields,
    conflicts,
    // Said plainly, because the number came from other gateways, not from this one.
    note: `Данные из каталога models.dev (${entries.length} источник(ов))${matchedBy === "name" ? ", совпадение по имени без префикса" : ""}. Цены не переносятся: у одной модели они различаются между шлюзами.`,
  };
}

/**
 * Fill blanks in a list of discovered models.
 *
 * Only ever fills what is missing: a value the provider itself reported is a
 * fact about the endpoint being configured, and a catalogue average must not
 * overwrite it.
 */
export function enrichModels(catalog, models, { overwrite = false } = {}) {
  const out = [];
  let filled = 0, matched = 0;
  for (const m of Array.isArray(models) ? models : []) {
    const s = suggestSpecs(catalog, m.id);
    if (!s.found) { out.push({ ...m }); continue; }
    matched++;
    const next = { ...m };
    const from = [];
    // `declaredFields` lists what the endpoint itself stated. Anything absent
    // from it is our own inference from the model id — a guess, which the
    // catalogue may improve on. Judging by value instead would treat a guessed
    // `reasoning: false` as a fact and lock the better answer out.
    const declared = new Set(Array.isArray(m.declaredFields) ? m.declaredFields : null
      // No provenance available (hand-written entry, older payload): fall back
      // to "a value that carries information counts as stated".
      || Object.keys(m).filter((k) => {
        const v = m[k];
        if (v == null || v === 0 || v === "") return false;
        if (Array.isArray(v)) return v.length > 0 && !(k === "inputTypes" && v.length === 1 && v[0] === "text");
        return true;
      }));
    for (const [k, v] of Object.entries(s.fields)) {
      if (k === "name") continue;
      if (declared.has(k) && !overwrite) continue;
      if (Array.isArray(v) ? v.length : v != null) { next[k] = v; from.push(k); }
    }
    if (from.length) {
      filled++;
      next.specSource = "catalog";
      next.specFields = from;
      next.specSources = s.sources;
    }
    if (s.conflicts.length) next.specConflicts = s.conflicts;
    out.push(next);
  }
  return { models: out, matched, filled };
}
