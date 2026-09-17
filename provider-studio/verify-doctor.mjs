// verify-doctor.mjs
// Проверяет "доктора": автоисправление конфига, план обновления моделей и
// самопроверку инструмента. Сеть не используется: опрос серверов подменяется
// стабом, каталог models.dev для самопроверки необязателен (некритично).

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0;
const fails = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  <- " + detail : "")); }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, `got ${a} want ${b}`);
}

// Каталог данных — во временный, чтобы самопроверка не трогала настоящий.
const root = mkdtempSync(join(tmpdir(), "ps-doctor-"));
process.env.PS_DATA_DIR = join(root, "data");

const D = await import("./src/doctor.mjs");
const { applyChangesVerified, parseJsonc } = await import("./src/jsonc-edit.mjs");
const { validateConfig } = await import("./src/rescue.mjs");

function applyOk(configObj, label) {
  const text = JSON.stringify(configObj, null, 2);
  const { changes, fixes, skipped } = D.buildAutoFixChanges(configObj);
  const applied = applyChangesVerified(text, changes);
  check(`${label}: правки применяются`, applied.ok === true, applied.error || "");
  return { changes, fixes, skipped, applied };
}

// ------------------------------------------------------- мусорные поля
{
  const { changes, fixes, applied } = applyOk({
    $schema: "https://opencode.ai/config.json",
    provider: { a: { npm: "x", typoField: 1, models: { m: { unknownField: 1 } } } },
    model: "a/m",
  }, "мусорные поля");
  check("мусорные поля дают две правки", changes.length === 2, JSON.stringify(changes.length));
  check("мусор убран из текста",
    applied.ok && !JSON.stringify(applied.value).includes("typoField") && !JSON.stringify(applied.value).includes("unknownField"));
  check("фиксы названы", fixes.some((f) => f.id === "unknown-provider-field") && fixes.some((f) => f.id === "unknown-model-field"));
}

// ------------------------------------------------------- ключ и адрес сверху
{
  const { applied, fixes } = applyOk({
    provider: { a: { npm: "x", apiKey: "sk-1", baseURL: "https://a.dev", models: { m: {} } } },
    model: "a/m",
  }, "верхний уровень");
  // Переезд и обеззараживание — за один прогон: открытый ключ не должен
  // оставаться открытым текстом в options до следующего запуска.
  eq("открытый ключ с верхнего уровня сразу стал ссылкой", applied.value?.provider?.a?.options?.apiKey, "{env:A_API_KEY}");
  check("литерал стёрт при переезде", !JSON.stringify(applied.value).includes("sk-1"));
  check("верхний apiKey удалён", applied.value?.provider?.a?.apiKey === undefined);
  check("верхний baseURL удалён", applied.value?.provider?.a?.baseURL === undefined);
  check("baseURL переехал в options", applied.value?.provider?.a?.options?.baseURL === "https://a.dev");
  check("фиксы упомянуты", fixes.some((f) => f.id === "apikey-top-level") && fixes.some((f) => f.id === "baseurl-top-level"));
}

// ------------------------------------------------------- $VAR и пакет в name
{
  const { applied } = applyOk({
    provider: { a: { name: "@ai-sdk/openai-compatible", options: { baseURL: "https://a.dev", apiKey: "$MY_KEY" }, models: { m: {} } } },
    model: "a/m",
  }, "$VAR и пакет");
  eq("пакет переехал в npm", applied.value?.provider?.a?.npm, "@ai-sdk/openai-compatible");
  eq("$VAR стал {env:VAR}", applied.value?.provider?.a?.options?.apiKey, "{env:MY_KEY}");
}

// ------------------------------------------------------- открытый ключ -> env
{
  const { applied, fixes } = applyOk({
    provider: { a: { npm: "x", options: { baseURL: "https://a.dev", apiKey: "sk-abcdef123456" }, models: { m: {} } } },
    model: "a/m",
  }, "открытый ключ");
  const apiKey = applied.value?.provider?.a?.options?.apiKey;
  check("открытый ключ заменён ссылкой", /^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(apiKey || ""), apiKey);
  check("литерал стёрт", !JSON.stringify(applied.value).includes("sk-abcdef123456"));
  check("фикс помечен как требующий задать переменную",
    fixes.some((f) => f.id === "plaintext-key" && f.needsEnvSetup === true), JSON.stringify(fixes));
}

