// src/doctor.mjs
// Три функции, о которых просили: автоисправление конфига, обновление списка
// моделей с живых серверов и самопроверка самого инструмента.
//
// Почему отдельным модулем, а не внутри rescue.mjs / server.mjs:
//   - rescue.mjs только находит проблемы (validateConfig) и щупает сеть, но
//     ничего не правит — смешивать "найти" и "переписать" в одном месте уже
//     приводило к дрейфу копий;
//   - server.mjs только разводит HTTP по функциям, логика здесь — её можно
//     тестировать без поднятия сервера (см. verify-doctor.mjs).
//
// Правило безопасности общее с остальным инструментом: этот модуль строит
// только список правок (ops для jsonc-edit.mjs) и никогда не пишет на диск.
// Пишет server.mjs через applyChangesVerified + commitPlan, показав diff.

import { existsSync, readFileSync, writeFileSync, unlinkSync, accessSync, constants } from "node:fs";
import { join, dirname } from "node:path";
import {
  MODALITIES, MODEL_STATUSES, PROVIDER_FIELDS,
  MODEL_FIELDS, looksLikePackage, isCustomProviderBlock,
  decodeApiKey, detectApiFormat, suggestEnvVarName,
  buildModelEntry,
} from "./formats.mjs";
import { lookupEnv } from "./env.mjs";
import {
  backupDir, dataDir, ensureDir,
  resolveOpencodeConfigPath, defaultOpencodeConfigPath,
} from "./paths.mjs";
import { proxyForUrl, describeProxy } from "./proxy.mjs";

export const SCHEMA_URL = "https://opencode.ai/config.json";
const ANTHROPIC_VERSION = "2023-06-01";

const PROVIDER_FIELD_SET = new Set([...PROVIDER_FIELDS, "type", "$schema"]);
const SPECIFIC_PROVIDER_FIELDS = new Set(["apiKey", "baseURL"]);
const MODEL_FIELD_SET = new Set(MODEL_FIELDS);
const VALID_MODALITIES = new Set(MODALITIES);

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// ------------------------------------------------------------ автоисправление

/**
 * Строит список правок, устраняющих всё, что устраняется без вопросов.
 *
 * Чинит только то, где правильное действие однозначно:
 *   - мусорные поля (схема с additionalProperties:false роняет весь конфиг);
 *   - ключ/адрес на верхнем уровне вместо options;
 *   - $VAR -> {env:VAR}, открытый ключ -> ссылка на переменную;
 *   - недостающий anthropic-version, attachment, кривые modalities/limit/cost/status;
 *   - висячая модель по умолчанию -> первая живая из конфига.
 *
 * Не трогает то, где нужен человек: отсутствующая переменная окружения,
 * пустой список моделей, сомнительные лимиты (output > context).
 *
 * @returns {{changes: object[], fixes: object[], skipped: object[]}}
 */
