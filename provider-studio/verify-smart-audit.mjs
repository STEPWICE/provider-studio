// verify-smart-audit.mjs
// Юнит-проверки умного аудита: сквозные выводы по конфигу целиком.
// Без сети: модуль — чистая статика.

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0;
const fails = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fails.push(name); console.log("FAIL  " + name + (detail ? "  <- " + detail : "")); }
}

// Изоляция на всякий случай: модуль ничего не пишет, но пусть будет как у всех.
const root = mkdtempSync(join(tmpdir(), "ps-smart-"));
process.env.PS_DATA_DIR = join(root, "data");

const S = await import("./src/smart-audit.mjs");

// ------------------------------------------------------- дубли и дешёвый источник
{
  const r = S.smartAudit({
    provider: {
      a: { npm: "x", models: { m: { cost: { input: 2, output: 10 } }, solo: {} } },
      b: { npm: "x", models: { m: { cost: { input: 0, output: 0 } } } },
    },
    model: "a/m",
  });
  const dup = r.findings.find((f) => f.id === "duplicate-model-id");
  check("дубль id замечен", !!dup && /a.*b|b.*a/.test(dup.message), JSON.stringify(dup || null));
  check("в дубле назван дешёвый источник", !!dup && dup.message.includes("«b»"), dup?.message || "");
  const cheap = r.findings.find((f) => f.id === "default-not-cheapest");
  check("дорогой дефолт — warn", cheap?.severity === "warn", JSON.stringify(cheap || null));
  check("у warn есть fix set-default", cheap?.fix?.kind === "set-default" && cheap?.fix?.model === "b/m",
    JSON.stringify(cheap?.fix || null));
  check("статистика честная", r.stats.models === 3 && r.stats.duplicates === 1, JSON.stringify(r.stats));
  check("оценка ниже сотни", r.score < 100 && r.score >= 0, String(r.score));
}

// ------------------------------------------------------- когда всё хорошо
{
  const r = S.smartAudit({
    provider: {
      a: {
        npm: "x",
        models: { m: { cost: { input: 1, output: 2 }, limit: { context: 1000, output: 100 } } },
      },
    },
    model: "a/m",
  });
  check("чистый конфиг — 100", r.score === 100, String(r.score));
  check("находок нет", r.findings.length === 0, JSON.stringify(r.findings));
}

// ------------------------------------------------------- неполные характеристики
{
  const r = S.smartAudit({
    provider: { a: { npm: "x", models: { bare: { name: "bare" } } } },
    model: "a/bare",
  });
  check("модель без limit замечена", r.findings.some((f) => f.id === "models-no-limits"),
    JSON.stringify(r.findings));
  check("модель без цены замечена", r.findings.some((f) => f.id === "models-no-cost"),
    JSON.stringify(r.findings));
}

// ------------------------------------------------------- пусто и бито — без падений
{
  const e = S.smartAudit({ provider: {} });
  check("пустой конфиг не роняет", e.score === 100 && e.findings.length === 1, JSON.stringify(e));
  const n = S.smartAudit(null);
  check("null не роняет", n.score === 100, JSON.stringify(n));
  const loc = S.smartAudit({ provider: { l: { type: "local", models: { m: {} } } }, model: "l/m" });
  check("local-провайдеры вне аудита", loc.stats.models === 0, JSON.stringify(loc.stats));
}

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.log("\nFailed:");
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