// ------------------------------------------------------- отсутствующая переменная — вручную
{
  delete process.env.PS_DOCTOR_ABSENT;
  const { changes, skipped } = D.buildAutoFixChanges({
    $schema: "https://opencode.ai/config.json",
    provider: { a: { npm: "x", options: { baseURL: "https://a.dev", apiKey: "{env:PS_DOCTOR_ABSENT}" }, models: { m: {} } } },
    model: "a/m",
  });
  check("под отсутствующую переменную правок нет", changes.length === 0, JSON.stringify(changes));
  check("пропуск объясняет ручной шаг", skipped.some((s) => s.id === "env-missing"), JSON.stringify(skipped));
}

// ------------------------------------------------------- модели: limit/cost/modalities
{
  const { applied } = applyOk({
    provider: {
      a: {
        npm: "x", options: { baseURL: "https://a.dev" },
        models: {
          half: { name: "H", limit: { context: 1000 }, cost: { input: 1 } },
          weird: { name: "W", modalities: { input: ["text", "hologram"], output: ["text"] }, status: "cooked" },
          novis: { name: "V", modalities: { input: ["text", "image"], output: ["text"] } },
        },
      },
    },
    model: "a/half",
  }, "модели");
  const half = applied.value?.provider?.a?.models?.half;
  check("неполный limit удалён", half?.limit === undefined, JSON.stringify(half?.limit));
  check("неполный cost удалён", half?.cost === undefined, JSON.stringify(half?.cost));
  const weird = applied.value?.provider?.a?.models?.weird;
  eq("левая модальность вычищена", weird?.modalities?.input, ["text"]);
  check("левый статус удалён", weird?.status === undefined);
  check("attachment включён для image-входа",
    applied.value?.provider?.a?.models?.novis?.attachment === true);
  // После автофикса ошибок быть не должно (предупреждения допустимы).
  const errs = validateConfig(applied.value).filter((i) => i.severity === "error");
  check("после автофикса ошибок не остаётся", errs.length === 0, JSON.stringify(errs.map((i) => i.id)));
}

// ------------------------------------------------------- anthropic-заголовок
{
  const { applied, fixes } = applyOk({
    provider: { a: { api: "anthropic", options: { baseURL: "https://a.dev" }, models: { m: {} } } },
    model: "a/m",
  }, "anthropic");
  eq("anthropic-version добавлен",
    applied.value?.provider?.a?.options?.headers?.["anthropic-version"], "2023-06-01");
  check("фикс назван", fixes.some((f) => f.id === "no-anthropic-version"));
}

// ------------------------------------------------------- default-модели
{
  // Висячий default переставляется на первую живую.
  const { applied } = applyOk({
    provider: {
      dead: { npm: "x", options: {}, models: { d: {} } },
      alive: { npm: "x", options: {}, models: { m: {} } },
    },
    model: "dead/ghost",
    small_model: "dead/ghost",
  }, "висячий default");
  eq("model переставлен на живую", applied.value?.model, "dead/d");
  check("висячий small_model убран", applied.value?.small_model === undefined, applied.value?.small_model);

  // Отсутствующий default назначается.
  const second = applyOk({
    provider: { a: { npm: "x", options: {}, models: { m: {} } } },
  }, "пустой default");
  eq("default назначен", second.applied.value?.model, "a/m");

  // $schema добавляется.
  check("$schema добавлен", second.applied.value?.["$schema"] === D.SCHEMA_URL);
}

// ------------------------------------------------------- options: timeout/env
{
  const { applied, fixes } = applyOk({
    $schema: "https://opencode.ai/config.json",
    provider: {
      a: {
        npm: "x", env: ["GOOD_KEY", "has-dash"],
        options: { baseURL: "https://a.dev", timeout: 0 },
        models: { m: {} },
      },
    },
    model: "a/m",
  }, "options");
  eq("битый timeout удалён", applied.value?.provider?.a?.options?.timeout, undefined);
  eq("из env убрана только битая запись", applied.value?.provider?.a?.env, ["GOOD_KEY"]);
  check("фиксы названы",
    fixes.some((f) => f.id === "bad-timeout") && fixes.some((f) => f.id === "bad-env-name"));
  const errs = validateConfig(applied.value).filter((i) => i.severity === "error");
  check("после автофикса ошибок не остаётся", errs.length === 0, JSON.stringify(errs.map((i) => i.id)));

  // Дубли baseURL — предупреждение для человека, а не правка: какое из двух
  // зеркало, а какое копипаст, знает только владелец.
  const dupText = JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: {
      a: { npm: "x", options: { baseURL: "https://same.dev/v1" }, models: { m: {} } },
      b: { npm: "x", options: { baseURL: "https://same.dev/v1" }, models: { m: {} } },
    },
    model: "a/m",
  });
  const dup = D.buildAutoFixChanges(JSON.parse(dupText));
  const dupApplied = applyChangesVerified(dupText, dup.changes);
  check("дубль baseURL не правится молча",
    dupApplied.ok === true
    && dupApplied.value?.provider?.a?.options?.baseURL === "https://same.dev/v1"
    && dupApplied.value?.provider?.b?.options?.baseURL === "https://same.dev/v1",
    JSON.stringify(dup.changes));
}