export function buildAutoFixChanges(config) {
  const changes = [];
  const fixes = [];
  const skipped = [];
  const cfg = isPlainObject(config) ? config : null;
  if (!cfg) {
    skipped.push({ id: "not-object", message: "Конфиг не является объектом — чинить нечего" });
    return { changes, fixes, skipped };
  }

  // $schema нужен редакторам для валидации; его отсутствие ломает только
  // подсветку, но правится одной строкой.
  if (!Object.prototype.hasOwnProperty.call(cfg, "$schema")) {
    changes.push({ op: "set", path: ["$schema"], value: SCHEMA_URL });
    fixes.push({ id: "missing-schema", message: "Добавлен $schema" });
  }

  const providers = cfg.provider;
  if (!isPlainObject(providers)) {
    skipped.push({ id: "no-provider", message: "Нет блока provider — провайдера нужно добавить вручную" });
    return { changes, fixes, skipped };
  }

  for (const [key, p] of Object.entries(providers)) {
    if (!isPlainObject(p)) {
      changes.push({ op: "delete", path: ["provider", key] });
      fixes.push({ id: "bad-provider", provider: key, message: `Провайдер «${key}» не является объектом — блок удалён` });
      continue;
    }
    if (p.type === "local") continue;

    // Мусорные поля роняют ВЕСЬ конфиг (additionalProperties:false).
    for (const field of Object.keys(p)) {
      if (PROVIDER_FIELD_SET.has(field) || SPECIFIC_PROVIDER_FIELDS.has(field)) continue;
      changes.push({ op: "delete", path: ["provider", key, field] });
      fixes.push({ id: "unknown-provider-field", provider: key, message: `Провайдер «${key}»: убрано поле «${field}» — его нет в схеме` });
    }

    // Пакет в `name` вместо `npm` — наследие старых версий инструмента.
    if (!p.npm && !p.api && looksLikePackage(p.name)) {
      const pkg = String(p.name);
      changes.push({ op: "merge", path: ["provider", key], value: { npm: pkg, name: key } });
      fixes.push({ id: "npm-as-name", provider: key, message: `Провайдер «${key}»: пакет «${pkg}» перенесён из name в npm` });
    }

    // Ключ и адрес на верхнем уровне: схема их не знает, opencode их не читает.
    // Значение чинится сразу, а не переезжает как есть: иначе открытый ключ
    // остался бы открытым текстом в options, а $VAR — битой ссылкой, и
    // понадобился бы второй прогон, чтобы это заметить.
    let apiKeyHandled = false;
    if (p.apiKey !== undefined) {
      const top = p.apiKey;
      if (p.options?.apiKey === undefined && typeof top === "string" && top) {
        const finalKey = normaliseKeyValue(top, key, changes, fixes);
        changes.push({ op: "merge", path: ["provider", key, "options"], value: { apiKey: finalKey } });
        if (finalKey === top) {
          fixes.push({ id: "apikey-top-level", provider: key, message: `Провайдер «${key}»: apiKey перенесён в options` });
        } else {
          fixes.push({ id: "apikey-top-level", provider: key, message: `Провайдер «${key}»: apiKey перенесён в options и приведён к виду «${finalKey}»` });
        }
        apiKeyHandled = true;
      } else {
        fixes.push({ id: "apikey-top-level", provider: key, message: `Провайдер «${key}»: убран дублирующий apiKey с верхнего уровня` });
      }
      changes.push({ op: "delete", path: ["provider", key, "apiKey"] });
    }
    if (p.baseURL !== undefined) {
      const top = p.baseURL;
      if (!p.options?.baseURL && typeof top === "string" && top) {
        changes.push({ op: "merge", path: ["provider", key, "options"], value: { baseURL: top } });
        fixes.push({ id: "baseurl-top-level", provider: key, message: `Провайдер «${key}»: baseURL перенесён в options` });
      } else {
        fixes.push({ id: "baseurl-top-level", provider: key, message: `Провайдер «${key}»: убран лишний baseURL с верхнего уровня` });
      }
      changes.push({ op: "delete", path: ["provider", key, "baseURL"] });
    }

    if (!apiKeyHandled)     fixApiKeyValue(key, p, changes, fixes, skipped);
    fixHeaders(key, p, changes, fixes);
    fixOptions(key, p, changes, fixes);

    const models = isPlainObject(p.models) ? p.models : null;
    if (models) {
      for (const [mid, m] of Object.entries(models)) {
        fixModel(key, mid, m, changes, fixes, skipped);
      }
    } else if (isCustomProviderBlock({ ...p, npm: p.npm || undefined })) {
      skipped.push({ id: "no-models", provider: key, message: `Провайдер «${key}» без моделей — запусти «Обновить модели»` });
    }
  }

  fixDefaultModels(cfg, changes, fixes, skipped);
  return { changes, fixes, skipped };
}

/**
 * Приводит значение ключа к виду, который opencode понимает.
 * Возвращает строку для записи; сама пишет только побочные правки
 * (env-массив) и записи в fixes/skipped. Путь записи выбирает вызывающий:
 * при переезде с верхнего уровня это merge, иначе set.
 */
