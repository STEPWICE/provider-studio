// src/smart-audit.mjs
// Умный аудит: сквозные проверки, невидимые при взгляде на один блок.
//
// Валидатор смотрит на каждый провайдер отдельно («поле не по схеме»),
// диагностики щупают сеть. Аудит смотрит на конфиг целиком: один и тот же id
// модели у двух шлюзов, где дешевле брать модель по умолчанию, у каких
// моделей нет лимитов и цен (opencode тогда угадывает, а угадывает он плохо).
//
// Чистая статика без единого запроса — считается миллисекунды. Поэтому ответ
// вшит в /api/diagnostics и свеж при каждом её запуске: отдельный запрос,
// кнопка и ожидание не нужны, это и есть авто-режим.
//
// Оценка: 100 − 10 за warn − 3 за info, пол — 0. Формула зафиксирована здесь
// и в интерфейсе, чтобы число не выглядело магией.

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function priceOf(entry) {
  const c = entry && typeof entry.cost === "object" ? entry.cost : null;
  if (!c) return null;
  const i = numOrNull(c.input);
  const o = numOrNull(c.output);
  return i === null || o === null ? null : { input: i, output: o, total: i + o };
}

function fmtPrice(p) {
  if (!p) return "цена неизвестна";
  if (p.input === 0 && p.output === 0) return "0/0 (free)";
  const t = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10000) / 10000));
  return `${t(p.input)}/${t(p.output)} $/1M`;
}

/**
 * @returns {{score: number, findings: object[], stats: object}}
 * finding: {severity: "warn"|"info", id, message, provider?, model?, fix?}
 * fix: {kind: "set-default", model} — интерфейс рисует кнопку.
 */
export function smartAudit(config) {
  const findings = [];
  const providers = config && isPlainObject(config.provider)
    ? Object.entries(config.provider).filter(([, p]) => isPlainObject(p) && p.type !== "local")
    : [];

  if (!providers.length) {
    return {
      score: 100,
      findings: [{ severity: "info", id: "no-providers", message: "В конфиге нет провайдеров — аудиту нечего смотреть" }],
      stats: { providers: 0, models: 0, priced: 0, withLimits: 0, duplicates: 0 },
    };
  }

  // Карта id модели -> откуда её можно взять и почём.
  const byId = new Map();
  let models = 0;
  let priced = 0;
  let withLimits = 0;
  const noLimitExamples = [];
  const noCostExamples = [];
  for (const [key, p] of providers) {
    const ms = isPlainObject(p.models) ? Object.entries(p.models) : [];
    for (const [mid, m] of ms) {
      models++;
      const price = isPlainObject(m) ? priceOf(m) : null;
      if (price) priced++;
      const limit = isPlainObject(m) && isPlainObject(m.limit)
        && typeof m.limit.context === "number" && typeof m.limit.output === "number";
      if (limit) withLimits++;
      if (!limit && noLimitExamples.length < 5) noLimitExamples.push(`${key}/${mid}`);
      if (!price && noCostExamples.length < 5) noCostExamples.push(`${key}/${mid}`);
      if (!byId.has(mid)) byId.set(mid, []);
      byId.get(mid).push({ provider: key, price });
    }
  }

  // Один id у нескольких шлюзов: не ошибка, но развилка — брать можно оттуда,
  // где дешевле, а дефолт может стоять на дорогом источнике.
  let duplicates = 0;
  for (const [mid, sources] of byId) {
    if (sources.length < 2) continue;
    duplicates++;
    const pricedSources = sources.filter((s) => s.price);
    const where = sources.map((s) => s.provider).join(", ");
    let tail = "";
    if (pricedSources.length >= 2) {
      const sorted = [...pricedSources].sort((a, b) => a.price.total - b.price.total);
      if (sorted[0].price.total !== sorted[sorted.length - 1].price.total) {
        tail = ` — дешевле у «${sorted[0].provider}» (${fmtPrice(sorted[0].price)} против ${fmtPrice(sorted[sorted.length - 1].price)})`;
      }
    }
    findings.push({
      severity: "info", id: "duplicate-model-id",
      message: `Модель «${mid}» есть у ${sources.length} провайдеров: ${where}${tail}`,
    });
  }

  // Модель по умолчанию: если её id отдают несколько шлюзов, а стоит она на
  // не самом дешёвом — это деньги при каждом запросе.
  const def = typeof config.model === "string" ? config.model : "";
  const slash = def.indexOf("/");
  if (slash > 0) {
    const defProv = def.slice(0, slash);
    const defId = def.slice(slash + 1);
    const sources = (byId.get(defId) || []).filter((s) => s.price);
    if (sources.length >= 2) {
      const sorted = [...sources].sort((a, b) => a.price.total - b.price.total);
      const cheapest = sorted[0];
      const current = sources.find((s) => s.provider === defProv);
      if (cheapest.provider !== defProv && (!current || cheapest.price.total < current.price.total)) {
        findings.push({
          severity: "warn", id: "default-not-cheapest",
          message: `По умолчанию стоит ${def} (${current ? fmtPrice(current.price) : "цена неизвестна"}), ` +
            `а тот же «${defId}» у «${cheapest.provider}» — ${fmtPrice(cheapest.price)}`,
          model: def,
          fix: { kind: "set-default", model: `${cheapest.provider}/${defId}` },
        });
      }
    }
  }

  if (noLimitExamples.length) {
    findings.push({
      severity: "info", id: "models-no-limits",
      message: `Без limit: ${models - withLimits} из ${models} (напр. ${noLimitExamples.join(", ")}) — контекст угадывает opencode`,
    });
  }
  if (noCostExamples.length) {
    findings.push({
      severity: "info", id: "models-no-cost",
      message: `Без цены: ${models - priced} из ${models} (напр. ${noCostExamples.join(", ")}) — траты не оценить`,
    });
  }

  const warns = findings.filter((f) => f.severity === "warn").length;
  const infos = findings.filter((f) => f.severity !== "warn").length;
  const score = Math.max(0, 100 - 10 * warns - 3 * infos);
  return {
    score,
    findings,
    stats: { providers: providers.length, models, priced, withLimits, duplicates },
  };
}