// ------------------------------------------------------- план обновления
{
  const sync = D.planModelSync(
    { old: { name: "Old" } },
    [
      { id: "old", name: "Old" },
      { id: "new-model", name: "New", contextWindow: 100000, maxOutput: 8000, inputTypes: ["text"], outputTypes: ["text"] },
    ],
    { prune: false },
  );
  eq("новая модель в added", sync.added, ["new-model"]);
  eq("старая в kept", sync.kept, ["old"]);
  eq("без prune удалений нет в changes", sync.changes.length, 1);
  check("запись новой — объект opencode", sync.changes[0]?.entry?.name === "New", JSON.stringify(sync.changes[0]));

  const pruned = D.planModelSync({ old: {}, gone: {} }, [{ id: "old" }], { prune: true });
  eq("пропавшая модель в removed", pruned.removed, ["gone"]);

  // Существующие записи не перезаписываются.
  const keep = D.planModelSync(
    { m: { name: "Моя ручная правка" } },
    [{ id: "m", name: "Чужое имя с сервера" }],
  );
  eq("своя запись не затирается", keep.added, []);
}

// ------------------------------------------------------- refresh со стабом
{
  const stub = async ({ baseURL }) => {
    if (baseURL.includes("down")) return { ok: false, models: [], message: "Не удалось достучаться", fault: "endpoint" };
    return { ok: true, models: [{ id: "live-1" }, { id: "live-2" }], message: "Найдено моделей: 2" };
  };
  const plan = await D.planRefresh({
    provider: {
      up: { npm: "x", options: { baseURL: "https://up.dev/v1" }, models: { "live-1": {} } },
      down: { npm: "x", options: { baseURL: "https://down.dev/v1" }, models: {} },
      packaged: { npm: "@ai-sdk/anthropic", name: "P", models: { m: {} } },
    },
  }, { fetchFn: stub });
  const up = plan.find((p) => p.key === "up");
  check("живой провайдер опрошен", up?.ok === true && up.added.includes("live-2"), JSON.stringify(up));
  const down = plan.find((p) => p.key === "down");
  check("мёртвый провайдер честно сообщает", down?.ok === false, JSON.stringify(down));
  const packaged = plan.find((p) => p.key === "packaged");
  check("провайдер без Base URL пропускается", packaged?.ok === false && packaged?.skipped === true, JSON.stringify(packaged));

  // Только выбранные провайдеры.
  const only = await D.planRefresh({
    provider: {
      one: { npm: "x", options: { baseURL: "https://up.dev/v1" }, models: {} },
      two: { npm: "x", options: { baseURL: "https://up.dev/v1" }, models: {} },
    },
  }, { providerKeys: ["one"], fetchFn: stub });
  eq("фильтр по провайдерам работает", only.map((p) => p.key), ["one"]);
}

// ------------------------------------------------------- free-метка записей
{
  check("нулевая цена — бесплатно", D.isFreeEntry({ cost: { input: 0, output: 0 } }) === true);
  check("ненулевая цена — платно", D.isFreeEntry({ cost: { input: 2.5, output: 10 } }) === false);
  // Неизвестная цена — не бесплатно: иначе платная модель попадёт в выборку
  // «только бесплатные» и счёт придёт сюрпризом.
  check("нет цены — не бесплатно", D.isFreeEntry({}) === false);
  check("полцены — не цена", D.isFreeEntry({ cost: { input: 0 } }) === false);
  check("мусор не роняет", D.isFreeEntry(null) === false && D.isFreeEntry("x") === false);
}