function normaliseKeyValue(apiKey, key, changes, fixes, skipped) {
  // $VAR / ${VAR} отправляются буквально как ключ. Правильный синтаксис {env:VAR}.
  const bare = apiKey.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
  if (bare) {
    const suggest = `{env:${bare[1]}}`;
    fixes.push({ id: "bad-env-ref", provider: key, message: `Провайдер «${key}»: «${apiKey}» заменено на «${suggest}»` });
    return suggest;
  }
  const decoded = decodeApiKey(apiKey);
  if (decoded.useEnvVar) return apiKey;
  // Открытый ключ в файле, который коммитят и показывают. См. комментарий
  // в fixApiKeyValue: в конфиге остаётся ссылка, значение задаётся вручную.
  if (decoded.apiKey.length > 0) {
    const envName = suggestEnvVarName(key);
    changes.push({ op: "merge", path: ["provider", key], value: { env: [envName] } });
    fixes.push({
      id: "plaintext-key", provider: key,
      message: `Провайдер «${key}»: ключ вынесен в переменную ${envName} — задай её вручную, старый ключ из файла стёрт`,
      needsEnvSetup: true, envVar: envName,
    });
    return `{env:${envName}}`;
  }
  return apiKey;
}

function fixApiKeyValue(key, p, changes, fixes, skipped) {
  const apiKey = p.options?.apiKey;
  if (typeof apiKey !== "string" || !apiKey) return;
  // Устаревший синтаксис чинится всегда, независимо от того, задана переменная:
  // {env:VAR} вместо $VAR — это правка формы, а отсутствие переменной доложит
  // повторная валидация (remaining). Проверять наличие здесь — значит молча
  // оставить битую форму только потому, что переменная пока не задана.
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(apiKey)) {
    const fixed = normaliseKeyValue(apiKey, key, changes, fixes, skipped);
    if (fixed !== apiKey) {
      changes.push({ op: "set", path: ["provider", key, "options", "apiKey"], value: fixed });
    }
    return;
  }
  if (/^\{env:/.test(apiKey) && !/^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(apiKey)) {
    skipped.push({ id: "malformed-env-ref", provider: key, message: `Провайдер «${key}»: ссылка «${apiKey}» некорректна — поправь имя переменной вручную` });
    return;
  }
  const decoded = decodeApiKey(apiKey);
  if (decoded.useEnvVar) {
    // Переменная отсутствует — создавать её молча нельзя (значение неизвестно),
    // это ручной шаг. Не skip-молчание: skipped объясняет, что делать.
    const info = lookupEnv(decoded.envVarName);
    if (!info.set) {
      skipped.push({ id: "env-missing", provider: key, message: `Провайдер «${key}»: задай переменную ${decoded.envVarName}, иначе opencode отправит пустой ключ (401)` });
    }
    return;
  }
  const fixed = normaliseKeyValue(apiKey, key, changes, fixes, skipped);
  if (fixed !== apiKey) {
    changes.push({ op: "set", path: ["provider", key, "options", "apiKey"], value: fixed });
  }
}

function fixHeaders(key, p, changes, fixes) {
  const npm = String(p.npm || (looksLikePackage(p.name) ? p.name : "") || "").toLowerCase();
  const api = String(p.api || "").toLowerCase();
  const isAnthropic = npm.includes("anthropic") || api.includes("anthropic");
  if (!isAnthropic || npm === "@ai-sdk/anthropic") return;
  const headers = p.options?.headers;
  if (headers !== undefined && (!isPlainObject(headers))) {
    changes.push({ op: "delete", path: ["provider", key, "options", "headers"] });
    changes.push({ op: "merge", path: ["provider", key, "options"], value: { headers: { "anthropic-version": ANTHROPIC_VERSION } } });
    fixes.push({ id: "bad-headers", provider: key, message: `Провайдер «${key}»: заголовки заменены корректным anthropic-version` });
    return;
  }
  const names = Object.keys(headers || {}).map((h) => h.toLowerCase());
  if (!names.includes("anthropic-version")) {
    changes.push({ op: "merge", path: ["provider", key, "options"], value: { headers: { ...(isPlainObject(headers) ? headers : {}), "anthropic-version": ANTHROPIC_VERSION } } });
    fixes.push({ id: "no-anthropic-version", provider: key, message: `Провайдер «${key}»: добавлен заголовок anthropic-version` });
  }
}

