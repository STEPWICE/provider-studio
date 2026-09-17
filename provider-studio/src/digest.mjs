// src/digest.mjs
// Ежедневный дайджест халявы: какие провайдеры прямо сейчас что-то раздают
// (промо, триалы, бесплатные тиры) и какие сервисные новости влияют на доступ.
//
// Источник — публичные JSON-фиды борда Ailyre (perks + news). В подвале самого
// борда написано, что data/*.json можно читать напрямую, так что это не
// парсинг чужой вёрстки, а документированный способ доступа. Фиды лёгкие
// (~20-60 КБ) и обновляются каждый день.
//
// Почему кэш на диске, а не только в памяти: инструмент перезапускают по сто
// раз на дню, и дёргать чужой сервер при каждом старте — невежливо. TTL 6
// часов: свежесть дневная, а запас в обе стороны есть. При недоступности сети
// отдаётся протухший кэш с пометкой stale, а не ошибка: вчерашняя халява
// полезнее, чем красный экран.
//
// Ничего здесь не пишет в конфиг и не ходит в opencode — только чтение.

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { dataDir, ensureDir, writeFileAtomic } from "./paths.mjs";
import { proxyForUrl, proxyFetch } from "./proxy.mjs";

export const PERKS_URL = "https://board.ailyre.com/data/perks.json";
export const NEWS_URL = "https://board.ailyre.com/data/news.json";
// Дайджест дневной: чаще дёргать чужой сервер смысла нет, реже — показывать
// вчерашнее как сегодняшнее. Шесть часов держат оба условия с запасом.
export const DIGEST_TTL_MS = 6 * 60 * 60 * 1000;

const CACHE_FILE = () => join(dataDir(), "digest-cache.json");

function clean(v) {
  return typeof v === "string" ? v.trim() : "";
}

/** Английский текст первым: аудитория инструмента русскоязычная, а фид ведётся на zh/en. */
function enFirst(en, zh) {
  return clean(en) || clean(zh);
}

/**
 * Одна запись халявы в форме, удобной интерфейсу.
 * ended-записи не возвращаются (счётчик endedCount говорит, сколько скрыто):
 * просроченное «успей до вчера» — это шум, а не халява.
 */
export function normalisePerk(p) {
  return {
    id: clean(p?.id),
    provider: clean(p?.provider),
    product: clean(p?.product),
    kind: clean(p?.kind),
    title: enFirst(p?.title_en, p?.title),
    summary: enFirst(p?.summary_en, p?.summary),
    claim: enFirst(p?.claim_en, p?.claim),
    window: clean(p?.window),
    starts: clean(p?.starts),
    ends: clean(p?.ends),
    status: clean(p?.status) || "unknown",
    source: clean(p?.source),
  };
}

export function normaliseNews(n) {
  return {
    id: clean(n?.id),
    provider: clean(n?.provider),
    product: clean(n?.product),
    impact: clean(n?.impact),
    title: enFirst(n?.title_en, n?.title),
    summary: enFirst(n?.summary_en, n?.summary),
    starts: clean(n?.starts),
    ends: clean(n?.ends),
    status: clean(n?.status) || "unknown",
    source: clean(n?.source),
  };
}

/** Делит perks на живые и просроченные. Неизвестный статус — живой: лучше показать лишнее, чем спрятать действующее. */
export function splitPerks(list) {
  const live = [];
  let ended = 0;
  for (const p of Array.isArray(list) ? list : []) {
    if (String(p?.status || "").toLowerCase() === "ended") ended++;
    else live.push(normalisePerk(p));
  }
  return { live, ended };
}

function readCache() {
  try {
    if (!existsSync(CACHE_FILE())) return null;
    const v = JSON.parse(readFileSync(CACHE_FILE(), "utf8"));
    if (!v || typeof v !== "object") return null;
    if (!v.perks || !v.news || typeof v.at !== "number") return null;
    return v;
  } catch { return null; }
}

function writeCache(payload) {
  try {
    ensureDir(dataDir());
    writeFileAtomic(CACHE_FILE(), JSON.stringify(payload));
  } catch { /* кэш необязателен: тихий пропуск, а не падающий дайджест */ }
}

async function fetchJson(url, { timeoutMs, fetchImpl }) {
  const proxy = proxyForUrl(url);
  const get = fetchImpl || ((u) => (proxy
    ? proxyFetch(u, { timeoutMs, proxy, maxBytes: 2_000_000 })
    : fetch(u, { signal: AbortSignal.timeout(timeoutMs) })));
  const r = await get(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  return JSON.parse(text);
}

function shape(raw, kind) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`неожиданная форма ${kind}`);
  }
  const items = Array.isArray(raw.items) ? raw.items : null;
  if (!items) throw new Error(`в ${kind} нет items`);
  return { as_of: clean(raw.as_of), items };
}

/**
 * Грузит дайджест: свежий кэш — сразу, иначе сеть, при её недоступности —
 * протухший кэш с stale:true. Без кэша и без сети — честная ошибка.
 */
export async function loadDigest({ timeoutMs = 15000, refresh = false, fetchImpl } = {}) {
  const cached = readCache();
  const fresh = cached && (Date.now() - cached.at < DIGEST_TTL_MS);
  if (cached && fresh && !refresh) {
    return present(cached, { stale: false, cachedAt: cached.at });
  }
  try {
    const [perksRaw, newsRaw] = await Promise.all([
      fetchJson(PERKS_URL, { timeoutMs, fetchImpl }),
      fetchJson(NEWS_URL, { timeoutMs, fetchImpl }),
    ]);
    const perks = shape(perksRaw, "perks");
    const news = shape(newsRaw, "news");
    const payload = { at: Date.now(), as_of: perks.as_of || news.as_of, perks, news };
    writeCache(payload);
    return present(payload, { stale: false, cachedAt: payload.at });
  } catch (e) {
    // Сеть легла, а вчерашний кэш цел: отдать его с пометкой — полезнее ошибки.
    if (cached) {
      return present(cached, { stale: true, cachedAt: cached.at, error: String(e?.message || e) });
    }
    return {
      ok: false, as_of: "", perks: [], news: [], ended: 0,
      stale: false, cachedAt: 0, error: `Дайджест недоступен: ${e?.message || e}`,
    };
  }
}

function present(payload, { stale, cachedAt, error = "" }) {
  const { live, ended } = splitPerks(payload.perks.items);
  return {
    ok: true,
    as_of: payload.as_of || payload.perks.as_of || "",
    perks: live,
    news: (Array.isArray(payload.news.items) ? payload.news.items : []).map(normaliseNews),
    ended,
    stale: !!stale,
    cachedAt,
    error,
  };
}

/** Сносит кэш (нужен тестам и принудительному обновлению). */
export function clearDigestCache() {
  try {
    if (existsSync(CACHE_FILE())) unlinkSync(CACHE_FILE());
  } catch { /* нет файла — нет проблемы */ }
}
