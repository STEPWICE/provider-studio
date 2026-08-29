// Pacing rules for the bulk live check. Uses a fake prober and a fake clock, so
// the throttling behaviour is tested for real without touching the network.
import * as B from "./src/batch.mjs";

let pass = 0; const fails = [];
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS ", name); }
  else { fails.push(name + (extra ? `  <- ${extra}` : "")); console.log("FAIL ", name, extra ? ` <- ${extra}` : ""); }
};
const eq = (name, got, want) => check(name, Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// A clock that records waits instead of spending them.
const fakeClock = () => { const waits = []; return { waits, wait: async (ms) => { waits.push(ms); } }; };

const ids = (n, p = "m") => Array.from({ length: n }, (_, i) => `${p}${i}`);

// ---------------------------------------------------------------- detection
check("a 429 status is a rate limit", B.isRateLimited({ status: 429 }));
check("a rate-limit message is a rate limit", B.isRateLimited({ message: "429 Too Many Requests" }));
check("a russian rate-limit message counts", B.isRateLimited({ message: "превышен лимит запросов" }));
check("a plain failure is not a rate limit", B.isRateLimited({ ok: false, message: "model not found" }) === false);
check("success is not a rate limit", B.isRateLimited({ ok: true }) === false);
check("nothing is not a rate limit", B.isRateLimited(null) === false);
// "rate" must not be matched inside unrelated words.
check("the word 'accurate' is not a rate limit", B.isRateLimited({ message: "not accurate enough" }) === false);

check("a 401 is account-wide", B.isAccountWideFailure({ status: 401 }));
check("a key fault is account-wide", B.isAccountWideFailure({ fault: "key" }));
check("a proxy fault is account-wide", B.isAccountWideFailure({ fault: "proxy" }));
check("a 404 is not account-wide", B.isAccountWideFailure({ status: 404 }) === false);
// Verified live: a gateway answered 403 "Deposit required to unlock premium
// models" for one model and 200 for another on the same key. That is a
// per-model entitlement, so it must not abort the run.
check("a plan restriction is not account-wide", B.isAccountWideFailure({ status: 403, fault: "plan" }) === false);
check("an unclassified 403 does not abort the run", B.isAccountWideFailure({ status: 403 }) === false);
// Pins the precedence rather than the current status codes: an explicit "this
// is about the plan" must win even if the transport reports 401, so that
// tightening the status rules later cannot silently resurrect the abort.
check("a plan verdict outranks the status code", B.isAccountWideFailure({ status: 401, fault: "plan" }) === false);
{
  // The realistic shape: most models are off-plan, a few work. The working ones
  // must survive to the report.
  const r = await B.runBatch(ids(6), async (id) => (id === "m4"
    ? { ok: true }
    : { ok: false, status: 403, fault: "plan", message: "Модель недоступна на твоём тарифе (403) — ключ рабочий" }),
    { concurrency: 1, gapMs: 0 });
  check("plan restrictions do not stop the batch", r.stopped === null, JSON.stringify(r.stopped));
  eq("every model is still tested", r.tested, 6);
  eq("the model that does work is found", r.passed, 1);
  eq("the working model is the right one", r.results.find((x) => x.ok).id, "m4");
}

// ------------------------------------------------------------- happy path
{
  const clk = fakeClock();
  const seen = [];
  const r = await B.runBatch(ids(10), async (id) => { seen.push(id); return { ok: true, ms: 5 }; },
    { concurrency: 3, gapMs: 100, wait: clk.wait });
  eq("every model is tested", r.tested, 10);
  eq("every model passes", r.passed, 10);
  eq("nothing is skipped", r.skipped, 0);
  check("the run is not marked as stopped", r.ok === true && r.stopped === null);
  eq("results follow the input order", r.results.map((x) => x.id).join(","), ids(10).join(","));
  check("all models were actually probed", seen.length === 10, String(seen.length));
  check("a gap is waited between requests", clk.waits.length > 0 && clk.waits.every((w) => w === 100));
}

// Concurrency must be real, and bounded.
{
  let live = 0, peak = 0;
  const r = await B.runBatch(ids(12), async () => {
    live++; peak = Math.max(peak, live);
    await new Promise((res) => setTimeout(res, 5));
    live--; return { ok: true };
  }, { concurrency: 3, gapMs: 0 });
  check("requests really do run in parallel", peak > 1, `peak ${peak}`);
  eq("parallelism stays within the limit", peak <= 3, true);
  eq("all results still arrive", r.tested, 12);
}
{
  let peak = 0, live = 0;
  await B.runBatch(ids(6), async () => {
    live++; peak = Math.max(peak, live);
    await new Promise((res) => setTimeout(res, 5));
    live--; return { ok: true };
  }, { concurrency: 99, gapMs: 0 });
  check("an absurd concurrency is capped", peak <= 8, `peak ${peak}`);
}
{
  let peak = 0, live = 0;
  await B.runBatch(ids(4), async () => {
    live++; peak = Math.max(peak, live);
    await new Promise((res) => setTimeout(res, 5));
    live--; return { ok: true };
  }, { concurrency: 0, gapMs: 0 });
  check("a zero concurrency still makes progress", peak >= 1);
}

// ------------------------------------------------------------ rate limits
// A run of 429s means the account is throttled. Continuing would report working
// models as broken, so the batch must stop and say why.
{
  const clk = fakeClock();
  const probed = [];
  const r = await B.runBatch(ids(50), async (id) => { probed.push(id); return { ok: false, status: 429, message: "429" }; },
    { concurrency: 1, gapMs: 100, wait: clk.wait });
  check("a streak of rate limits stops the batch", r.stopped?.reason === "rate-limited", JSON.stringify(r.stopped));
  eq("it stops at the streak threshold", r.tested, B.RATE_LIMIT_STREAK);
  check("the untested models are counted as skipped", r.skipped === 50 - B.RATE_LIMIT_STREAK, String(r.skipped));
  check("the run is not reported as ok", r.ok === false);
  check("the reason mentions the provider, not the models", /ограничивает частоту/.test(r.stopped?.message || ""));
  check("the reason says the rest were not checked", /не проверялись/.test(r.stopped?.message || ""));
  check("no further requests are made after stopping", probed.length === B.RATE_LIMIT_STREAK, String(probed.length));
  check("the gap grows after each rate limit", clk.waits.length ? clk.waits[clk.waits.length - 1] > 100 : true,
    JSON.stringify(clk.waits));
}

// Scattered 429s are survivable — those must slow the run down, not end it.
{
  const clk = fakeClock();
  let n = 0;
  const r = await B.runBatch(ids(12), async () => {
    n++; return n % 4 === 0 ? { ok: false, status: 429 } : { ok: true };
  }, { concurrency: 1, gapMs: 100, wait: clk.wait });
  check("occasional rate limits do not stop the batch", r.stopped === null, JSON.stringify(r.stopped));
  eq("all models are still tested", r.tested, 12);
  eq("the rate limits are counted", r.rateLimited, 3);
  check("the pace slows down after a limit", r.gapMs > 100, String(r.gapMs));
  check("a success resets the streak", r.passed === 9, String(r.passed));
}

// The slowdown must be bounded, otherwise a long run stalls for minutes.
{
  const clk = fakeClock();
  let n = 0;
  // Alternate limit/success so the streak never trips but backoff keeps firing.
  const r = await B.runBatch(ids(40), async () => { n++; return n % 2 ? { ok: false, status: 429 } : { ok: true }; },
    { concurrency: 1, gapMs: 100, wait: clk.wait });
  check("the backoff is capped", r.gapMs <= B.MAX_GAP_MS, String(r.gapMs));
  check("no single wait exceeds the cap", clk.waits.every((w) => w <= B.MAX_GAP_MS));
}

// A gap of zero must not disable backoff — otherwise 0 * 2 stays 0 forever.
{
  const clk = fakeClock();
  const r = await B.runBatch(ids(2), async () => ({ ok: false, status: 429 }), { concurrency: 1, gapMs: 0, wait: clk.wait });
  check("backoff works even when the initial gap is zero", r.gapMs > 0, String(r.gapMs));
}

// ------------------------------------------------------- account-wide stop
{
  const probed = [];
  const r = await B.runBatch(ids(30), async (id) => { probed.push(id); return { ok: false, status: 401, message: "Неверный ключ" }; },
    { concurrency: 1, gapMs: 0 });
  check("a bad key stops the batch immediately", r.stopped?.reason === "auth", JSON.stringify(r.stopped));
  eq("only one model is probed before stopping", probed.length, 1);
  check("the message says it is not the model's fault", /не к модели/.test(r.stopped?.message || ""), r.stopped?.message);
  check("the message names the model it tried", /m0/.test(r.stopped?.message || ""));
}
{
  const r = await B.runBatch(ids(5), async () => ({ ok: false, fault: "proxy", message: "прокси недоступен" }), { concurrency: 1, gapMs: 0 });
  eq("a proxy fault stops the batch as a proxy problem", r.stopped?.reason, "proxy");
}
// Observed live on gorouter: three models answered on the key, the fourth
// returned a bare 403. A key that has already worked cannot be "rejected", so
// the run must not abort and hide the models behind it.
{
  const r = await B.runBatch(ids(6), async (id) => (id === "m3"
    ? { ok: false, status: 401, fault: "key", message: "Ключ не принят (403)" }
    : { ok: true }), { concurrency: 1, gapMs: 0 });
  check("a key failure after a success does not stop the batch", r.stopped === null, JSON.stringify(r.stopped));
  eq("the models after it are still checked", r.tested, 6);
  eq("the working models are all reported", r.passed, 5);
}
// But a key that has never worked still stops the run on the first failure:
// that is the case where continuing produces 100 identical wrong answers.
{
  const probed = [];
  const r = await B.runBatch(ids(6), async (id) => { probed.push(id); return { ok: false, status: 401, fault: "key" }; },
    { concurrency: 1, gapMs: 0 });
  eq("a key that never worked still stops the run", r.stopped?.reason, "auth");
  eq("it stops on the first failure", probed.length, 1);
}
// A model that genuinely does not exist is not account-wide: keep going.
{
  const r = await B.runBatch(ids(6), async (id) => (id === "m2" ? { ok: false, status: 404, message: "no such model" } : { ok: true }),
    { concurrency: 1, gapMs: 0 });
  check("one dead model does not stop the batch", r.stopped === null);
  eq("the dead model is reported as failed", r.failed, 1);
  eq("the rest still pass", r.passed, 5);
}

// ------------------------------------------------------------------ misc
{
  const r = await B.runBatch([], async () => ({ ok: true }), { gapMs: 0 });
  check("an empty list is not an error", r.ok === true && r.tested === 0);
}
{
  const r = await B.runBatch(["a", "", null, "  ", "b"], async () => ({ ok: true }), { gapMs: 0 });
  eq("blank ids are dropped", r.results.map((x) => x.id).join(","), "a,b");
}
// Retry on transport failures. Measured live: two models timed out on roughly
// every other 20s probe and answered in ~4.6s otherwise, so a single attempt
// called working models dead about half the time.
{
  const tries = {};
  const r = await B.runBatch(ids(4), async (id) => {
    tries[id] = (tries[id] || 0) + 1;
    if (id === "m2" && tries[id] === 1) return { ok: false, reach: "down", kind: "timeout", message: "таймаут" };
    return { ok: true };
  }, { concurrency: 1, gapMs: 0, wait: async () => {} });
  eq("a timeout is retried once", tries.m2, 2);
  eq("the retried model is reported as working", r.passed, 4);
  eq("the retry is recorded", r.results.find((x) => x.id === "m2").attempts, 2);
}
{
  const tries = {};
  await B.runBatch(["a"], async (id) => { tries[id] = (tries[id] || 0) + 1; return { ok: false, reach: "down", kind: "timeout" }; },
    { concurrency: 1, gapMs: 0, wait: async () => {} });
  eq("a persistent timeout is not retried forever", tries.a, B.RETRY_TRANSPORT + 1);
}
{
  // An HTTP status is an answer. Repeating the request cannot change it and
  // costs the user another call against their quota.
  const tries = {};
  await B.runBatch(["a"], async (id) => { tries[id] = (tries[id] || 0) + 1; return { ok: false, status: 404, fault: "model" }; },
    { concurrency: 1, gapMs: 0, wait: async () => {} });
  eq("a 404 is not retried", tries.a, 1);
}
{
  const tries = {};
  await B.runBatch(["a"], async (id) => { tries[id] = (tries[id] || 0) + 1; return { ok: false, status: 429 }; },
    { concurrency: 1, gapMs: 0, wait: async () => {} });
  eq("a rate limit is not retried", tries.a, 1);
}
{
  const tries = {};
  await B.runBatch(["a"], async (id) => { tries[id] = (tries[id] || 0) + 1; return { ok: false, fault: "proxy", reach: "down" }; },
    { concurrency: 1, gapMs: 0, wait: async () => {} });
  eq("a proxy failure is not retried", tries.a, 1);
}
check("a timeout counts as a transport failure", B.isTransportFailure({ reach: "down", kind: "timeout" }));
// An empty-bodied 403 from a gateway that serves the same request seconds later
// is noise. It carries a status, so the plain rule would refuse to retry it.
check("an explicitly transient refusal is retried", B.isTransportFailure({ status: 403, transient: true }));
{
  const tries = {};
  const r = await B.runBatch(["a"], async (id) => {
    tries[id] = (tries[id] || 0) + 1;
    return tries[id] === 1 ? { ok: false, status: 403, fault: "blocked", transient: true } : { ok: true };
  }, { concurrency: 1, gapMs: 0, wait: async () => {} });
  eq("a transient 403 is retried", tries.a, 2);
  eq("and the model is then reported as working", r.passed, 1);
}
check("an http answer is not a transport failure", B.isTransportFailure({ status: 500, reach: "up" }) === false);
{
  const r = await B.runBatch(ids(4), async (id) => { if (id === "m1") throw new Error("сеть отвалилась"); return { ok: true }; },
    { concurrency: 1, gapMs: 0 });
  eq("a thrown error becomes a failed result", r.failed, 1);
  check("the thrown message is kept", /сеть отвалилась/.test(r.results.find((x) => x.id === "m1").message));
  eq("the batch continues past a thrown error", r.tested, 4);
}
{
  const r = await B.runBatch(ids(3), async () => undefined, { concurrency: 1, gapMs: 0 });
  eq("an empty probe reply is a failure, not a crash", r.failed, 3);
}
{
  const seen = [];
  await B.runBatch(ids(5), async () => ({ ok: true }), { concurrency: 1, gapMs: 0, onProgress: (p) => seen.push(p.done) });
  eq("progress is reported for every model", seen.join(","), "1,2,3,4,5");
}
{
  const ac = new AbortController();
  let n = 0;
  const r = await B.runBatch(ids(20), async () => { if (++n === 3) ac.abort(); return { ok: true }; },
    { concurrency: 1, gapMs: 0, signal: ac.signal });
  check("aborting stops the batch", r.stopped?.reason === "aborted", JSON.stringify(r.stopped));
  check("the abort leaves the finished results intact", r.tested >= 3 && r.tested < 20, String(r.tested));
}
{
  // Duplicate ids must not make results vanish or double up.
  const r = await B.runBatch(["a", "a", "b"], async () => ({ ok: true }), { gapMs: 0 });
  eq("duplicate ids do not corrupt the result list", r.results.length, 3);
}

console.log(`\n${pass}/${pass + fails.length} passed`);
for (const f of fails) console.log("  - " + f);
process.exit(fails.length ? 1 : 0);