function fixOptions(key, p, changes, fixes) {
  const opts = p.options;
  // timeout живёт в options, а env — на верхнем уровне: выходить при отсутствии
  // options — значит оставить битой env, о которой валидатор уже доложил.
  if (opts !== undefined && opts && typeof opts === "object" && !Array.isArray(opts)) {
    const t = opts.timeout;
    if (t !== undefined && !(typeof t === "number" && Number.isFinite(t) && t > 0)) {
      changes.push({ op: "delete", path: ["provider", key, "options", "timeout"] });
      fixes.push({ id: "bad-timeout", provider: key, message: `Провайдер «${key}»: убран некорректный options.timeout` });
    }
  }
  const env = p.env;
  if (env === undefined) return;
  if (!Array.isArray(env)) {
    changes.push({ op: "delete", path: ["provider", key, "env"] });
    fixes.push({ id: "bad-env", provider: key, message: `Провайдер «${key}»: убран env не-массив` });
    return;
  }
  const good = env.filter((n) => typeof n === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
  if (good.length !== env.length) {
    if (good.length) {
      changes.push({ op: "set", path: ["provider", key, "env"], value: good });
      fixes.push({ id: "bad-env-name", provider: key, message: `Провайдер «${key}»: из env убраны записи, не похожие на имена переменных` });
    } else {
      changes.push({ op: "delete", path: ["provider", key, "env"] });
      fixes.push({ id: "bad-env-name", provider: key, message: `Провайдер «${key}»: убран пустой после чистки env` });
    }
  }
}

function fixModel(key, mid, m, changes, fixes, skipped) {
  const base = ["provider", key, "models", mid];
  if (!isPlainObject(m)) {
    changes.push({ op: "delete", path: base });
    fixes.push({ id: "bad-model", provider: key, model: mid, message: `Модель «${key}/${mid}» не является объектом — удалена` });
    return;
  }
  for (const field of Object.keys(m)) {
    if (!MODEL_FIELD_SET.has(field)) {
      changes.push({ op: "delete", path: [...base, field] });
      fixes.push({ id: "unknown-model-field", provider: key, model: mid, message: `Модель «${key}/${mid}»: убрано поле «${field}» — его нет в схеме` });
    }
  }
  // modalities должны быть массивами из известного списка.
  for (const side of ["input", "output"]) {
    const list = m.modalities?.[side];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      changes.push({ op: "delete", path: [...base, "modalities", side] });
      fixes.push({ id: "bad-modalities", provider: key, model: mid, message: `Модель «${key}/${mid}»: убран modalities.${side} — должен быть массивом` });
      continue;
    }
    const clean = [...new Set(list.filter((t) => VALID_MODALITIES.has(t)))];
    if (clean.length !== list.length) {
      const next = clean.length ? clean : ["text"];
      changes.push({ op: "set", path: [...base, "modalities", side], value: next });
      fixes.push({ id: "bad-modality", provider: key, model: mid, message: `Модель «${key}/${mid}»: из modalities.${side} убраны недопустимые значения` });
    }
  }
  // Без text-входа chat не работает — добавляем, а не ругаемся.
  const inputAfter = m.modalities?.input;
  if (Array.isArray(inputAfter) && !inputAfter.includes("text") && inputAfter.every((t) => VALID_MODALITIES.has(t))) {
    changes.push({ op: "set", path: [...base, "modalities", "input"], value: ["text", ...inputAfter] });
    fixes.push({ id: "no-text-input", provider: key, model: mid, message: `Модель «${key}/${mid}»: в modalities.input добавлен text` });
  }
  // Неполные limit/cost схема отвергает целиком — удаляем, а не гадаем.
  if (m.limit !== undefined) {
    if (!isPlainObject(m.limit)) {
      changes.push({ op: "delete", path: [...base, "limit"] });
      fixes.push({ id: "bad-limit", provider: key, model: mid, message: `Модель «${key}/${mid}»: убран некорректный limit` });
    } else {
      const hasCtx = typeof m.limit.context === "number" && m.limit.context > 0;
      const hasOut = typeof m.limit.output === "number" && m.limit.output > 0;
      if (hasCtx !== hasOut) {
        changes.push({ op: "delete", path: [...base, "limit"] });
        fixes.push({ id: "partial-limit", provider: key, model: mid, message: `Модель «${key}/${mid}»: убран неполный limit (нужны и context, и output)` });
      }
    }
  }
  if (m.cost !== undefined) {
    if (!isPlainObject(m.cost)) {
      changes.push({ op: "delete", path: [...base, "cost"] });
      fixes.push({ id: "bad-cost", provider: key, model: mid, message: `Модель «${key}/${mid}»: убран некорректный cost` });
    } else {
      const hasIn = typeof m.cost.input === "number";
      const hasOut = typeof m.cost.output === "number";
      if (hasIn !== hasOut) {
        changes.push({ op: "delete", path: [...base, "cost"] });
        fixes.push({ id: "partial-cost", provider: key, model: mid, message: `Модель «${key}/${mid}»: убран неполный cost (нужны и input, и output)` });
      }
    }
  }
  // Картинка/видео/аудио без attachment:true просто не дойдут до модели.
  const input = m.modalities?.input;
  if (Array.isArray(input) && input.some((t) => t !== "text") && m.attachment !== true) {
    changes.push({ op: "set", path: [...base, "attachment"], value: true });
    fixes.push({ id: "no-attachment", provider: key, model: mid, message: `Модель «${key}/${mid}»: включён attachment` });
  }
  if (m.status !== undefined && !MODEL_STATUSES.includes(m.status)) {
    changes.push({ op: "delete", path: [...base, "status"] });
    fixes.push({ id: "bad-status", provider: key, model: mid, message: `Модель «${key}/${mid}»: убран недопустимый status «${m.status}»` });
  }
  if (m.release_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(m.release_date))) {
    skipped.push({ id: "bad-release-date", provider: key, model: mid, message: `Модель «${key}/${mid}»: release_date не в формате YYYY-MM-DD — поправь вручную` });
  }
}

