// verify-digest.mjs
// Проверяет дайджест халявы: нормализацию фидов, фильтр просроченного, кэш с
// TTL и деградацию до протухшего кэша вместо ошибки.
//
// Сети здесь нет: fetch подменяется стабом. Живые фиды лёгкие (~20-60 КБ),
// но тест не должен зависеть от чужого сервера.

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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

// Кэш — во временный каталог, чтобы не трогать настоящий.
const root = mkdtempSync(join(tmpdir(), "ps-digest-"));
process.env.PS_DATA_DIR = join(root, "data");

const D = await import("./src/digest.mjs");

// ------------------------------------------------------- нормализация
{
  // Английский текст первый, китайский — запасной.
  const p = D.normalisePerk({
    id: "x", provider: "Google", product: "AI Pro", kind: "promo",
    title: "学生免费", title_en: "Student free claim",
    summary: "中文摘要", summary_en: "",
    claim: "申请", claim_en: "",
    window: "w", starts: "2026-01-01", ends: "", status: "active",
    source: "https://example.com/src",
  });
  eq("английский заголовок первый", p.title, "Student free claim");
  eq("пустой EN откатывается на китайский", p.summary, "中文摘要");
  eq("claim тоже с fallback", p.claim, "申请");
  eq("статус и источник целы", [p.status, p.source], ["active", "https://example.com/src"]);

  const n = D.normaliseNews({ id: "n", title: "t", title_en: "", impact: "launch", status: "active" });
  eq("новость без EN берёт исходный заголовок", n.title, "t");

  // Мусор на входе — пустые строки на выходе, а не исключение.
  const junk = D.normalisePerk(null);
  eq("null превращается в пустую запись", [junk.title, junk.status], ["", "unknown"]);
}

// ------------------------------------------------------- фильтр ended
{
  const { live, ended } = D.splitPerks([
    { id: "a", status: "active" },
    { id: "u", status: "upcoming" },
    { id: "e", status: "ended" },
    { id: "q", status: "weird-unreleased" },
  ]);
  eq("живые остаются", live.map((p) => p.id), ["a", "u", "q"]);
  eq("просроченные только считаются", ended, 1);
  check("неизвестный статус не прячется", live.some((p) => p.id === "q"));
}

// ------------------------------------------------------- загрузка со стабом
const PERKS = {
  as_of: "2026-09-16",
  items: [
    { id: "p1", provider: "Google", product: "AI Pro", title: "t1", title_en: "Free students", status: "active", source: "https://g.dev" },
    { id: "p2", provider: "X", product: "Y", title: "t2", title_en: "Old promo", status: "ended", source: "" },
  ],
};
const NEWS = {
  as_of: "2026-09-16",
  items: [{ id: "n1", provider: "Cursor", product: "P", title: "t", title_en: "Launch", status: "active", source: "https://c.dev" }],
};

function stubFetch(map) {
  let calls = 0;
  const fn = async (url) => {
    calls++;
    const body = map(url);
    if (body === null) throw new Error("сеть легла");
    return { ok: true, text: async () => JSON.stringify(body) };
  };
  fn.calls = () => calls;
  return fn;
}

{
  const fetchImpl = stubFetch((u) => (u.includes("perks") ? PERKS : NEWS));
  const d = await D.loadDigest({ fetchImpl });
  check("загрузка успешна", d.ok === true, JSON.stringify(d).slice(0, 160));
  eq("as_of из фида", d.as_of, "2026-09-16");
  eq("просроченное отфильтровано", d.perks.map((p) => p.id), ["p1"]);
  eq("счётчик скрытых", d.ended, 1);
  eq("новости на месте", d.news.map((n) => n.id), ["n1"]);
  check("не stale", d.stale === false);
  eq("сеть дёрнули дважды (perks+news)", fetchImpl.calls(), 2);

  // Второй вызов — из кэша, без сети.
  const d2 = await D.loadDigest({ fetchImpl });
  check("повтор берётся из кэша", d2.ok === true && fetchImpl.calls() === 2, `calls=${fetchImpl.calls()}`);

  // refresh=1 дёргает сеть принудительно.
  await D.loadDigest({ fetchImpl, refresh: true });
  eq("принудительное обновление идёт в сеть", fetchImpl.calls(), 4);
}

// ------------------------------------------------------- протухший кэш вместо ошибки
{
  // Состариваем кэш вручную: правилам TTL больше 6 часов.
  const file = join(root, "data", "digest-cache.json");
  const payload = JSON.parse(readFileSync(file, "utf8"));
  payload.at = Date.now() - D.DIGEST_TTL_MS - 1000;
  writeFileSync(file, JSON.stringify(payload));

  // Сеть лежит, но кэш есть — отдаём его с пометкой.
  const dead = stubFetch(() => null);
  const d = await D.loadDigest({ fetchImpl: dead });
  check("без сети отдаётся протухший кэш, а не ошибка", d.ok === true && d.stale === true, JSON.stringify(d).slice(0, 160));
  eq("данные из кэша целы", d.perks.map((p) => p.id), ["p1"]);

  // Кэша нет вообще — честная ошибка, а не исключение.
  D.clearDigestCache();
  const d2 = await D.loadDigest({ fetchImpl: dead });
  check("без кэша и сети — ok:false", d2.ok === false, JSON.stringify(d2).slice(0, 160));
  check("списки пустые, а не мусор", Array.isArray(d2.perks) && Array.isArray(d2.news));
}

// ------------------------------------------------------- битые фиды
{
  const bad = stubFetch(() => ({ nonsense: 1 }));
  D.clearDigestCache();
  const d = await D.loadDigest({ fetchImpl: bad });
  check("битый фид без кэша — ok:false", d.ok === false, JSON.stringify(d).slice(0, 160));

  // Битый фид при живом кэше — кэш побеждает (стабильность важнее свежести).
  const good = stubFetch((u) => (u.includes("perks") ? PERKS : NEWS));
  await D.loadDigest({ fetchImpl: good });
  const d2 = await D.loadDigest({ fetchImpl: bad });
  check("битый фид при живом кэше — кэш", d2.ok === true && d2.stale === false, JSON.stringify(d2).slice(0, 160));
}

// ------------------------------------------------------- источник только http(s)
{
  const evil = D.normalisePerk({ id: "x", title_en: "t", source: "javascript:alert(1)" });
  check("javascript:-источник вырезается из perks", evil.source === "", evil.source);
  const evil2 = D.normaliseNews({ id: "y", title_en: "t", source: "data:text/html,hi" });
  check("data:-источник вырезается из news", evil2.source === "", evil2.source);
  const ok = D.normalisePerk({ id: "z", title_en: "t", source: "https://board.ailyre.com/x" });
  check("https-источник живёт", ok.source === "https://board.ailyre.com/x", ok.source);
}

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.log("\nFailed:");
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
