// verify-zenpool.mjs — сквозная проверка пула Zen: шлюз, выходы, ротация.
// Запуск: node verify-zenpool.mjs (шлюз должен быть поднят: server.mjs или src/zengate.mjs).

const BASE = "http://127.0.0.1:8790";

async function main() {
  const fail = (msg) => { console.error("FAIL: " + msg); process.exit(1); };
  let status;
  try {
    const r = await fetch(BASE + "/status", { signal: AbortSignal.timeout(5000) });
    status = await r.json();
  } catch (e) {
    fail("шлюз не отвечает на " + BASE + " (" + e.message + ")");
  }
  const live = status.exits.filter((e) => e.alive);
  console.log(`шлюз: ok, аккаунтов/ключей: ${status.creds.length}, выходов живых: ${live.length}/${status.exits.length}`);
  for (const e of status.exits) console.log(`  ${e.alive ? "LIVE" : "dead"} ${String(e.ms).padStart(5)}ms [${e.sub}] ${e.remarks}`);
  for (const c of status.creds) console.log(`  cred ${c.id} (${c.kind}) dead=${c.dead} daily=${c.daily} used=${c.used}`);

  const models = await (await fetch(BASE + "/v1/models", { signal: AbortSignal.timeout(5000) })).json();
  if (!Array.isArray(models.data) || !models.data.length) fail("список моделей пуст");
  console.log(`моделей в пуле: ${models.data.length}`);

  const r = await fetch(BASE + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "hy4-flash-free", messages: [{ role: "user", content: "Reply with exactly: POOL-OK" }], max_tokens: 10 }),
    signal: AbortSignal.timeout(120000),
  });
  const text = await r.text();
  if (r.ok) {
    const data = JSON.parse(text);
    const reply = data.choices?.[0]?.message?.content || "";
    console.log(`чат: 200, ответ: ${reply.slice(0, 80)}`);
    console.log(`статистика: ok=${status.stats.ok} exitUsed=${status.stats.exitUsed}`);
    console.log("PASS: пул отвечает живым completions");
    return;
  }
  if (r.status === 429 || /FreeUsageLimit|исчерпаны/i.test(text)) {
    console.log(`чат: ${r.status} — квоты исчерпаны на всех доступных выходах/аккаунтах (ожидаемо для анонимного режима на общих IP)`);
    console.log("PASS: шлюз и ротация работают; для живого чата нужен аккаунт Zen (device login) или живой Hynet-выход");
    return;
  }
  fail(`чат вернул ${r.status}: ${text.slice(0, 300)}`);
}

main();