function firstAvailableModel(cfg, excludeKey = "") {
  for (const [k, p] of Object.entries(cfg.provider || {})) {
    if (k === excludeKey || !isPlainObject(p)) continue;
    const first = Object.keys(p.models || {})[0];
    if (first) return `${k}/${first}`;
  }
  return "";
}

function fixDefaultModels(cfg, changes, fixes, skipped) {
  const providers = cfg.provider || {};
  // model отсутствует — opencode стартует, но без модели по умолчанию.
  if (cfg.model === undefined) {
    const fb = firstAvailableModel(cfg);
    if (fb) {
      changes.push({ op: "set", path: ["model"], value: fb });
      fixes.push({ id: "no-default", message: `Модель по умолчанию не задана — поставлена ${fb}` });
    } else {
      skipped.push({ id: "no-default", message: "Нет ни одной модели, чтобы назначить по умолчанию" });
    }
  } else if (typeof cfg.model === "string" && cfg.model.includes("/")) {
    const slash = cfg.model.indexOf("/");
    const pk = cfg.model.slice(0, slash);
    const mn = cfg.model.slice(slash + 1);
    if (!isPlainObject(providers[pk]) || !(mn && Object.prototype.hasOwnProperty.call(providers[pk].models || {}, mn))) {
      const fb = firstAvailableModel(cfg);
      if (fb && fb !== cfg.model) {
        changes.push({ op: "set", path: ["model"], value: fb });
        fixes.push({ id: "bad-default", message: `Модель ${cfg.model} не найдена — по умолчанию поставлена ${fb}` });
      } else if (!fb) {
        skipped.push({ id: "bad-default", message: `Модель ${cfg.model} не найдена, а замены в конфиге нет` });
      }
    }
  } else if (cfg.model !== undefined) {
    skipped.push({ id: "bad-model-format", message: `Поле model должно иметь вид «провайдер/модель» — поправь вручную` });
  }
  // small_model необязателен: висячую ссылку проще убрать, чем гадать замену.
  const sm = cfg.small_model;
  if (typeof sm === "string" && sm.includes("/")) {
    const slash = sm.indexOf("/");
    const pk = sm.slice(0, slash);
    const mn = sm.slice(slash + 1);
    if (!isPlainObject(providers[pk]) || !(mn && Object.prototype.hasOwnProperty.call(providers[pk].models || {}, mn))) {
      changes.push({ op: "delete", path: ["small_model"] });
      fixes.push({ id: "bad-small-model", message: `Убран висячий small_model ${sm}` });
    }
  } else if (sm !== undefined && (typeof sm !== "string" || !sm.includes("/"))) {
    changes.push({ op: "delete", path: ["small_model"] });
    fixes.push({ id: "bad-small-model-format", message: "Убран некорректный small_model" });
  }
}