// ------------------------------------------------------- самопроверка
{
  const self = await D.runSelfCheck({ catalogTimeoutMs: 3000 });
  check("самопроверка отвечает", Array.isArray(self.checks) && self.checks.length > 0, JSON.stringify(self).slice(0, 120));
  const byId = Object.fromEntries(self.checks.map((c) => [c.id, c]));
  for (const id of ["node", "data-dir", "backup-dir", "config-path"]) {
    check(`самопроверка содержит ${id}`, !!byId[id], Object.keys(byId).join(","));
  }
  check("каталог models.dev помечен некритичным", byId.catalog?.critical === false, JSON.stringify(byId.catalog));
  // Критичные проверки в тестовом окружении должны проходить.
  const critBad = self.checks.filter((c) => c.critical && !c.ok);
  check("критичные проверки проходят", critBad.length === 0, JSON.stringify(critBad.map((c) => c.id)));
  check("общий ok согласуется с критичными", self.ok === (critBad.length === 0));
}

// ------------------------------------------------------- env без options чинится тоже
// Регрессия: fixOptions выходил раньше, чем доходил до env, когда у провайдера
// не было options. Валидатор ошибку видел, автофикс — нет.
{
  const { applied, fixes } = applyOk({
    $schema: "https://opencode.ai/config.json",
    provider: {
      a: { npm: "x", env: "NOT-AN-ARRAY", models: { m: {} } },
    },
    model: "a/m",
  }, "env-без-options");
  eq("env не-массив без options удалён", applied.value?.provider?.a?.env, undefined);
  check("фикс bad-env есть", fixes.some((f) => f.id === "bad-env"), JSON.stringify(fixes));
  const errs = validateConfig(applied.value).filter((i) => i.severity === "error");
  check("после чистки ошибок нет", errs.length === 0, JSON.stringify(errs.map((i) => i.id)));
}

// ------------------------------------------------------- refresh идёт параллельно
{
  const seen = [];
  const stub = async ({ baseURL }) => {
    seen.push(baseURL);
    await new Promise((r) => setTimeout(r, 50));
    return { ok: true, models: [{ id: "m1" }], message: "ok" };
  };
  const cfg = {
    provider: {
      one: { npm: "x", options: { baseURL: "https://one.dev" }, models: {} },
      two: { npm: "x", options: { baseURL: "https://two.dev" }, models: {} },
      three: { npm: "x", options: { baseURL: "https://three.dev" }, models: {} },
    },
  };
  const t0 = Date.now();
  const plan = await D.planRefresh(cfg, { fetchFn: stub, concurrency: 3 });
  const dt = Date.now() - t0;
  check("порядок — как в конфиге", plan.map((p) => p.key).join(",") === "one,two,three",
    plan.map((p) => p.key).join(","));
  check("все опрошены", seen.length === 3, String(seen.length));
  check("параллельно, а не последовательно", dt < 130, `${dt}ms`);
}

// ------------------------------------------------------- whitelist по провайдерам
{
  const plan = [
    { key: "a", ok: true, pending: [{ id: "x", entry: { name: "x" } }, { id: "y", entry: { name: "y" } }], removed: ["old-a"] },
    { key: "b", ok: true, pending: [{ id: "x", entry: { name: "x" } }], removed: [] },
    { key: "dead", ok: false, message: "down" },
  ];
  const per = D.buildRefreshChanges(plan, { only: { a: ["x"] }, prune: true });
  const paths = per.map((c) => c.path.join("."));
  check("map пишет свой id только своему провайдеру",
    paths.includes("provider.a.models.x")
    && !paths.includes("provider.a.models.y")
    && !paths.includes("provider.b.models.x"),
    JSON.stringify(paths));
  check("prune идёт следом", paths.includes("provider.a.models.old-a"), JSON.stringify(paths));
  const legacy = D.buildRefreshChanges(plan, { only: ["x"], prune: false });
  const lpaths = legacy.map((c) => c.path.join("."));
  check("legacy-список действует глобально",
    lpaths.includes("provider.a.models.x") && lpaths.includes("provider.b.models.x"),
    JSON.stringify(lpaths));
  const all = D.buildRefreshChanges(plan, { only: null, prune: false });
  check("без whitelist пишется всё", all.length === 3, String(all.length));
}

// ------------------------------------------------------- битый конфиг
{
  const broken = D.buildAutoFixChanges(null);
  check("битый конфиг не роняет доктора", broken.changes.length === 0 && broken.skipped.length > 0);
  const doc = parseJsonc("{ не json");
  check("проверка парсера жива", doc.ok === false);
}

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.log("\nFailed:");
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
