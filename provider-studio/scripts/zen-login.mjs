// scripts/zen-login.mjs — удобный вход в ещё один аккаунт Zen для пула.
//
// Делает четыре вещи:
//  1. Архивирует текущий аккаунт из opencode.db в data/zen-accounts.json,
//     чтобы пул не потерял его после переключения (новый вход перезаписывает
//     активный credential в БД).
//  2. Поднимает живой выход VPN (BlancVPN/VPNLiberty/Hynet) и пускает login
//     через него: Bun не умеет DNS напрямую (WFP), а прокси резолвит удалённо.
//     Если живых выходов нет — идёт напрямую (спасает hosts-пин opencode.ai).
//  3. Запускает `opencode auth login opencode --method device --standalone`:
//     в консоли появится код и ссылка — подтверди вход в браузере.
//  4. После входа перечитывает аккаунты в шлюзе (POST /reload) и показывает пул.
//
// Запуск: node scripts/zen-login.mjs [--dry-run]  (или scripts\zen-login.cmd)

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { loadNodes, ExitManager } from "../src/exits.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const OPENCODE_DB = "C:/Users/STEPWICE/.local/share/opencode/opencode.db";
const ACCOUNTS_FILE = path.join(ROOT, "data", "zen-accounts.json");
const GATE = "http://127.0.0.1:8790";
const DRY = process.argv.includes("--dry-run");

function readActiveCred() {
  try {
    const db = new DatabaseSync(OPENCODE_DB, { readOnly: true });
    const rows = db.prepare("SELECT value FROM credential WHERE integration_id='opencode' AND active=1").all();
    db.close();
    for (const r of rows) {
      try {
        const c = JSON.parse(r.value);
        if (c.type === "oauth" && c.access) return c;
      } catch {}
    }
  } catch (e) {
    console.log("Не удалось прочитать opencode.db:", e.message);
  }
  return null;
}

function archiveCurrent(cred) {
  if (!cred) return;
  let list = [];
  try { list = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8")); } catch {}
  if (!Array.isArray(list)) list = list.accounts || [];
  const email = cred.metadata?.email || "unknown";
  const entry = {
    id: email,
    token: cred.access,
    refresh: cred.refresh || "",
    expires: cred.expires || 0,
    archivedAt: new Date().toISOString(),
  };
  const i = list.findIndex((a) => a.id === email);
  if (i >= 0) list[i] = entry; else list.push(entry);
  fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true });
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(list, null, 2));
  console.log(`Архивирован аккаунт ${email} (токен до ${new Date(entry.expires).toISOString().slice(0, 10)}) → data/zen-accounts.json`);
}

async function pickExit() {
  const mgr = new ExitManager({ basePort: 14900 });
  const nodes = loadNodes().filter((n) => ["BlancVPN", "VPNLiberty", "Hynet"].includes(n.sub));
  const bySub = {};
  for (const n of nodes) (bySub[n.sub] ||= []).push(n);
  const subs = Object.keys(bySub);
  for (let i = 0; i < 12; i++) {
    for (const s of subs) {
      const node = bySub[s][i];
      if (!node) continue;
      const entry = await mgr.start(node);
      if (!entry) continue;
      const checked = await mgr.check(node.id);
      if (checked?.alive) {
        console.log(`Выход для входа: ${node.sub} ${node.remarks} (${checked.ms} мс, порт ${entry.port})`);
        return { mgr, port: entry.port, id: node.id };
      }
      mgr.stop(node.id);
    }
  }
  mgr.stopAll();
  return { mgr: null, port: 0, id: "" };
}

function runLogin(proxyPort) {
  const env = { ...process.env };
  if (proxyPort) {
    env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
    env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
  } else {
    delete env.HTTP_PROXY; delete env.HTTPS_PROXY; delete env.ALL_PROXY;
    console.log("Живых выходов нет — login пойдёт напрямую (нужен hosts-пин opencode.ai).");
  }
  console.log("\nЗапускаю opencode auth login. Подтверди код в браузере, затем вернись сюда.\n");
  return new Promise((resolve) => {
    const child = spawn("opencode", ["auth", "login", "opencode", "--method", "device", "--standalone"], {
      stdio: "inherit",
      env,
      shell: true,
      windowsHide: true,
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", (e) => { console.log("Не удалось запустить opencode:", e.message); resolve(1); });
  });
}

async function reloadGate() {
  try {
    const r = await fetch(GATE + "/reload", { method: "POST", signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(String(r.status));
    const s = await (await fetch(GATE + "/status", { signal: AbortSignal.timeout(5000) })).json();
    console.log(`\nШлюз перечитал аккаунты. В пуле: ${(s.creds || []).map((c) => c.id).join(", ") || "пусто"}`);
  } catch {
    console.log("\nШлюз на 8790 не отвечает — аккаунты подхватятся при следующем старте шлюза/Studio.");
  }
}

const before = readActiveCred();
console.log(before ? `Текущий аккаунт: ${before.metadata?.email || "?"}` : "В opencode.db пока нет аккаунта Zen.");
archiveCurrent(before);

const exit = await pickExit();
if (DRY) {
  console.log("\n--dry-run: вход не запускаю. Архивация и выбор выхода работают.");
  if (exit.mgr) exit.mgr.stopAll();
  process.exit(0);
}

const code = await runLogin(exit.port);
if (exit.mgr) exit.mgr.stopAll();

const after = readActiveCred();
if (code === 0 && after) {
  const email = after.metadata?.email || "?";
  console.log(`\nВход выполнен: ${email}`);
  if (before && before.metadata?.email === email) {
    console.log("Это тот же аккаунт, что был до входа. Для нового аккаунта выбери другой Google-аккаунт в браузере.");
  }
  await reloadGate();
} else {
  console.log(`\nВход не завершён (код ${code}). Прежний аккаунт сохранён в архиве пула.`);
  await reloadGate();
}
process.exit(code === 0 ? 0 : 1);