// ------------------------------------------------------- обновление моделей

/**
 * Превращает запись из /models в запись конфига opencode.
 * Пустые лимиты/цены не пишутся: неполный limit/cost схема отвергает, а 0
 * вместо «неизвестно» превращается в ложное «бесплатно».
 */
export function discoveredToEntry(src) {
  const built = buildModelEntry({
    id: src?.id,
    name: src?.name || src?.id,
    contextWindow: src?.contextWindow || 0,
    maxOutput: src?.maxOutput || 0,
    inputTypes: src?.inputTypes || ["text"],
    outputTypes: src?.outputTypes || ["text"],
    reasoning: !!src?.reasoning,
    toolUse: src?.toolUse !== false,
    costInput: src?.costInput,
    costOutput: src?.costOutput,
    costCacheRead: src?.costCacheRead,
    costCacheWrite: src?.costCacheWrite,
  });
  return built ? built.entry : null;
}

/**
 * Нулевая заявленная цена — это провайдер говорит «бесплатно». Неизвестная
 * цена (cost нет) — не бесплатно: как и везде в инструменте, молчание не
 * читается как «free», иначе платная модель попадёт в бесплатную выборку.
 */
export function isFreeEntry(entry) {
  const c = entry?.cost;
  return !!c && typeof c.input === "number" && typeof c.output === "number"
    && c.input === 0 && c.output === 0;
}

/**
 * Сравнивает конфиг с тем, что реально отдаёт сервер.
 *
 * Существующие записи не перезаписываются: значение, которое провайдер заявил
 * сам, — факт про этот эндпоинт, а средний каталог его не улучшает. Обновляются
 * только добавления (и, опционально, удаления).
 *
 * @returns {{added: string[], removed: string[], kept: string[], changes: object[]}}
 */
export function planModelSync(existingModels, discovered, { prune = false } = {}) {
  const existing = isPlainObject(existingModels) ? existingModels : {};
  const list = Array.isArray(discovered) ? discovered : [];
  const seen = new Set();
  const added = [];
  const changes = [];
  for (const d of list) {
    const id = String(d?.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (!Object.prototype.hasOwnProperty.call(existing, id)) {
      const entry = discoveredToEntry(d);
      if (entry) {
        added.push(id);
        changes.push({ entry, id });
      }
    }
  }
  const kept = Object.keys(existing).filter((id) => seen.has(id));
  const removed = Object.keys(existing).filter((id) => !seen.has(id));
  return { added, removed, kept, changes };
}

/**
 * Опрашивает живые эндпоинты и строит план обновления.
 *
 * fetchFn подменяется в тестах стабом, чтобы не ходить в сеть.
 */
export async function planRefresh(config, { providerKeys = null, prune = false, fetchFn = null, concurrency = 3 } = {}) {
  // Ленивый импорт: rescue.mjs тяжёлый (прокси, DNS), а для юнит-плана он не нужен.
  const { fetchModels } = fetchFn ? { fetchModels: fetchFn } : await import("./rescue.mjs");
  const entries = Object.entries((config && isPlainObject(config.provider) ? config.provider : {}) || {});
  const wanted = Array.isArray(providerKeys) && providerKeys.length
    ? entries.filter(([k]) => providerKeys.includes(k))
    : entries;

  async function refreshOne(key, p) {
    if (!isPlainObject(p) || p.type === "local") {
      return { key, ok: false, skipped: true, message: `Провайдер «${key}»: локальный или некорректный — пропускаю` };
    }
    const base = p.options?.baseURL || p.baseURL || "";
    if (!base) {
      return { key, ok: false, skipped: true, message: `Провайдер «${key}»: нет своего Base URL — адрес берётся из npm-пакета, обновлять нечего` };
    }
    const decoded = decodeApiKey(p.options?.apiKey);
    const apiKey = decoded.useEnvVar ? (lookupEnv(decoded.envVarName)?.value || "") : decoded.apiKey;
    let res;
    try {
      res = await fetchModels({ baseURL: base, apiKey, apiFormat: detectApiFormat(p) });
    } catch (e) {
      res = { ok: false, models: [], message: String(e?.message || e) };
    }
    if (!res?.ok) {
      return { key, ok: false, message: res?.message || "Не удалось получить список моделей", fault: res?.fault || null };
    }
    const sync = planModelSync(p.models, res.models, { prune });
    return {
      key, ok: true, message: res.message || `Найдено моделей: ${res.models.length}`,
      total: res.models.length,
      added: sync.added, removed: sync.removed, kept: sync.kept,
      pending: sync.changes,
      prune,
    };
  }

  // /models каждого провайдера — независимые запросы, а каждый висит до 12
  // секунд: последовательный опрос десятка провайдеров превращался в минуты
  // ожидания. Небольшой пул воркеров, порядок результата — как в конфиге.
  const queue = wanted.slice();
  const workers = Math.max(1, Math.min(Math.max(1, concurrency | 0), 8, Math.max(queue.length, 1)));
  const byKey = new Map();
  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      const [key, p] = next;
      byKey.set(key, await refreshOne(key, p));
    }
  }));
  return wanted.map(([key]) => byKey.get(key));
}

// ------------------------------------------------------------ самопроверка

/**
 * Самодиагностика инструмента: Node, каталоги, конфиг, каталог моделей.
 * Критичные проверки роняют общий ok; необязательные (каталог models.dev)
 * только описывают состояние.
 */
export async function runSelfCheck({ configPath = "", catalogTimeoutMs = 8000 } = {}) {
  const checks = [];
  const push = (id, label, ok, message, critical = true) => {
    checks.push({ id, label, ok: !!ok, message: String(message || ""), critical });
  };

  // Node: разрабатывалось на 24, минимум — 20.
  {
    const m = /^v(\d+)/.exec(process.version || "");
    const major = m ? Number(m[1]) : 0;
    push("node", "Версия Node.js", major >= 20,
      major >= 20 ? `${process.version} — поддерживается` : `${process.version || "неизвестна"} — нужен Node.js 20+`,
      true);
  }

  // Каталоги данных должны быть writable: иначе бэкапы и store молча пропадут.
  for (const [id, label, dir] of [["data-dir", "Каталог данных", dataDir()], ["backup-dir", "Каталог бэкапов", backupDir()]]) {
    try {
      ensureDir(dir);
      const probe = join(dir, `.writetest-${process.pid}.tmp`);
      writeFileSync(probe, "ok", "utf8");
      unlinkSync(probe);
      push(id, label, true, `${dir} — запись работает`);
    } catch (e) {
      push(id, label, false, `${dir} — нет записи: ${e?.message || e}`);
    }
  }

  // Конфиг: путь, чтение, парсинг, валидация структуры.
  const resolved = resolveOpencodeConfigPath(configPath);
  push("config-path", "Путь к конфигу", true, resolved, false);
  if (!existsSync(resolved)) {
    const fallback = configPath ? defaultOpencodeConfigPath() : resolved;
    push("config-exists", "Файл конфига", true,
      `Файла нет — будет создан при записи (${configPath ? "указанный путь" : fallback})`, true);
  } else {
    let raw = null;
    try {
      raw = readFileSync(resolved, "utf8");
      push("config-readable", "Чтение конфига", true, `Читается (${Buffer.byteLength(raw, "utf8")} байт)`);
    } catch (e) {
      push("config-readable", "Чтение конфига", false, `Не читается: ${e?.message || e}`);
    }
    if (raw !== null) {
      const { parseJsonc } = await import("./jsonc-edit.mjs");
      const doc = parseJsonc(raw);
      if (!doc.ok) {
        push("config-parse", "Разбор конфига", false, `Не разбирается: ${doc.error}. Сначала почини JSONC вручную.`);
      } else {
        push("config-parse", "Разбор конфига", true, "Разбирается");
        const { validateConfig } = await import("./rescue.mjs");
        const issues = validateConfig(doc.value);
        const errs = issues.filter((i) => i.severity === "error").length;
        push("config-valid", "Структура конфига", errs === 0,
          errs === 0
            ? (issues.length ? `Ошибок нет, предупреждений: ${issues.length}` : "Проблем не найдено")
            : `Ошибок: ${errs}, предупреждений: ${issues.length - errs} — запусти «Исправить автоматически»`,
          false);
      }
      // Проверяется именно запись, а не чтение: раньше здесь был fileStamp,
      // который только читал файл, а проверка называлась «Запись конфига».
      try {
        if (existsSync(resolved)) {
          accessSync(resolved, constants.W_OK);
          const st = (await import("./paths.mjs")).fileStamp(resolved);
          push("config-writable", "Запись конфига", true, `Файл перезаписываемый (hash ${String(st.hash || "").slice(0, 8)}…)`, false);
        } else {
          // Файла нет (его создадут при записи) — тогда важна
          // перезаписываемость каталога.
          accessSync(dirname(resolved), constants.W_OK);
          push("config-writable", "Запись конфига", true, "Файла нет, но каталог перезаписываемый — создастся при записи", false);
        }
      } catch (e) {
        push("config-writable", "Запись конфига", false, `Нет записи: ${e?.message || e}`, false);
      }
    }
  }

  // Прокси: называем явно, чтобы пользователь знал, каким путём уходили пробы.
  try {
    const used = describeProxy(proxyForUrl("https://example.com"));
    push("proxy", "Прокси", true, used ? `Исходящие идут через ${used}` : "Прямое соединение (прокси не настроен)", false);
  } catch (e) {
    push("proxy", "Прокси", false, String(e?.message || e), false);
  }

  // Каталог models.dev — удобство, а не необходимость: его недоступность не
  // делает инструмент сломанным, поэтому проверка некритичная.
  try {
    const { loadCatalog } = await import("./catalog.mjs");
    const cat = await loadCatalog({ timeoutMs: catalogTimeoutMs });
    if (cat?.ok) {
      push("catalog", "Справочник models.dev", true, `Доступен (моделей: ${cat.count ?? cat.byId?.size ?? "?"})`, false);
    } else {
      push("catalog", "Справочник models.dev", false, cat?.error || "Недоступен — характеристики будут только от провайдера", false);
    }
  } catch (e) {
    push("catalog", "Справочник models.dev", false, `Недоступен: ${e?.message || e}`, false);
  }

  const ok = checks.filter((c) => c.critical).every((c) => c.ok);
  return { ok, checks, path: resolved };
}
