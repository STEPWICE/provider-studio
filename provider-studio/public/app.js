"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s, ctx) => [...(ctx || document).querySelectorAll(s)];

const state = {
  providers: [],
  targets: [],
  formats: [],
  selectedTargets: new Set(["opencode"]),
  models: [],
  editingModelIndex: null,
  discoverModels: [],
  discoverFilters: new Set(),
  discoverSelected: new Set(),
  discoverSearch: "",
  // Filter for the saved-provider sidebar list.
  providerSearch: "",
  // Presets that pre-fill base URL / format / env var in the wizard.
  presets: [],
  // Wizard progress: which step is on screen and what has been chosen.
  wizardStep: 0,
  wizardPreset: null,
  configHasComments: false,
  // Which config file edits go to. Empty means "let the server decide".
  configPath: "",
  configs: [],
  // Hash of the config as last read. Sent with every write so the server can
  // refuse when something else changed the file in the meantime.
  configHash: "",
  // The opencode key a loaded provider currently has, so a rename moves the
  // existing block instead of leaving an orphan behind.
  editingKey: "",
  // What the confirm button in the diff modal should do.
  pendingAction: null,
  // Probe results by provider key, filled in by a diagnostics run. Empty means
  // "not checked yet", which is rendered as a neutral dot rather than green.
  health: {},
  // The last diagnostics payload, kept so the "copy report" action can render
  // it without re-probing every provider.
  lastDiag: null,
  // Hash of the on-disk change the external-edit banner was already shown for,
  // so the poll does not re-raise a dismissed banner every 5 seconds.
  extNotifiedHash: "",
};

const INPUT_TYPES = ["text", "image", "video", "audio", "pdf"];
const OUTPUT_TYPES = ["text", "image", "video", "audio", "pdf"];

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") return [v];
  return [];
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: `HTTP ${r.status}: ${text.slice(0, 200)}` };
  }
}

function toast(msg, kind) {
  setStatus(msg, kind);
  const el = $("#status");
  el.classList.add("toast-show");
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => el.classList.remove("toast-show"), 3000);
}

function setBtnLoading(btn, loading) {
  if (loading) {
    btn.disabled = true;
    btn.dataset.origText = btn.textContent;
    btn.textContent = "...";
  } else {
    btn.disabled = false;
    if (btn.dataset.origText) btn.textContent = btn.dataset.origText;
  }
}

async function init() {
  const d = await api("/api/state");
  state.formats = asArray(d.formats);
  state.targets = asArray(d.targets);
  state.presets = asArray(d.presets);
  // The store file has historically held a bare object; never assume an array.
  const live = asArray(d.opencode && d.opencode.providers);
  const byName = new Map();
  for (const p of [...asArray(d.providers), ...live]) {
    if (p && p.name) byName.set(String(p.name), p);
  }
  state.providers = [...byName.values()];
  state.backups = asArray(d.backups);

  const sel = $("#f-format");
  sel.innerHTML = state.formats.map((f) => `<option value="${esc(f.id)}">${esc(f.label)}</option>`).join("");
  sel.value = "openai-chat";
  updateFormatNote();

  $("#targets").innerHTML = state.targets.map((t) => `
    <div class="target-item ${state.selectedTargets.has(t.id) ? "on" : ""}" data-id="${esc(t.id)}">
      <span class="dot"></span><span>${esc(t.label)}</span>
    </div>`).join("");

  renderTargetChips();
  renderProviderList();

  if (d.opencode) {
    updateConfigChip(d.opencode);
    state.configHasComments = !!d.opencode.comments;
    state.configHash = d.opencode.hash || "";
  }
  await loadConfigList();

  renderModelList();

  $("#targets").addEventListener("click", (e) => {
    const el = e.target.closest(".target-item");
    if (el) toggleTarget(el.dataset.id);
  });
  $("#f-format").addEventListener("change", updateFormatNote);
  $("#f-env").addEventListener("change", () => setEnvMode($("#f-env").checked));
  $("#providerSearch").addEventListener("input", (e) => {
    state.providerSearch = e.target.value.trim().toLowerCase();
    renderProviderList();
  });
  // The wire format is derivable from the URL in every case we support, and a
  // wrong pick only surfaces as a 404 much later, inside opencode.
  $("#f-baseurl").addEventListener("change", () => {
    if (state.formatTouched) return;
    const guess = detectFormatFromURL($("#f-baseurl").value);
    if (guess && guess !== $("#f-format").value) {
      $("#f-format").value = guess;
      updateFormatNote();
      toast(`Формат определён по URL: ${guess}`, "");
    }
  });
  $("#f-format").addEventListener("change", () => { state.formatTouched = true; });
  $("#btnEye").addEventListener("click", () => {
    const inp = $("#f-apikey");
    const isPass = inp.type === "password";
    inp.type = isPass ? "text" : "password";
    $("#btnEye").textContent = isPass ? "\u{1F441}" : "\u{1F441}\u200D\u{1F5E8}";
  });
  $("#f-envname").addEventListener("input", renderKeyHint);
  // Offer a conventional variable name, but never overwrite a manual entry.
  $("#f-name").addEventListener("input", () => {
    const box = $("#f-envname");
    if (box.dataset.touched === "1") return;
    box.value = suggestEnvName($("#f-name").value);
    renderKeyHint();
  });
  $("#f-envname").addEventListener("input", () => { $("#f-envname").dataset.touched = "1"; });
  $("#btnAddModel").addEventListener("click", () => openModelModal());
  $("#btnTestAll").addEventListener("click", async () => {
    setBtnLoading($("#btnTestAll"), true);
    try { await testAllModels(); } finally { setBtnLoading($("#btnTestAll"), false); }
  });
  $("#btnApply").addEventListener("click", async () => {
    setBtnLoading($("#btnApply"), true);
    try { await apply(); } finally { setBtnLoading($("#btnApply"), false); }
  });
  $("#btnPaste").addEventListener("click", copyJson);
  $("#btnPreview").addEventListener("click", async () => {
    setBtnLoading($("#btnPreview"), true);
    try { await preview(); } finally { setBtnLoading($("#btnPreview"), false); }
  });
  $("#diffClose").addEventListener("click", closeDiff);
  $("#diffCancel").addEventListener("click", closeDiff);
  $("#diffBackdrop").addEventListener("click", (e) => { if (e.target.id === "diffBackdrop") closeDiff(); });
  $("#diffConfirm").addEventListener("click", async () => {
    const fn = state.pendingAction;
    if (!fn) return closeDiff();
    setBtnLoading($("#diffConfirm"), true);
    try { await fn(); } finally { setBtnLoading($("#diffConfirm"), false); }
  });
  $("#f-default").addEventListener("change", renderDefaultModelPicker);
  $("#configPicker").addEventListener("change", async () => {
    state.configPath = $("#configPicker").value;
    // Switching files invalidates the hash: it belongs to the previous file.
    state.configHash = "";
    rememberConfigPath(state.configPath);
    const d = await api("/api/state");
    if (d.opencode) { updateConfigChip(d.opencode); }
    toast("Правки пойдут в: " + state.configPath, "");
  });
  $("#btnNew").addEventListener("click", () => {
    if (confirm("Сбросить форму? Несохранённые изменения будут потеряны.")) {
      state.models = [];
      state.editingKey = "";
      renderModelList();
      $$("#f-name, #f-baseurl, #f-apikey, #f-envname").forEach(el => el.value = "");
      delete $("#f-envname").dataset.touched;
      $("#f-format").value = "openai-chat";
      updateFormatNote();
      restoreDefaults();
      toast("Форма очищена", "");
    }
  });
  $("#btnTest").addEventListener("click", async () => {
    setBtnLoading($("#btnTest"), true);
    try { await testConnection(); } finally { setBtnLoading($("#btnTest"), false); }
  });
  $("#btnValidate").addEventListener("click", validate);
  $("#btnBackupNow").addEventListener("click", backupNow);
  $("#btnUndo").addEventListener("click", doUndo);
  $("#btnPerks").addEventListener("click", async () => {
    setBtnLoading($("#btnPerks"), true);
    try { await renderDigest(false); } finally { setBtnLoading($("#btnPerks"), false); }
  });
  $("#extChangeBtn").addEventListener("click", async () => {
    $("#extChange").hidden = true;
    state.extNotifiedHash = "";
    await refreshConfigState();
    toast("Хеш обновлён — можно записывать", "ok");
  });
  // The poll is deliberately dumb (one cheap hash compare per 5s, paused in a
  // hidden tab): file watching across atomic renames is unreliable, while a
  // missed external edit turns the next write into a confusing 409.
  setInterval(pollExternalChanges, 5000);
  refreshUndo();
  $("#btnImport").addEventListener("click", importFromOpenCode);
  $("#btnDiscover").addEventListener("click", async () => {
    setBtnLoading($("#btnDiscover"), true);
    try { await openDiscover(); } finally { setBtnLoading($("#btnDiscover"), false); }
  });
  $("#btnDiag").addEventListener("click", async () => {
    setBtnLoading($("#btnDiag"), true);
    try { await diagnose(); } finally { setBtnLoading($("#btnDiag"), false); }
  });
  $("#discoverClose").addEventListener("click", closeDiscover);
  $("#discoverCancel").addEventListener("click", closeDiscover);
  $("#discoverAdd").addEventListener("click", addDiscovered);
  $("#discoverBackdrop").addEventListener("click", (e) => { if (e.target.id === "discoverBackdrop") closeDiscover(); });
  let searchTimeout;
  $("#disc-search").addEventListener("input", (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      state.discoverSearch = e.target.value.toLowerCase();
      renderDiscoverList();
    }, 150);
  });
  $("#btnWizard").addEventListener("click", openWizard);
  $("#wizClose").addEventListener("click", closeWizard);
  $("#wizardBackdrop").addEventListener("click", (e) => { if (e.target.id === "wizardBackdrop") closeWizard(); });
  $("#wizBack").addEventListener("click", () => showWizardStep(state.wizardStep - 1));
  $("#wizNext").addEventListener("click", async () => {
    if (state.wizardStep === WIZ_LAST) {
      setBtnLoading($("#wizNext"), true);
      try { await finishWizard(); } finally { setBtnLoading($("#wizNext"), false); }
      return;
    }
    // Validate before advancing: discovering models needs a usable base URL,
    // and failing at step 3 would send the user back anyway.
    if (state.wizardStep === 1) {
      if (!$("#wiz-name").value.trim()) return toast("Укажи название провайдера", "err");
      if (!$("#wiz-baseurl").value.trim()) return toast("Укажи Base URL", "err");
    }
    setBtnLoading($("#wizNext"), true);
    try { showWizardStep(state.wizardStep + 1); } finally { setBtnLoading($("#wizNext"), false); }
  });
  $("#wiz-env").addEventListener("change", syncWizEnvField);
  $("#wiz-envname").addEventListener("input", syncWizEnvField);
  $("#wizEye").addEventListener("click", () => {
    const inp = $("#wiz-apikey");
    inp.type = inp.type === "password" ? "text" : "password";
  });
  $("#wizReload").addEventListener("click", async () => {
    setBtnLoading($("#wizReload"), true);
    try { await loadWizardModels(); } finally { setBtnLoading($("#wizReload"), false); }
  });
  $("#wizFreeOnly").addEventListener("click", () => {
    state.wizFreeOnly = !state.wizFreeOnly;
    $("#wizFreeOnly").classList.toggle("on", state.wizFreeOnly);
    renderWizardModels();
  });
  let wizSearchTimer;
  $("#wiz-search").addEventListener("input", (e) => {
    clearTimeout(wizSearchTimer);
    wizSearchTimer = setTimeout(() => {
      state.wizSearch = e.target.value.trim().toLowerCase();
      renderWizardModels();
    }, 150);
  });
  // Auto-fill the variable name from the provider name unless it was typed.
  $("#wiz-name").addEventListener("input", () => {
    if ($("#wiz-envname").dataset.touched === "1") return;
    if (!$("#wiz-env").checked) return;
    const p = state.wizardPreset;
    // A preset ships the conventional name; only derive one for "custom".
    if (p && p.envVarName) return;
    $("#wiz-envname").value = suggestEnvName($("#wiz-name").value);
    syncWizEnvField();
  });
  $("#wiz-envname").addEventListener("input", () => { $("#wiz-envname").dataset.touched = "1"; });

  $$(".filter-chip").forEach((ch) => ch.addEventListener("click", () => {
    const f = ch.dataset.f;
    if (state.discoverFilters.has(f)) state.discoverFilters.delete(f); else state.discoverFilters.add(f);
    ch.classList.toggle("on", state.discoverFilters.has(f));
    renderDiscoverList();
  }));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("#modalBackdrop").hidden) closeModal();
      else if (!$("#discoverBackdrop").hidden) closeDiscover();
      else if (!$("#diffBackdrop").hidden) closeDiff();
      else if (!$("#wizardBackdrop").hidden) closeWizard();
      return;
    }
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test((e.target && e.target.tagName) || "");
    // "/" focuses the provider filter, the way list UIs usually behave.
    if (e.key === "/" && !typing) {
      const box = $("#providerSearch");
      if (box && !box.hidden) { e.preventDefault(); box.focus(); box.select(); }
      return;
    }
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    // Ctrl+S is muscle memory for "save"; without this the browser offers to
    // save the page, which is never what the user meant here.
    if (k === "s") { e.preventDefault(); $("#btnApply").click(); return; }
    if (k === "d") { e.preventDefault(); $("#btnPreview").click(); return; }
  });

  // Unsaved models are easy to lose by reloading; warn while the form is dirty.
  window.addEventListener("beforeunload", (e) => {
    if (!state.models.length && !$("#f-name").value.trim()) return;
    if (!state.dirty) return;
    e.preventDefault();
    e.returnValue = "";
  });
  for (const sel of ["#f-name", "#f-baseurl", "#f-apikey", "#f-envname", "#f-format"]) {
    $(sel).addEventListener("input", () => { state.dirty = true; });
  }

  restoreDefaults();
}

// Keeping the key out of the config is the default: only the env-var reference
// is written, so the config stays safe to sync or commit.
function setEnvMode(on) {
  $("#f-env").checked = on;
  $(".env-toggler").classList.toggle("on", on);
  $("#f-envname").style.display = on ? "" : "none";
  // The env-state line describes a variable that is irrelevant in literal mode.
  if (!on) $("#envState").hidden = true;
  renderKeyHint();
}

function renderKeyHint() {
  // Ask the server whether the variable exists; debounced so typing a name does
  // not fire a request per keystroke.
  clearTimeout(window._envTimer);
  window._envTimer = setTimeout(checkEnvVar, 300);

  const el = $("#keyHint");
  if (!el) return;
  if ($("#f-env").checked) {
    const name = $("#f-envname").value.trim();
    if (!name) {
      el.className = "fmt-note";
      el.textContent = "Укажи имя переменной — в конфиг попадёт ссылка {env:ИМЯ}, а не сам ключ.";
      return;
    }
    el.className = "fmt-note";
    el.textContent = `В конфиг запишется {env:${name}}. Установи переменную один раз: setx ${name} "твой-ключ" — затем перезапусти терминал и opencode.`;
  } else {
    el.className = "fmt-note warn";
    el.textContent = "Ключ будет записан в opencode-конфиг открытым текстом. Включи $ENV, чтобы этого избежать.";
  }
}

function toggleTarget(id) {
  if (state.selectedTargets.has(id)) state.selectedTargets.delete(id);
  else state.selectedTargets.add(id);
  $$("#targets .target-item").forEach((el) => el.classList.toggle("on", state.selectedTargets.has(el.dataset.id)));
  renderTargetChips();
}

function renderTargetChips() {
  const container = $("#targetChips");
  container.innerHTML = state.targets.map((t) => `
    <span class="chip ${state.selectedTargets.has(t.id) ? "on" : ""}" data-id="${esc(t.id)}">
      <span class="ck"></span>${esc(t.label)}
    </span>`).join("");
  container.onclick = (e) => {
    const el = e.target.closest(".chip");
    if (el) toggleTarget(el.dataset.id);
  };
}

/**
 * Availability dot for a sidebar row.
 *
 * Populated only by an actual diagnostics run; until then the dot is neutral
 * rather than green, because showing a provider as healthy without having
 * probed it is exactly the false reassurance this whole change is fixing.
 */
function healthDot(p) {
  const h = state.health[slugifyName(p.name)] || state.health[p.name];
  if (!h) return `<span class="hdot" title="Состояние неизвестно — запусти диагностику"></span>`;
  if (h.reach === "unknown") return `<span class="hdot" title="Нет своего Base URL — проверить нечего"></span>`;
  if (h.reach === "up" && h.fault === "nokey") {
    return `<span class="hdot is-warn" title="Сервер отвечает, но ключ не отправлен"></span>`;
  }
  if (h.reach === "up" && h.fault === "key") {
    return `<span class="hdot is-warn" title="Сервер отвечает, но ключ не принят"></span>`;
  }
  if (h.reach === "up") return `<span class="hdot is-up" title="Провайдер отвечает"></span>`;
  if (h.fault === "proxy") return `<span class="hdot is-down" title="Прокси не пропустил запрос"></span>`;
  return `<span class="hdot is-down" title="Сервер недоступен"></span>`;
}

function renderProviderList() {
  const list = $("#providerList");
  const q = state.providerSearch;
  const shown = q
    ? state.providers.filter((p) => String(p.name || "").toLowerCase().includes(q))
    : state.providers;

  const count = $("#providerCount");
  if (count) {
    count.textContent = state.providers.length
      ? (q ? `${shown.length}/${state.providers.length}` : String(state.providers.length))
      : "";
  }
  // The search box is useless with nothing to search and misleading when a
  // filter is the reason the list looks empty.
  const search = $("#providerSearch");
  if (search) search.hidden = state.providers.length < 6;

  if (!state.providers.length) {
    list.innerHTML = `<div class="empty-models">Пока нет сохранённых провайдеров.<br>Начни с «Мастера настройки».</div>`;
    return;
  }
  if (!shown.length) {
    list.innerHTML = `<div class="empty-models">Ничего не найдено по «${esc(q)}».</div>`;
    return;
  }
  // Two distinct destructive actions, spelled out: dropping the row from this
  // tool is not the same as deleting the provider from the opencode config, and
  // one button labelled "×" gave no way to tell them apart.
  // The "opencode" badge only tells the user something when some rows lack it.
  // Measured: with every provider imported it took 53px from a 227px row and
  // clipped "GenSparkOSNOVA" to "GenSpar…" while saying nothing at all.
  const mixed = shown.some((p) => p.fromOpenCode) && shown.some((p) => !p.fromOpenCode);
  list.innerHTML = shown.map((p) => `
    <div class="provider-row" data-name="${esc(p.name)}" tabindex="0" role="button">
      ${healthDot(p)}
      <span class="nm" title="${esc(p.name)}">${esc(p.name)}</span>
      ${p.fromOpenCode && mixed ? `<span class="badge">opencode</span>` : ""}
      <button class="ren" title="Переименовать ключ провайдера в конфиге" aria-label="Переименовать ${esc(p.name)}">\u270e</button>
      <button class="wipe" title="Удалить провайдера из opencode-конфига" aria-label="Удалить ${esc(p.name)} из конфига">\u2327</button>
      <button class="del" title="Убрать из списка Provider Studio (конфиг не тронут)" aria-label="Убрать ${esc(p.name)} из списка">\u00d7</button>
    </div>`).join("");
  list.querySelectorAll(".provider-row").forEach((row) => {
    const open = () => {
      loadProviderIntoForm(row.dataset.name);
      $(".main").scrollTo({ top: 0, behavior: "smooth" });
    };
    row.addEventListener("click", (e) => {
      if (e.target.classList.contains("del")) {
        e.stopPropagation();
        if (!confirm(`Убрать «${row.dataset.name}» из списка Provider Studio? В opencode-конфиге провайдер останется.`)) return;
        api("/api/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: row.dataset.name }) })
          .then((r) => { state.providers = asArray(r.providers); renderProviderList(); });
        return;
      }
      if (e.target.classList.contains("wipe")) {
        e.stopPropagation();
        removeFromConfig(row.dataset.name);
        return;
      }
      if (e.target.classList.contains("ren")) {
        e.stopPropagation();
        renameInConfig(row.dataset.name);
        return;
      }
      open();
    });
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  });
}

function restoreDefaults() {
  $("#f-default").checked = true;
  window._defaultTouched = false;
  // Env-var mode is the default so keys never land in the config file.
  setEnvMode(true);
}

// BAI / DeepSeek -> BAI_DEEPSEEK_API_KEY
function suggestEnvName(name) {
  const base = String(name || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return base ? `${base}_API_KEY` : "";
}

// Mirrors slugify() on the server so the UI can predict the opencode key.
function slugifyName(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Mirrors detectFormatFromURL() in src/presets.mjs. Kept in sync by verify-ui.
function detectFormatFromURL(baseURL) {
  const u = String(baseURL || "").toLowerCase();
  if (!u) return "";
  if (u.includes("api.anthropic.com")) return "anthropic";
  if (/\/v1\/messages\/?$/.test(u)) return "anthropic";
  if (/\/responses\/?$/.test(u)) return "openai-responses";
  return "openai-chat";
}

// Whether the variable the config will reference actually exists in this
// process's environment. `{env:FOO}` with FOO unset authenticates as "".
async function checkEnvVar() {
  const el = $("#envState");
  if (!el) return;
  const name = $("#f-envname").value.trim();
  if (!$("#f-env").checked || !name) { el.hidden = true; return; }
  const r = await api("/api/envcheck", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  el.hidden = false;
  if (!r.ok) {
    el.className = "env-state is-unset";
    el.textContent = `\u26a0 ${r.error || "не удалось проверить"}`;
    return;
  }
  if (r.set) {
    // Found only in the registry means already-open terminals will not see it,
    // which is the difference between "works" and "401" for opencode.
    const inherited = asArray(r.scopes).includes("process");
    el.className = inherited ? "env-state is-set" : "env-state is-warn";
    const where = r.scope === "machine" ? "система" : r.scope === "user" ? "пользователь" : "процесс";
    el.textContent = `${inherited ? "\u2713" : "\u26a0"} ${name} задана (${r.length} симв., ${where})`;
    if (r.note) el.title = r.note;
  } else {
    el.className = "env-state is-unset";
    el.innerHTML = `\u26a0 ${esc(name)} не задана \u2014 иначе opencode отправит пустой ключ и получит 401.
      <button class="btn btn-mini" id="setEnvBtn" type="button">Задать сейчас</button>
      <span class="setx">setx ${esc(name)} "твой-ключ"</span>`;
    el.title = r.note || "";
    const b = $("#setEnvBtn");
    // Uses the key already in the form; the server never echoes it back.
    if (b) b.onclick = () => setEnvFromField(name, $("#f-apikey").value, el, "#setEnvBtn");
  }
}

/**
 * Server-side truth about the variable a provider is about to reference.
 * Returns null when the check could not be made, so callers can tell "unknown"
 * apart from "definitely unset" and avoid blocking on a failed request.
 */
async function envVarStatus(name) {
  const clean = String(name || "").trim();
  if (!clean) return null;
  const r = await api("/api/envcheck", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: clean }),
  });
  if (!r || !r.ok) return null;
  return r;
}

// Which of this provider's models becomes `model` in the config. Previously the
// server just took the first one, so there was no way to choose.
function renderDefaultModelPicker() {
  const sel = $("#f-defaultmodel");
  const on = $("#f-default").checked;
  sel.hidden = !on || !state.models.length;
  if (sel.hidden) { sel.innerHTML = ""; return; }
  const prev = sel.value;
  sel.innerHTML = state.models
    .map((m) => `<option value="${esc(m.id)}">${esc(m.name || m.id)}</option>`).join("");
  // Keep the user's pick across re-renders when it still exists.
  if (prev && state.models.some((m) => m.id === prev)) sel.value = prev;
}

async function refreshConfigState() {
  const d = await api("/api/state");
  if (d.opencode) {
    state.configHash = d.opencode.hash || "";
    state.configHasComments = !!d.opencode.comments;
    updateConfigChip(d.opencode);
    // A fresh read settles the external-edit question either way.
    state.extNotifiedHash = "";
    const banner = $("#extChange");
    if (banner) banner.hidden = true;
  }
  syncUndoButton(d && d.undo);
  return d;
}

// The undo button mirrors the server's last-write record. Updated from every
// /api/state answer (explicit refreshes and the background poll alike), so no
// mutation site has to remember it — though the important ones still refresh
// eagerly rather than waiting up to 5 seconds for the poll.
function syncUndoButton(u) {
  const b = $("#btnUndo");
  if (!b) return;
  b.disabled = !u;
  b.title = u && u.label ? `Откатить: ${u.label}` : "Откатывать нечего";
}

async function refreshUndo() {
  let d = null;
  try { d = await api("/api/state"); } catch { return; }
  syncUndoButton(d && d.undo);
}

// Reverts the last config write. The server snapshots the current file first,
// so even a mistaken undo stays recoverable from the backup list.
async function doUndo() {
  const b = $("#btnUndo");
  if (b) setBtnLoading(b, true);
  try {
    const r = await api("/api/undo", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ configPath: state.configPath }),
    });
    if (!r || !r.ok) return toast((r && r.error) || "Откатывать нечего", "err");
    if (typeof r.hash === "string") state.configHash = r.hash;
    // Undoing a creation removes the file; the chip has to say so.
    await refreshConfigState();
    refreshBackups();
    toast(r.removed ? `Файл удалён (откат: ${r.label || ""})` : `Откачено: ${r.label || ""}. Перезапусти opencode.`, "ok");
    await diagnose();
  } finally {
    if (b) setBtnLoading(b, false);
  }
}

/**
 * Watches the config file for edits made outside this page (a text editor,
 * another harness, a second tab). The server is the source of truth; this
 * only compares hashes and never rewrites anything on its own.
 *
 * Two outcomes: when the form is clean the new hash is adopted silently (there
 * is nothing to lose), and when the user has unsaid things in the form a
 * banner offers to re-read instead of letting the next write die with a 409.
 */
async function pollExternalChanges() {
  if (document.hidden) return;
  let d = null;
  try { d = await api("/api/state"); } catch { return; }
  if (!d || !d.opencode) return;
  syncUndoButton(d.undo);
  // The hash belongs to the server's active file; comparing it against the
  // hash of a different file the user picked would cry wolf on every poll.
  if (state.configPath && d.opencode.path !== state.configPath) return;
  const live = d.opencode.hash || "";
  if (!live || live === state.configHash) {
    state.extNotifiedHash = "";
    const e = $("#extChange");
    if (e) e.hidden = true;
    return;
  }
  if (live === state.extNotifiedHash) return;
  if (isFormDirty()) {
    state.extNotifiedHash = live;
    const e = $("#extChange");
    if (e) e.hidden = false;
  } else {
    state.configHash = live;
  }
}

function isFormDirty() {
  if (state.dirty) return true;
  if ((state.models || []).length) return true;
  const name = $("#f-name");
  const url = $("#f-baseurl");
  return !!((name && name.value.trim()) || (url && url.value.trim()));
}

// The path is the only thing worth showing here, truncated from the left by CSS
// because the tail identifies the file. The old chip repeated the full path that
// the picker already displayed, which filled half the header twice over.
function updateConfigChip(oc) {
  const chip = $("#openCodeChip");
  const path = oc.path || "";
  chip.textContent = path;
  const state_ = oc.error ? `ошибка: ${oc.error}`
    : oc.exists ? "файл существует"
    : "файла нет — будет создан при записи";
  chip.title = `${path}\n${state_}`;
  chip.classList.toggle("has-error", !!oc.error);
  chip.classList.toggle("is-missing", !oc.error && !oc.exists);
}

async function loadConfigList() {
  const r = await api("/api/configs");
  const configs = asArray(r.configs);
  state.configs = configs;
  const sel = $("#configPicker");
  // With a single candidate the picker is noise.
  if (configs.length < 2) { sel.hidden = true; return; }
  sel.hidden = false;
  // Short scope labels only: the full path is right next to it in the chip, and
  // repeating it here forced the select to be ~500px wide.
  sel.innerHTML = configs.map((c) => {
    const mark = c.exists ? "" : " (нет файла)";
    const file = String(c.path || "").split(/[\\/]/).pop();
    return `<option value="${esc(c.path)}" title="${esc(c.path)}" ${c.active ? "selected" : ""}>${esc(c.scope)} · ${esc(file)}${mark}</option>`;
  }).join("");
  // Restore the file the user picked last time, but only if it is still one of
  // the candidates — a remembered path that vanished would silently redirect
  // every write to a file that does not exist.
  const saved = recallConfigPath();
  const savedMatch = saved && configs.find((c) => c.path === saved);
  if (savedMatch) {
    state.configPath = savedMatch.path;
    sel.value = savedMatch.path;
    return;
  }
  const active = configs.find((c) => c.active);
  if (active) state.configPath = active.path;
}

// localStorage is per-origin and this app is always http://localhost:<port>, so
// the preference survives restarts. Guarded because storage can be disabled.
function rememberConfigPath(p) {
  try { localStorage.setItem("ps.configPath", p || ""); } catch { /* ignore */ }
}
function recallConfigPath() {
  try { return localStorage.getItem("ps.configPath") || ""; } catch { return ""; }
}

// Renames just the provider key in the config, keeping the block (and its
// comments) intact. Editing the Name field instead would rewrite the whole
// block from the form and drop anything the form does not model.
async function renameInConfig(name) {
  const from = slugifyName(name);
  const input = prompt(`Новый ключ провайдера вместо «${from}»:`, from);
  if (input === null) return;
  const to = slugifyName(input);
  if (!to) return toast("Ключ не может быть пустым", "err");
  if (to === from) return toast("Ключ не изменился", "");

  const r = await api("/api/rename-provider", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, configPath: state.configPath, hash: state.configHash }),
  });
  if (!r.ok) {
    if (r.conflict) await refreshConfigState();
    return toast(r.error || "Не удалось переименовать", "err");
  }
  if (r.hash) state.configHash = r.hash;
  if (state.editingKey === from) state.editingKey = to;
  const d = await api("/api/state");
  state.providers = asArray(d.providers);
  renderProviderList();
  refreshBackups();
  refreshUndo();
  toast(`Переименовано: ${from} → ${to}. Перезапусти opencode.`, "ok");
}

// Removes the provider from the opencode config itself, not just from our list.
async function removeFromConfig(name) {
  const key = slugifyName(name);
  const r = await api("/api/preview-remove", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, configPath: state.configPath }),
  });
  if (!r.ok) return toast(r.error || "Не удалось построить diff удаления", "err");
  state.configHash = r.hash || "";

  const orphaned = asArray(r.orphaned);
  openDiff({
    title: `Удалить «${key}» из конфига`,
    meta: `<div class="diff-path">${esc(r.path || "")}</div>
      <div class="diff-stat"><span class="plus">+${r.diff ? r.diff.added : 0}</span>
      <span class="minus">-${r.diff ? r.diff.removed : 0}</span></div>`,
    diff: r.diff,
    // A dangling default model stops opencode from starting, so say so up front.
    hint: orphaned.length ? `Будет переназначено: ${orphaned.join(", ")}` : "",
    confirmLabel: "Удалить из конфига",
    onConfirm: async () => {
      closeDiff();
      const res = await api("/api/remove-provider", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, configPath: state.configPath, hash: state.configHash }),
      });
      if (!res.ok) {
        if (res.conflict) await refreshConfigState();
        return toast(res.error || "Не удалось удалить", "err");
      }
      state.providers = asArray(res.providers);
      renderProviderList();
      renderBackups(asArray(res.backups));
      await refreshConfigState();
      refreshUndo();
      toast(`Провайдер «${key}» удалён. Перезапусти opencode.`, "ok");
    },
  });
}

function loadProviderIntoForm(name) {
  const p = state.providers.find((x) => x.name === name);
  if (!p) return;
  // Remember the key this provider currently has in the config: renaming the
  // display name must move that block, not leave an orphan behind.
  state.editingKey = slugifyName(p.name);
  state.dirty = false;
  $("#f-name").value = p.name || "";
  $("#f-baseurl").value = p.baseURL || "";
  // Keys are never persisted server-side, so this is empty for stored providers.
  $("#f-apikey").value = p.apiKey || "";
  if (p.apiFormat) $("#f-format").value = p.apiFormat;
  updateFormatNote();
  state.models = (p.models || []).map((m) => ({ ...m }));
  if (p.useEnvVar && p.envVarName) {
    $("#f-envname").value = p.envVarName;
    $("#f-envname").dataset.touched = "1"; // keep the stored name, don't re-suggest
    setEnvMode(true);
  } else {
    setEnvMode(false);
  }
  renderModelList();
}

/**
 * Verdict marker for a model that was probed live.
 *
 * Three states, not two: "не проверялась" must not look like "не работает".
 * A model refused by the plan gets its own mark, because the fix for it is
 * different from the fix for a model that does not exist.
 */
function probeMark(p) {
  if (!p) return "";
  if (p.ok) return `<span class="pmark ok" title="Модель ответила на пробный запрос">\u2713</span> `;
  if (p.fault === "plan") return `<span class="pmark plan" title="Ключ рабочий, но модель не входит в твой тариф">\u20bd</span> `;
  // A gateway that refuses one request and serves the next is not a broken
  // model. Marking it with the same ✕ invites the user to delete something
  // that works: measured live, one gateway did this on ~1 request in 6.
  if (p.fault === "blocked") return `<span class="pmark wait" title="Шлюз отклонил запрос временно — ключ и модель, скорее всего, в порядке. Попробуй ещё раз">\u21bb</span> `;
  return `<span class="pmark bad" title="Пробный запрос не прошёл">\u2715</span> `;
}

function probeNote(p) {
  if (!p || p.ok) return "";
  return ` \u00b7 <span class="pnote">${esc(p.message || "проверка не прошла")}</span>`;
}

/**
 * Probes every configured model with one real request each.
 *
 * The pacing and the stop conditions live on the server (src/batch.mjs); this
 * only has to report honestly, which means distinguishing "checked and failed"
 * from "never checked because the run stopped early". Presenting the second as
 * the first is how a throttled account turns into a screen of models the user
 * would otherwise delete.
 */
async function testAllModels() {
  const ids = state.models.map((m) => m.id).filter(Boolean);
  const box = $("#batchStatus");
  if (!ids.length) { toast("Сначала добавь модели", "err"); return; }
  if (!confirm(`Отправить по одному настоящему запросу к ${ids.length} модел${plural(ids.length, "и", "ям", "ям")}?\n` +
    `Это реальные запросы к провайдеру — они могут стоить денег и займут время.`)) return;

  box.hidden = false;
  box.className = "batch-status";
  box.textContent = `Проверяю ${ids.length} моделей\u2026`;

  const r = await api("/api/testchat-batch", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: collectProvider(), modelIds: ids }),
  });
  const res = r.result || {};
  const done = new Set();
  state.probeResults = {};
  for (const x of res.results || []) { state.probeResults[x.id] = x; done.add(x.id); }

  const untested = ids.filter((id) => !done.has(id));
  // "Не работает" and "не оплачено" are different answers with different fixes,
  // so they are counted apart. Lumping a plan limit in with broken models made
  // a fully working key look like a wall of failures.
  const results = res.results || [];
  const plan = results.filter((x) => !x.ok && x.fault === "plan").length;
  const blocked = results.filter((x) => !x.ok && x.fault === "blocked").length;
  const broken = results.filter((x) => !x.ok && x.fault !== "plan" && x.fault !== "blocked").length;
  const parts = [`Проверено ${res.tested || 0} из ${res.total || ids.length}`,
    `рабочих ${res.passed || 0}`];
  if (plan) parts.push(`не по тарифу ${plan}`);
  if (blocked) parts.push(`временно отклонены ${blocked}`);
  if (broken) parts.push(`не отвечают ${broken}`);
  if (res.rateLimited) parts.push(`ограничений по частоте ${res.rateLimited}`);
  // Red is reserved for something the user must fix. A model outside the plan
  // is information, not a fault in the setup.
  box.className = "batch-status " + (res.stopped ? "warn" : (res.passed ? "ok" : (broken ? "err" : "warn")));
  box.innerHTML = esc(parts.join(" \u00b7 ")) +
    (res.stopped ? `<div class="batch-stop">${esc(res.stopped.message || "")}</div>` : "") +
    (untested.length ? `<div class="batch-stop">Не проверялись (${untested.length}): ${esc(untested.slice(0, 8).join(", "))}${untested.length > 8 ? "\u2026" : ""}</div>` : "");
  renderModelList();
}

/**
 * One live request to one model, straight from its row. Unlike "check all"
 * this runs immediately (no batch queue) and reports through the same
 * probeMark/probeNote marks, so a single-model check and a bulk run can never
 * paint different pictures of the same model.
 */
async function testSingleModel(index, btn) {
  const m = state.models[index];
  if (!m || !m.id) return;
  const provider = collectProvider();
  if (!provider.baseURL) return toast("Укажи Base URL для теста", "err");
  if (btn) setBtnLoading(btn, true);
  try {
    const r = await api("/api/testchat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, modelId: m.id }),
    });
    state.probeResults = state.probeResults || {};
    state.probeResults[m.id] = { id: m.id, ...(r.result || { ok: false, message: (r && r.error) || "не удалось проверить" }) };
    const p = state.probeResults[m.id];
    toast(`${p.ok ? "\u2713" : "\u2715"} ${m.id}: ${p.message || ""}`, p.ok ? "ok" : "err");
  } finally {
    if (btn) setBtnLoading(btn, false);
    renderModelList();
  }
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

function renderModelList() {
  renderDefaultModelPicker();
  const list = $("#modelList");
  if (!state.models.length) {
    list.innerHTML = `<div class="empty-models">
      <b>Моделей пока нет.</b><br>
      Нажми «Обнаружить модели», чтобы получить список с сервера, или добавь вручную.
    </div>`;
    return;
  }
  list.innerHTML = state.models.map((m, i) => {
    const limits = (m.contextWindow || m.maxOutput)
      ? `ctx ${esc(fmtNum(m.contextWindow))} \u00b7 out ${esc(fmtNum(m.maxOutput))}`
      : "лимиты не заданы";
    const probe = state.probeResults ? state.probeResults[m.id] : null;
    return `<div class="model-row">
      <div class="mi">
        <div class="mid">${probeMark(probe)}${esc(m.id)}</div>
        <div class="meta">${limits}${m.name && m.name !== m.id ? " \u00b7 " + esc(m.name) : ""}${probeNote(probe)}</div>
      </div>
      <div class="tags">
        ${(m.inputTypes || []).map((t) => `<span class="tag ${t === "image" ? "vis" : ""}">${esc(t)}</span>`).join("")}
        ${m.reasoning ? `<span class="tag reason">reasoning</span>` : ""}
        ${m.toolUse !== false ? `<span class="tag">tools</span>` : ""}
      </div>
      <div class="row-actions">
        <button class="rm" data-test="${i}" title="Отправить пробный запрос к этой модели (потратит ~16 токенов)">&#x26a1;</button>
        <button class="rm ed" data-edit="${i}" title="Редактировать">\u270e</button>
        <button class="rm" data-i="${i}" title="Удалить">&times;</button>
      </div>
    </div>`;
  }).join("");
  // The delete selector names data-i explicitly: matching "every .rm that is
  // not .ed" would also catch the per-model probe button added above.
  list.querySelectorAll(".rm[data-i]").forEach((btn) => btn.addEventListener("click", () => {
    state.models.splice(Number(btn.dataset.i), 1);
    renderModelList();
  }));
  list.querySelectorAll(".rm[data-test]").forEach((btn) => btn.addEventListener("click", () => {
    testSingleModel(Number(btn.dataset.test), btn);
  }));
  list.querySelectorAll(".rm.ed").forEach((btn) => btn.addEventListener("click", () => {
    openModelModal(Number(btn.dataset.edit));
  }));
}

function fmtNum(n) {
  const v = Number(n || 0);
  if (v >= 1e6) return (v / 1e6).toLocaleString("ru") + "M";
  if (v >= 1e3) return (v / 1e3).toLocaleString("ru") + "k";
  return String(v || 0);
}

function openModelModal(index = null) {
  state.editingModelIndex = index;
  const m = index != null ? state.models[index] : {};
  $("#m-id").value = m.id || "";
  $("#m-name").value = m.name || "";
  // Left blank when unknown: inventing a context window writes a wrong `limit`
  // into the config, and opencode needs context and output together or neither.
  $("#m-context").value = m.contextWindow ? String(m.contextWindow) : "";
  $("#m-output").value = m.maxOutput ? String(m.maxOutput) : "";
  $("#m-reasoning").checked = !!m.reasoning;
  $("#m-tools").checked = m.toolUse !== false;
  renderChipGroup("#m-inputs", INPUT_TYPES, m.inputTypes || ["text"], () => {});
  renderChipGroup("#m-outputs", OUTPUT_TYPES, m.outputTypes || ["text"], () => {});
  $("#modalBackdrop").hidden = false;
  $("#m-id").focus();
}

function renderChipGroup(sel, options, selected, save) {
  const el = $(sel);
  el.dataset.selected = JSON.stringify(selected);
  el.innerHTML = options.map((t) => `<span class="chip ${selected.includes(t) ? "on" : ""}" data-t="${t}">${t}</span>`).join("");
  el.onclick = (e) => {
    const ch = e.target.closest(".chip");
    if (!ch) return;
    const arr = JSON.parse(el.dataset.selected);
    const t = ch.dataset.t;
    const idx = arr.indexOf(t);
    if (idx >= 0) arr.splice(idx, 1); else arr.push(t);
    el.dataset.selected = JSON.stringify(arr);
    save(arr);
    $$(sel + " .chip").forEach((c) => c.classList.toggle("on", arr.includes(c.dataset.t)));
  };
}

function closeModal() { $("#modalBackdrop").hidden = true; }

$("#modalClose").addEventListener("click", closeModal);
$("#m-cancel").addEventListener("click", closeModal);
$("#modalBackdrop").addEventListener("click", (e) => { if (e.target.id === "modalBackdrop") closeModal(); });
$("#m-save").addEventListener("click", () => {
  const model = {
    id: $("#m-id").value.trim(),
    name: $("#m-name").value.trim(),
    contextWindow: Number($("#m-context").value) || 0,
    maxOutput: Number($("#m-output").value) || 0,
    inputTypes: JSON.parse($("#m-inputs").dataset.selected || "[\"text\"]"),
    outputTypes: JSON.parse($("#m-outputs").dataset.selected || "[\"text\"]"),
    reasoning: $("#m-reasoning").checked,
    toolUse: $("#m-tools").checked,
  };
  if (!model.id) { $("#m-id").focus(); return toast("Укажи ID модели", "err"); }
  // opencode requires context and output together; one without the other is invalid.
  const half = (model.contextWindow > 0) !== (model.maxOutput > 0);
  if (half) return toast("Заполни оба поля (контекст и макс. выход) или оставь оба пустыми", "err");
  const dup = state.models.findIndex((m) => m.id === model.id);
  if (dup >= 0 && dup !== state.editingModelIndex) return toast("Такая модель уже добавлена", "err");
  if (state.editingModelIndex != null) state.models[state.editingModelIndex] = model;
  else state.models.push(model);
  closeModal();
  renderModelList();
});

function updateFormatNote() {
  const notes = {
    "anthropic": "Anthropic-совместимый. Kilo/Cline/Roo: \u00abAnthropic\u00bb.",
    "openai-chat": "OpenAI-совместимый. Kilo/Cline/Roo: \u00abOpenAI Compatible\u00bb. Подходит для DeepSeek, Z.ai, BAI, локальных.",
    "openai-responses": "OpenAI Responses. Kilo/Cline: \u00abOpenAI / Responses\u00bb.",
  };
  $("#f-format-note").textContent = notes[$("#f-format").value] || "";
}

function collectProvider() {
  const useEnv = $("#f-env").checked;
  const name = $("#f-name").value.trim();
  return {
    id: Date.now(),
    name,
    baseURL: $("#f-baseurl").value.trim(),
    apiKey: $("#f-apikey").value.trim(),
    apiFormat: $("#f-format").value,
    useEnvVar: useEnv,
    envVarName: useEnv ? ($("#f-envname").value.trim() || suggestEnvName(name)) : "",
    setAsDefault: $("#f-default").checked,
    models: state.models,
  };
}

// Shared validation for both preview and apply, so the diff can never show a
// change that the subsequent write would reject.
function validateForm(provider) {
  if (!provider.name) return "Укажи Name";
  if (!provider.baseURL) return "Укажи Base URL";
  if (state.selectedTargets.has("opencode") && !provider.models.length)
    return "Добавь хотя бы одну модель";
  if (provider.useEnvVar && !provider.envVarName)
    return "Укажи имя переменной окружения";
  const ids = provider.models.map((m) => String(m.id || "").trim());
  if (ids.some((id) => !id)) return "У каждой модели должен быть ID";
  const dupe = ids.find((id, i) => ids.indexOf(id) !== i);
  // Duplicate ids silently collapse into one config key, losing a model.
  if (dupe) return `Модель «${dupe}» указана дважды`;
  return "";
}

function requestBody(provider) {
  return {
    provider,
    targets: [...state.selectedTargets],
    configPath: state.configPath,
    previousKey: state.editingKey,
    defaultModelId: $("#f-defaultmodel").value || "",
    hash: state.configHash,
  };
}

// Renders the unified diff the server computed. Nothing is written until the
// user confirms, so "Применить" stops being an act of faith.
function openDiff({ title, meta, diff, hint, onConfirm, confirmLabel }) {
  const view = $("#diffView");
  $("#diffTitle").textContent = title;
  $("#diffMeta").innerHTML = meta;
  $("#diffHint").textContent = hint || "";
  $("#diffConfirm").textContent = confirmLabel || "Записать в файл";
  state.pendingAction = onConfirm;

  const hunks = asArray(diff && diff.hunks);
  if (diff && diff.identical) {
    view.innerHTML = `<div class="diff-empty">Файл уже в нужном состоянии — записывать нечего.</div>`;
    $("#diffConfirm").disabled = true;
  } else if (!hunks.length) {
    view.innerHTML = `<div class="diff-empty">Изменений не обнаружено.</div>`;
    $("#diffConfirm").disabled = true;
  } else {
    $("#diffConfirm").disabled = false;
    view.innerHTML = hunks.map((h) => {
      const head = `<div class="hunk-head">@@ -${h.beforeStart},${h.beforeCount} +${h.afterStart},${h.afterCount} @@</div>`;
      const rows = asArray(h.lines).map((l) => {
        // buildPreview emits "remove", not "del" — mismatching it renders
        // deleted lines as plain context, hiding exactly what is being lost.
        const cls = l.type === "add" ? "add" : l.type === "remove" ? "del" : "ctx";
        const sign = l.type === "add" ? "+" : l.type === "remove" ? "-" : " ";
        return `<div class="dline ${cls}"><span class="sign">${sign}</span><span class="txt">${esc(l.text)}</span></div>`;
      }).join("");
      return head + rows;
    }).join("");
  }
  $("#diffBackdrop").hidden = false;
  $("#diffConfirm").focus();
}

function closeDiff() {
  $("#diffBackdrop").hidden = true;
  state.pendingAction = null;
}

// "Показать diff": preview only, never writes.
async function preview() {
  const provider = collectProvider();
  const err = validateForm(provider);
  if (err) return toast(err, "err");

  setStatus("Считаю изменения\u2026", "");
  const r = await api("/api/preview", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody(provider)),
  });
  if (!r.ok) return toast(r.error || "Не удалось построить diff", "err");

  // The hash travels with the write so a file that changed underneath us is
  // refused rather than silently overwritten.
  state.configHash = r.hash || "";
  const badges = [];
  if (r.created) badges.push(`<span class="tag">файл будет создан</span>`);
  if (r.previousKey && r.previousKey !== r.providerKey) {
    badges.push(`<span class="tag warn">переименование: ${esc(r.previousKey)} → ${esc(r.providerKey)}</span>`);
  }
  openDiff({
    title: "Что изменится в конфиге",
    meta: `<div class="diff-path">${esc(r.path || "")}</div>
      <div class="diff-stat"><span class="plus">+${r.diff ? r.diff.added : 0}</span>
      <span class="minus">-${r.diff ? r.diff.removed : 0}</span>
      ${badges.join(" ")}</div>`,
    diff: r.diff,
    hint: r.defaultModel ? `Модель по умолчанию: ${r.defaultModel}` : "",
    // Same env guard as the direct Apply button: confirming a diff must not be
    // a way to skip the check that the referenced variable exists.
    onConfirm: async () => { if (await confirmEnvKey(provider)) await applyNow(provider); },
  });
}

async function apply() {
  const provider = collectProvider();
  const err = validateForm(provider);
  if (err) return toast(err, "err");
  if (!provider.useEnvVar && provider.apiKey &&
      !confirm("Ключ будет записан в opencode-конфиг открытым текстом. Продолжить?"))
    return;
  if (!(await confirmEnvKey(provider))) return;
  await applyNow(provider);
}

/**
 * Guards the $ENV path, which used to fail silently.
 *
 * In $ENV mode the config gets `{env:VAR}` and the key typed into the form is
 * discarded. If VAR does not exist, opencode substitutes an empty string and
 * every request comes back 401 "Missing or invalid bearer token" — while this
 * tool had reported "✓ Применено". The write was correct; the setup was not,
 * and nothing said so before the user hit the failure in opencode.
 *
 * So: state plainly that the typed key is being dropped, and require an
 * explicit confirmation when the variable is missing. A failed check is treated
 * as "unknown" and does not block the write.
 *
 * Returns false when the user cancels.
 */
async function confirmEnvKey(provider) {
  if (!provider.useEnvVar) return true;
  const name = provider.envVarName;
  const info = await envVarStatus(name);

  // Nothing to warn about: the variable exists and this process inherited it.
  if (info && info.set && asArray(info.scopes).includes("process")) return true;

  const lines = [];
  if (provider.apiKey) {
    lines.push(
      `Режим $ENV включён, поэтому введённый ключ НЕ будет записан в конфиг — ` +
      `вместо него попадёт ссылка {env:${name}}.`,
    );
  }
  if (info && !info.set) {
    lines.push(
      ``,
      `Переменная ${name} не задана. opencode подставит пустую строку, и провайдер ответит 401.`,
      ``,
      `Сначала выполни в терминале:`,
      `    setx ${name} "твой-ключ"`,
      `затем перезапусти терминал и opencode.`,
    );
  } else if (info && info.set) {
    // Set in the registry but not inherited here.
    lines.push(``, info.note || `Переменная ${name} задана, но её увидят только новые терминалы.`);
  } else {
    lines.push(``, `Проверить переменную ${name} не удалось — убедись, что она задана.`);
  }
  lines.push(``, `Записать конфиг всё равно?`);
  return confirm(lines.join("\n"));
}

async function applyNow(provider) {
  closeDiff();
  // Reflect the env name the server will actually use.
  if (provider.useEnvVar) $("#f-envname").value = provider.envVarName;

  setStatus("Применяю\u2026", "");
  const res = await api("/api/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody(provider)),
  });
  // A concurrent edit is a normal outcome, not a crash: re-read and let the
  // user look at a fresh diff instead of clobbering the other change.
  if (res.conflict) {
    await refreshConfigState();
    return toast("Файл изменился на диске. Нажми «Показать diff» и проверь заново.", "err");
  }
  if (!res.ok) return toast(res.error || "Не удалось применить", "err");
  if (res.backupFile) setBackupInfo(`\u21bb Автобэкап: ${res.backupFile}`);
  if (Array.isArray(res.providers)) {
    state.providers = res.providers;
    renderProviderList();
  }
  // The write moved the file on, so the old hash is stale: adopt the new one or
  // the next save would be refused as a false conflict.
  const oc = res.results && res.results.opencode;
  if (oc) {
    if (oc.hash) state.configHash = oc.hash;
    if (oc.ok) state.editingKey = slugifyName(provider.name);
  }
  refreshBackups();
  refreshUndo();

  const resultsEl = $("#results");
  resultsEl.hidden = false;
  syncSidePlaceholder();
  resultsEl.innerHTML = "";
  for (const [target, r] of Object.entries(res.results || {})) {
    const name = (state.targets.find((t) => t.id === target) || { label: target }).label;
    const card = document.createElement("div");
    card.className = "result-card";
    if (target === "opencode") {
      const notes = [];
      if (r.ok && r.created) notes.push("Конфиг создан с нуля.");
      // Only shown if the server actually reports a loss; the patcher preserves
      // comments, so claiming otherwise would be a lie that scares users off.
      if (r.ok && r.commentsLost) notes.push("Комментарии в конфиге удалены при перезаписи — прежняя версия в бэкапе.");
      if (r.ok && provider.useEnvVar) {
        notes.push(`Ключ не записан в конфиг. Установи переменную: setx ${provider.envVarName} "твой-ключ" — затем перезапусти терминал.`);
      }
      card.innerHTML = `
        <h3>opencode</h3>
        ${r.ok ? `<div class="ok-line">\u2713 Применено. Модель по умолчанию: ${esc(r.model || "\u2014")}</div>`
               : `<div class="err-line">\u2715 ${esc(r.error || "ошибка")}</div>`}
        ${notes.map((n) => `<div class="ok-line" style="color:var(--muted)">${esc(n)}</div>`).join("")}
        <div class="ok-line" style="color:var(--muted)">config: ${esc(r.path || "")}</div>`;
      toast(r.ok ? "Готово. Перезапусти opencode." : "opencode: " + (r.error || "ошибка"), r.ok ? "ok" : "err");
    } else {
      card.innerHTML = `
        <h3>${esc(name)}</h3>
        <div class="ok-line">\u2713 Сгенерирован конфиг (формат: ${esc(r.formatLabel || "")})</div>
        <div class="ok-line" style="color:var(--muted)">${esc(r.guide || "").replace(/\n/g, "<br>")}</div>
        <pre>${esc(JSON.stringify(r.manifest, null, 2))}</pre>`;
    }
    resultsEl.appendChild(card);
  }
}

function setStatus(msg, kind) {
  const el = $("#status");
  el.className = "status " + (kind || "");
  el.textContent = msg;
}

async function copyJson() {
  const provider = collectProvider();
  // Copy goes to the clipboard and often into a chat or an issue: strip the key.
  const { apiKey, ...safe } = provider;
  const manifest = {
    provider: {
      ...safe,
      apiKey: provider.useEnvVar
        ? `<значение переменной ${provider.envVarName}>`
        : (provider.apiKey ? "<вставь свой API-ключ>" : ""),
    },
  };
  await navigator.clipboard.writeText(JSON.stringify(manifest, null, 2));
  toast("JSON скопирован (без ключа)", "ok");
}

async function testConnection() {
  const provider = collectProvider();
  if (!provider.baseURL) return toast("Укажи Base URL для теста", "err");
  setStatus("Проверяю\u2026", "");
  const r = await api("/api/test", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider }),
  });
  const t = r.result || {};
  const msg = `${t.ok ? "\u2713" : "\u2715"} ${t.message || ""}`;
  toast(msg, t.ok ? "ok" : "err");
  if (t.url) $("#status").title = `Ответ ${t.status || ""} от ${t.url}`;
}

async function validate() {
  const r = await api("/api/validate");
  const el = $("#issues");
  const issues = asArray(r.issues);
  el.hidden = false;
  if (!issues.length) {
    el.innerHTML = `<div class="result-card"><h3>Проверка конфига</h3><div class="ok-line">\u2713 Проблем не найдено.</div><div class="ok-line" style="color:var(--muted)">config: ${esc(r.path || "")}</div></div>`;
    toast("Конфиг валиден", "ok");
    return;
  }
  const nErr = issues.filter((i) => i.severity === "error").length;
  el.innerHTML = `<div class="result-card"><h3>Проверка конфига \u2014 ошибок: ${nErr}, предупреждений: ${issues.length - nErr}</h3>` +
    issues.map((i) => `<div class="${i.severity === "error" ? "err-line" : "ok-line"}" style="color:var(--text)">
      ${i.severity === "error" ? "\u2715" : "\u26a0"} ${esc(i.message)}
      ${i.fixable ? `<span class="tag">fixable</span>` : ""}</div>`).join("") +
    `<div class="ok-line" style="color:var(--muted)">config: ${esc(r.path || "")}</div></div>`;
  syncSidePlaceholder();
  toast(nErr ? "Есть ошибки в конфиге" : "Есть предупреждения", nErr ? "err" : "");
}

function setBackupInfo(msg) {
  const el = $("#backupInfo");
  el.textContent = msg;
}

async function backupNow() {
  setBackupInfo("Создаю бэкап\u2026");
  const r = await api("/api/backup", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (r.file) {
    setBackupInfo(`\u21bb Бэкап создан: ${r.file}`);
    await refreshBackups();
  } else setBackupInfo("Бэкап не создан (конфиг отсутствует)");
}

async function refreshBackups() {
  const r = await api("/api/validate");
  renderBackups(asArray(r.backups));
}

function renderBackups(backups) {
  state.backups = backups;
  const el = $("#backups");
  if (!backups.length) { el.hidden = true; syncSidePlaceholder(); return; }
  el.hidden = false;
  syncSidePlaceholder();
  el.innerHTML = `<div class="result-card"><h3>Бэкапы</h3>` +
    backups.map((b) => {
      return `<div class="backup-row">
        <span class="bname">${esc(b.file)}</span>
        <span class="bsize">${(b.size / 1024).toFixed(1)} KB</span>
        <button class="btn btn-ghost bs" data-file="${esc(b.file)}">Восстановить</button>
      </div>`;
    }).join("") + `</div>`;
  el.querySelectorAll(".backup-row .bs").forEach((btn) => btn.addEventListener("click", async () => {
    if (!confirm("Восстановить конфиг из этого бэкапа? Текущий будет заменён (перед этим его снимут в бэкап).")) return;
    const r = await api("/api/restore", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: btn.dataset.file }),
    });
    toast(r.ok ? "Конфиг восстановлен. Перезапусти opencode." : ("Ошибка: " + (r.error || "")), r.ok ? "ok" : "err");
    // A restore rewrites the file, so the hash this page holds is stale and the
    // next write would be refused as a false conflict.
    await refreshConfigState();
    await refreshBackups();
    refreshUndo();
    $("#results").hidden = true;
    syncSidePlaceholder();
  }));
}

async function importFromOpenCode() {
  const r = await api("/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (!r.ok) return toast(r.error || "Импорт не удался", "err");
  const imported = asArray(r.imported);
  toast(imported.length ? `Импортировано: ${imported.join(", ")}` : "Новых провайдеров из opencode конфига нет", "ok");
  state.providers = asArray(r.providers);
  renderProviderList();
}

async function openDiscover() {
  const provider = collectProvider();
  if (!provider.baseURL) return toast("Сначала укажи Base URL", "err");
  $("#discoverBackdrop").hidden = false;
  $("#discoverStatus").className = "discover-status";
  $("#discoverStatus").textContent = "Загружаю /models\u2026";
  $("#discoverList").innerHTML = `<div class="discover-empty">Поиск моделей\u2026</div>`;
  $("#discoverAdd").textContent = "Добавить выбранные (0)";
  const r = await api("/api/discover", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider }),
  });
  const res = r.result || {};
  const st = $("#discoverStatus");
  if (!res.ok) {
    st.className = "discover-status err";
    st.textContent = "\u2715 " + (res.message || "Не удалось получить модели");
    $("#discoverList").innerHTML = `<div class="discover-empty">Не удалось загрузить модели.</div>`;
    return;
  }
  st.className = "discover-status ok";
  // Say when specs came from the catalogue rather than from this endpoint.
  // Presenting a borrowed context window as the provider's own answer is the
  // failure this whole feature is built to avoid.
  const enr = res.enriched;
  const extra = enr && enr.filled
    ? ` \u00b7 характеристики дополнены из models.dev для ${enr.filled} моделей`
    : enr && enr.error ? ` \u00b7 каталог models.dev недоступен` : "";
  st.textContent = "\u2713 " + (res.message || "") + extra;
  if (enr && enr.error) st.title = enr.error;
  state.discoverModels = asArray(res.models);
  state.discoverSelected = new Set();
  for (const m of state.discoverModels) {
    if (state.models.some((e) => e.id === m.id)) state.discoverSelected.add(m.id);
  }
  renderDiscoverList();
}

/**
 * Keeps the side-column placeholder in step with the panels it stands in for.
 *
 * Driven by the panels' own `hidden` state rather than by each call site, so a
 * new panel cannot forget to hide it and leave "здесь появятся результаты"
 * sitting above actual results.
 */
function syncSidePlaceholder() {
  const ph = $("#sideEmpty");
  if (!ph) return;
  const anyShown = ["#issues", "#backups", "#results"]
    .some((sel) => { const el = $(sel); return el && !el.hidden; });
  ph.hidden = anyShown;
}

/** "$0.97" style price, trimmed so cheap models do not render as "$0.07000". */
function money(v) {
  if (v == null || !Number.isFinite(v)) return "";
  if (v === 0) return "$0";
  if (v < 0.01) return `$${v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  if (v < 1) return `$${v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}`;
}

/**
 * The free/paid badge, including how sure we are.
 *
 * `freeSource` matters: a verdict read off the provider's own `access_tier` is
 * a fact, one inferred from ":free" in the name is a guess, and no pricing data
 * at all is neither. Rendering all three identically would let a guess bill the
 * user, so a guess is marked with "?" and the tooltip says where it came from.
 */
function priceTag(m) {
  const per = " за 1M токенов";
  if (m.free) {
    const guess = m.freeSource === "name";
    const why = m.freeSource === "tier" ? `провайдер помечает тариф как «${m.tier || "free"}»`
      : m.freeSource === "price" ? "провайдер указал нулевую цену"
      : "предположение по названию модели — проверь у провайдера";
    return `<span class="tag free" title="${esc(why)}">free${guess ? "?" : ""}</span>`;
  }
  if (m.costInput != null && m.costOutput != null) {
    const label = `${money(m.costInput)} / ${money(m.costOutput)}`;
    return `<span class="tag paid" title="Вход ${money(m.costInput)}${per}, выход ${money(m.costOutput)}${per}">${esc(label)}</span>`;
  }
  if (m.tier) return `<span class="tag paid" title="Тариф провайдера">${esc(m.tier)}</span>`;
  // Silence is not "free": say outright that the price is unknown.
  return `<span class="tag unknown" title="Провайдер не сообщил цену — уточни у него">цена ?</span>`;
}

/**
 * One selectable model row, used by both the discovery dialog and the wizard.
 * Kept in one place so a tag added to one list cannot go missing from the other.
 */
function pickableModelRow(m, selected) {
  return `<div class="dmodel ${selected ? "selected" : ""}" data-id="${esc(m.id)}">
    <span class="ck2">${selected ? "\u2713" : ""}</span>
    <span class="dname">${esc(m.id)}</span>
    <div class="tags">
      ${priceTag(m)}
      ${(m.inputTypes || []).includes("image") ? `<span class="tag vis">vision</span>` : ""}
      ${m.reasoning ? `<span class="tag reason">reasoning</span>` : ""}
      ${catalogTag(m)}
    </div>
  </div>`;
}

/**
 * Marks a row whose specs were completed from models.dev.
 *
 * Borrowed numbers must not look like the provider's own answer, so the tag
 * names the fields and the number of sources. Conflicts are worth surfacing
 * too: "the catalogue knows this model but its sources disagree" is a real
 * answer, and silently showing nothing would read as "no data exists".
 */
function catalogTag(m) {
  if (m.specSource !== "catalog" || !(m.specFields || []).length) {
    if ((m.specConflicts || []).length) {
      const names = m.specConflicts.map((c) => c.field).join(", ");
      return `<span class="tag unknown" title="Каталог models.dev знает эту модель, но источники расходятся по полям: ${esc(names)}. Ничего не подставлено.">спорно</span>`;
    }
    return "";
  }
  const fields = (m.specFields || []).join(", ");
  const n = m.specSources || 0;
  return `<span class="tag cat" title="Заполнено из каталога models.dev по ${n} источник(ам): ${esc(fields)}. Это данные других шлюзов, у твоего провайдера может отличаться. Цены не переносятся.">из каталога</span>`;
}

function renderDiscoverList() {
  const q = state.discoverSearch;
  const filters = state.discoverFilters;
  const list = state.discoverModels.filter((m) => {
    if (q && !m.id.toLowerCase().includes(q) && !String(m.name || "").toLowerCase().includes(q)) return false;
    if (filters.has("free") && !m.free) return false;
    if (filters.has("vision") && !(m.vision || (m.inputTypes || []).includes("image"))) return false;
    if (filters.has("reasoning") && !m.reasoning) return false;
    return true;
  });
  const el = $("#discoverList");
  if (!list.length) {
    el.innerHTML = `<div class="discover-empty">Ничего не найдено. Поменяй фильтры/поиск.</div>`;
    updateDiscoverCount();
    return;
  }
  el.innerHTML = list.map((m) => pickableModelRow(m, state.discoverSelected.has(m.id))).join("");
  el.querySelectorAll(".dmodel").forEach((row) => row.addEventListener("click", () => {
    const id = row.dataset.id;
    if (state.discoverSelected.has(id)) state.discoverSelected.delete(id);
    else state.discoverSelected.add(id);
    renderDiscoverList();
  }));
  updateDiscoverCount();
}

function updateDiscoverCount() {
  $("#discoverAdd").textContent = `Добавить выбранные (${state.discoverSelected.size})`;
}

/**
 * Turn a model as returned by /api/discover into a config entry.
 *
 * Shared by the discovery dialog and the wizard: both pick from the same
 * endpoint, so both must keep the same fields. They used to build this object
 * separately and the wizard's copy silently dropped the price — it showed a
 * cost column and a "free only" filter, then wrote a config with no cost in it.
 */
function modelFromDiscovered(src) {
  return {
    id: src.id,
    name: src.name || src.id,
    contextWindow: src.contextWindow || 0,
    maxOutput: src.maxOutput || 0,
    inputTypes: src.inputTypes || ["text"],
    outputTypes: ["text"],
    reasoning: !!src.reasoning,
    toolUse: src.toolUse !== false,
    // The provider told us what this costs; dropping it on the floor means
    // opencode cannot show spend for a model we had the price of. Only
    // carried when actually known — an unknown price must not become 0,
    // which would read as "free".
    ...(src.costInput != null && src.costOutput != null
      ? { costInput: src.costInput, costOutput: src.costOutput }
      : {}),
    ...(src.costCacheRead != null ? { costCacheRead: src.costCacheRead } : {}),
    ...(src.costCacheWrite != null ? { costCacheWrite: src.costCacheWrite } : {}),
  };
}

function addDiscovered() {
  if (!state.discoverSelected.size) { closeDiscover(); return; }
  for (const id of state.discoverSelected) {
    const src = state.discoverModels.find((m) => m.id === id);
    if (!src) continue;
    if (!state.models.some((e) => e.id === id)) state.models.push(modelFromDiscovered(src));
  }
  closeDiscover();
  renderModelList();
  toast(`Добавлено моделей: ${state.discoverSelected.size}`, "ok");
}

function closeDiscover() { $("#discoverBackdrop").hidden = true; }

/* --- Setup wizard --------------------------------------------------------
 * Four steps: pick a preset, enter the key, pick models, review and write.
 * It deliberately ends in the same preview -> confirm -> apply path as the main
 * form rather than writing directly, so a beginner still sees the diff before
 * anything touches the file.
 */

const WIZ_LAST = 3;

function openWizard() {
  state.wizardStep = 0;
  state.wizardPreset = null;
  state.wizModels = [];
  state.wizSelected = new Set();
  state.wizSearch = "";
  // Reset the filter too: a sticky "free only" from a previous run would hide
  // most of the list on the next provider with no visible reason why.
  state.wizFreeOnly = false;
  $("#wizFreeOnly").classList.remove("on");
  $("#wiz-name").value = "";
  $("#wiz-baseurl").value = "";
  $("#wiz-apikey").value = "";
  $("#wiz-apikey").type = "password";
  $("#wiz-envname").value = "";
  $("#wiz-env").checked = true;
  $("#wiz-search").value = "";
  $("#wizEnvState").hidden = true;
  renderPresetGrid();
  $("#wizardBackdrop").hidden = false;
  showWizardStep(0);
}

function closeWizard() { $("#wizardBackdrop").hidden = true; }

/**
 * One-line summary of what a provider gives away, with the date it was checked.
 *
 * The date is not decoration. Free tiers are withdrawn quietly — Cerebras
 * dropped its always-free tier and GitHub Models started answering 410 while
 * both were still listed as free elsewhere — so a number with no date behind it
 * invites the user to plan around something that may no longer exist.
 */
/**
 * Drops the "https://" every preset URL starts with.
 *
 * The prefix is 8 identical characters on every card and pushed the part that
 * differs out of view: "https://generativelanguage.goo…" told the user nothing
 * the card title had not already said. The full URL stays in the tooltip.
 */
function shortURL(u) {
  return String(u || "").replace(/^https:\/\//, "");
}

function freeTierNote(p) {
  const f = p && p.freeTier;
  if (!f || !f.summary) return "";
  const details = (f.limits || []).map((l) => "\u2022 " + l).join("\n");
  const when = f.checked ? `\n\nПроверено: ${f.checked}` : "";
  const src = f.source ? `\nИсточник: ${f.source}` : "";
  return `<div class="pfree" title="${esc(details + when + src)}">${esc(f.summary)}</div>`;
}

function renderPresetGrid() {
  const grid = $("#presetGrid");
  const chosen = state.wizardPreset;
  grid.innerHTML = state.presets.map((p) => `
    <button type="button" class="preset-card ${chosen && chosen.id === p.id ? "on" : ""}" data-id="${esc(p.id)}">
      <div class="pname">${esc(p.label)}
        ${p.local ? `<span class="tag local">локально</span>` : ""}
        ${p.needsKey === false && !p.local ? `<span class="tag">без ключа</span>` : ""}
      </div>
      <div class="phint">${esc(p.hint || "")}</div>
      ${p.baseURL ? `<div class="purl" title="${esc(p.baseURL)}">${esc(shortURL(p.baseURL))}</div>` : ""}
      ${freeTierNote(p)}
    </button>`).join("");
  grid.onclick = (e) => {
    const card = e.target.closest(".preset-card");
    if (!card) return;
    selectPreset(card.dataset.id);
  };
}

function selectPreset(id) {
  const p = state.presets.find((x) => x.id === id);
  if (!p) return;
  state.wizardPreset = p;
  $("#wiz-name").value = p.id === "custom" ? "" : p.label;
  $("#wiz-baseurl").value = p.baseURL || "";
  // A local server ignores credentials, so defaulting to env-var mode would ask
  // the user to create a variable that nothing ever reads.
  const wantsKey = p.needsKey !== false;
  $("#wiz-env").checked = wantsKey;
  $("#wiz-envname").value = wantsKey ? (p.envVarName || suggestEnvName(p.label)) : "";
  renderPresetGrid();
  showWizardStep(1);
}

function showWizardStep(n) {
  state.wizardStep = Math.max(0, Math.min(WIZ_LAST, n));
  const step = state.wizardStep;
  for (let i = 0; i <= WIZ_LAST; i++) $(`#wizPane${i}`).hidden = i !== step;
  $$("#wizSteps li").forEach((li) => {
    const i = Number(li.dataset.step);
    li.classList.toggle("on", i === step);
    li.classList.toggle("done", i < step);
  });
  $("#wizBack").disabled = step === 0;
  // Step 0 advances by clicking a preset, so a "Далее" button there would be a
  // dead control.
  $("#wizNext").hidden = step === 0;
  $("#wizNext").textContent = step === WIZ_LAST ? "Показать diff и записать" : "Далее";

  const p = state.wizardPreset;
  if (step === 1 && p) {
    $("#wizKeyLead").textContent = p.needsKey === false
      ? "Этому провайдеру ключ не нужен — он работает локально. Проверь адрес и иди дальше."
      : "Вставь API-ключ. По умолчанию он не попадёт в конфиг: туда запишется ссылка на переменную окружения.";
    $("#wizKeyNote").textContent = p.keyURL ? `Где взять ключ: ${p.keyURL}` : "";
    syncWizEnvField();
  }
  if (step === 2) loadWizardModels();
  if (step === 3) renderWizardSummary();
  $("#wizHint").textContent = step === WIZ_LAST ? "Следующий шаг покажет точный diff файла." : "";
}

function syncWizEnvField() {
  const on = $("#wiz-env").checked;
  $("#wizEnvField").hidden = !on;
  if (!on) { $("#wizEnvState").hidden = true; return; }
  clearTimeout(window._wizEnvTimer);
  window._wizEnvTimer = setTimeout(async () => {
    const name = $("#wiz-envname").value.trim();
    const el = $("#wizEnvState");
    if (!name) { el.hidden = true; return; }
    const r = await envVarStatus(name);
    el.hidden = false;
    if (!r) { el.className = "env-state is-unset"; el.textContent = "\u26a0 не удалось проверить переменную"; return; }
    if (r.set) {
      const inherited = asArray(r.scopes).includes("process");
      el.className = inherited ? "env-state is-set" : "env-state is-warn";
      el.textContent = `${inherited ? "\u2713" : "\u26a0"} ${name} уже задана (${r.length} симв.)`;
      el.title = r.note || "";
    } else {
      el.className = "env-state is-unset";
      // Offer to do it rather than printing a command to copy: the paste step is
      // where the setup usually stalls, and the key is already in the form.
      el.innerHTML = `\u26a0 переменная ещё не задана \u2014 без неё opencode отправит пустой ключ.
        <button class="btn btn-mini" id="wizSetEnvBtn" type="button">Задать сейчас</button>
        <span class="setx">setx ${esc(name)} "твой-ключ"</span>`;
      const b = $("#wizSetEnvBtn");
      if (b) b.onclick = () => setEnvFromField(name, $("#wiz-apikey").value, el);
    }
  }, 300);
}

/**
 * Writes the variable using the key already typed into the form.
 *
 * The value is sent once and never echoed back; the response only reports
 * length and scope.
 */
async function setEnvFromField(name, value, el, btnSel = "#wizSetEnvBtn") {
  const key = String(value || "").trim();
  if (!key) {
    toast("Сначала вставь ключ в поле выше \u2014 иначе задавать нечего", "err");
    return;
  }
  const btn = $(btnSel);
  if (btn) setBtnLoading(btn, true);
  const r = await api("/api/setenv", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, value: key }),
  });
  if (btn) setBtnLoading(btn, false);
  if (r && r.ok) {
    el.className = "env-state is-set";
    el.textContent = `\u2713 ${name} задана (${r.length} симв.)`;
    el.title = r.note || "";
    toast(`Переменная ${name} задана. opencode запускай из нового окна терминала.`, "ok");
  } else {
    // On non-Windows the server hands back the line to add to a shell profile.
    const cmd = r && r.command ? `<span class="setx">${esc(r.command)}</span>` : "";
    el.className = "env-state is-unset";
    el.innerHTML = `\u26a0 ${esc((r && r.error) || "не удалось задать переменную")} ${cmd}`;
    toast((r && r.error) || "Не удалось задать переменную", "err");
  }
}

// Builds the provider object the wizard has collected so far. Shared by the
// model step (which needs the key to call /models) and the summary.
function wizardProvider() {
  const useEnv = $("#wiz-env").checked;
  const name = $("#wiz-name").value.trim();
  return {
    id: Date.now(),
    name,
    baseURL: $("#wiz-baseurl").value.trim(),
    apiKey: $("#wiz-apikey").value.trim(),
    apiFormat: (state.wizardPreset && state.wizardPreset.apiFormat) || detectFormatFromURL($("#wiz-baseurl").value) || "openai-chat",
    useEnvVar: useEnv,
    envVarName: useEnv ? ($("#wiz-envname").value.trim() || suggestEnvName(name)) : "",
    setAsDefault: true,
    models: [],
  };
}

async function loadWizardModels() {
  const st = $("#wizModelStatus");
  const list = $("#wizModelList");
  st.className = "discover-status";
  st.textContent = "Запрашиваю список моделей\u2026";
  list.innerHTML = `<div class="discover-empty">Загрузка\u2026</div>`;

  const r = await api("/api/discover", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: wizardProvider() }),
  });
  const res = r.result || {};
  if (!res.ok) {
    st.className = "discover-status err";
    st.textContent = `\u2715 ${res.message || "не удалось получить список"}`;
    // A failed listing is not a dead end: a preset may ship a catalogue, and
    // otherwise the user can still add models by hand in the main form.
    const seeded = asArray(state.wizardPreset && state.wizardPreset.models);
    state.wizModels = seeded;
    if (seeded.length) {
      state.wizSelected = new Set(seeded.map((m) => m.id));
      st.textContent += " — показан встроенный список.";
    }
    renderWizardModels();
    return;
  }
  st.className = "discover-status ok";
  st.textContent = `\u2713 ${res.message || ""}`;
  state.wizModels = asArray(res.models);
  // Nothing preselected: silently adding 300 OpenRouter models would bloat the
  // config and make the diff unreadable.
  state.wizSelected = new Set();
  renderWizardModels();
}

function renderWizardModels() {
  const q = state.wizSearch;
  let shown = q
    ? state.wizModels.filter((m) => String(m.id).toLowerCase().includes(q) || String(m.name || "").toLowerCase().includes(q))
    : state.wizModels;
  // "Free only" hides models whose price is merely unknown as well as paid
  // ones: the filter promises "costs nothing", and an unpriced model cannot
  // honour that promise.
  if (state.wizFreeOnly) shown = shown.filter((m) => m.free);
  const el = $("#wizModelList");
  if (!shown.length) {
    el.innerHTML = `<div class="discover-empty">${state.wizModels.length ? "Ничего не найдено." : "Список пуст — модели можно добавить вручную позже."}</div>`;
  } else {
    el.innerHTML = shown.map((m) => pickableModelRow(m, state.wizSelected.has(m.id))).join("");
    el.querySelectorAll(".dmodel").forEach((row) => row.addEventListener("click", () => {
      const id = row.dataset.id;
      if (state.wizSelected.has(id)) state.wizSelected.delete(id); else state.wizSelected.add(id);
      renderWizardModels();
    }));
  }
  const freeCount = state.wizModels.filter((m) => m.free).length;
  $("#wizHint").textContent = freeCount
    ? `Выбрано: ${state.wizSelected.size} \u00b7 бесплатных в списке: ${freeCount}`
    : `Выбрано: ${state.wizSelected.size}`;
}

function renderWizardSummary() {
  const p = wizardProvider();
  const models = [...state.wizSelected];
  const rows = [
    ["Провайдер", esc(p.name || "\u2014"), ""],
    ["Ключ в конфиге", esc(slugifyName(p.name) || "\u2014"), "mono"],
    ["Base URL", esc(p.baseURL || "\u2014"), "mono"],
    ["Формат API", esc(p.apiFormat), ""],
    ["Моделей выбрано", String(models.length), models.length ? "" : "warn"],
    ["Модель по умолчанию", esc(models[0] || "\u2014"), ""],
    p.useEnvVar
      ? ["API-ключ", `в конфиг попадёт {env:${esc(p.envVarName)}}, сам ключ не записывается`, ""]
      : ["API-ключ", "будет записан в конфиг открытым текстом", "warn"],
  ];
  // The live-fire check. Everything above only describes what will be written;
  // this is the only step that proves the provider actually answers, which is
  // the difference between "✓ Применено" and "it works".
  const firstModel = models[0] || "";
  $("#wizSummary").innerHTML = rows.map(([k, v, cls]) =>
    `<div class="srow"><span class="slabel">${esc(k)}</span><span class="sval ${cls}">${v}</span></div>`).join("")
    + `<div class="srow">
        <span class="slabel">Проверка боем</span>
        <span class="sval">
          <button class="btn btn-mini" id="wizChatTest" type="button" ${firstModel ? "" : "disabled"}>Отправить тестовый запрос</button>
          <span id="wizChatResult" class="chat-probe"></span>
        </span>
      </div>`;

  const btn = $("#wizChatTest");
  if (btn) {
    btn.onclick = async () => {
      const out = $("#wizChatResult");
      setBtnLoading(btn, true);
      out.className = "chat-probe";
      out.textContent = "проверяю\u2026";
      const r = await api("/api/testchat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: p, modelId: firstModel }),
      });
      setBtnLoading(btn, false);
      const res = (r && r.result) || {};
      out.className = "chat-probe " + (res.ok ? "is-ok" : "is-bad");
      out.textContent = res.message || (r && r.error) || "не удалось проверить";
    };
  }
}

// Hands the collected provider to the main form, then runs the normal
// preview -> confirm -> apply path so the wizard cannot bypass the diff.
function finishWizard() {
  const p = wizardProvider();
  if (!p.name) { showWizardStep(1); return toast("Укажи название провайдера", "err"); }
  if (!p.baseURL) { showWizardStep(1); return toast("Укажи Base URL", "err"); }
  if (!state.wizSelected.size) { showWizardStep(2); return toast("Выбери хотя бы одну модель", "err"); }

  state.models = [...state.wizSelected]
    .map((id) => modelFromDiscovered(state.wizModels.find((m) => m.id === id) || { id }));
  // A wizard run creates a provider, so nothing is being renamed.
  state.editingKey = "";
  $("#f-name").value = p.name;
  $("#f-baseurl").value = p.baseURL;
  $("#f-apikey").value = p.apiKey;
  $("#f-format").value = p.apiFormat;
  state.formatTouched = true;
  updateFormatNote();
  $("#f-envname").value = p.envVarName;
  $("#f-envname").dataset.touched = "1";
  setEnvMode(p.useEnvVar);
  $("#f-default").checked = true;
  renderModelList();
  $("#f-defaultmodel").value = state.models[0].id;
  state.dirty = true;

  closeWizard();
  preview();
}

/**
 * Three states, not two. A 401 means the endpoint answered, so the old boolean
 * `ok` rendered a rejected key as "✓ доступен" — technically true about the
 * server, useless to the user, and it hid the actual fault.
 */
function reachBadge(p) {
  // No baseURL of its own: the package decides where to go, so there is nothing
  // this tool can probe. Neither green nor red would be honest.
  if (p.reach === "unknown") return `<span class="muted-line">\u2014 не проверяется</span>`;
  // "Key missing" and "key refused" are different problems with different
  // fixes. Showing "ключ не принят" over a provider that never sent one blames
  // a credential that does not exist.
  if (p.reach === "up" && p.fault === "nokey") return `<span class="warn-line">\u26a0 нет ключа</span>`;
  if (p.reach === "up" && p.fault === "key") return `<span class="warn-line">\u26a0 ключ не принят</span>`;
  if (p.reach === "up" || (p.reach == null && p.ok)) {
    return `<span class="ok-line">\u2713 доступен${p.viaProxy ? " (прокси)" : ""}</span>`;
  }
  if (p.fault === "proxy") return `<span class="err-line">\u2715 прокси</span>`;
  return `<span class="err-line">\u2715 сервер недоступен</span>`;
}

/**
 * Orders the replacements offered for a broken default model.
 *
 * `reach === "up"` is not the same as "usable": a provider that answers 401 is
 * reachable and still cannot serve a single request. Ranking by reachability
 * alone offered a 401 provider ahead of two perfectly healthy ones, i.e. it
 * proposed swapping one broken default for another. Auth-broken providers stay
 * in the list, last and labelled, because the user may be about to fill that
 * key in — but they must never be the pre-selected first option.
 *
 * Exported on `window` so verify-ui can exercise the real function instead of
 * pattern-matching the source.
 */
function rankDefaultCandidates(providers) {
  const usable = asArray(providers).filter((p) => !p.isDefault && asArray(p.models).length);
  const healthy = usable.filter((p) => p.reach === "up" && !p.fault);
  const authBroken = usable.filter((p) => p.reach === "up" && (p.fault === "key" || p.fault === "nokey"));
  return { healthy, authBroken, alive: [...healthy, ...authBroken] };
}
if (typeof window !== "undefined") window.rankDefaultCandidates = rankDefaultCandidates;

async function diagnose() {
  setStatus("Проверяю\u2026", "");
  const r = await api("/api/diagnostics");
  // Kept for the copyable report: re-probing on every copy would burn quota
  // and take a minute on a dozen providers.
  state.lastDiag = r;
  const issues = asArray(r.issues);
  const providers = asArray(r.providers);
  // Feed the sidebar dots from the same probe results, so the list and the
  // panel can never disagree about who is up.
  state.health = {};
  for (const p of providers) {
    state.health[p.key] = { reach: p.reach, fault: p.fault, ok: p.ok };
  }
  renderProviderList();
  const el = $("#issues");
  el.hidden = false;
  syncSidePlaceholder();
  let html = `<div class="result-card"><h3>Диагностика</h3>`;
  html += `<div class="ok-line" style="color:var(--muted)">Модель по умолчанию: ${esc(r.model || "\u2014")}</div>`;
  html += `<div class="ok-line" style="color:var(--muted)">config: ${esc(r.path || "")}</div>`;

  if (r.proxy) html += `<div class="ok-line" style="color:var(--muted)">прокси: ${esc(r.proxy)}</div>`;

  html += `<div class="diag-sect">Провайдеры</div>`;
  if (!providers.length) html += `<div class="ok-line" style="color:var(--muted)">\u2014 нет провайдеров \u2014</div>`;
  for (const p of providers) {
    html += `<div class="diag-row">
      <span class="diag-name">${esc(p.key)}</span>
      ${p.isDefault ? `<span class="tag">по умолчанию</span>` : ""}
      <span class="diag-meta">${p.nModels} моделей</span>
      ${reachBadge(p)}
    </div>
    <div class="diag-sub muted">${esc(p.conn || "")} \u00b7 ${esc(p.baseURL || "\u2014")}</div>`;
  }

  // If the default model points at a provider that is down, offer the one-click
  // fix. Saying "your default is broken" without a way to fix it just leaves the
  // user to hand-edit the file, which is what this tool exists to avoid.
  const brokenDefault = providers.find((p) => p.isDefault && p.reach === "down");
  const { healthy, alive } = rankDefaultCandidates(providers);
  if (brokenDefault && alive.length) {
    const label = (p, m) => (p.fault
      ? `${p.key}/${m} — ${p.fault === "nokey" ? "нет ключа" : "ключ не принят"}`
      : `${p.key}/${m}`);
    const opts = alive.flatMap((p) => asArray(p.models).map((m) => ({ value: `${p.key}/${m}`, label: label(p, m) })));
    const warn = healthy.length
      ? ""
      : `<div class="warn-line">\u26a0 Здоровых провайдеров нет — у всех кандидатов проблема с ключом.</div>`;
    html += `<div class="diag-sect">Починить модель по умолчанию</div>
      <div class="diag-sub muted">Провайдер «${esc(brokenDefault.key)}» недоступен, а opencode стартует именно с него.</div>
      ${warn}
      <div class="diag-fix">
        <select id="diagModelPick">${opts.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("")}</select>
        <button class="btn" id="diagSetDefault" type="button">Сделать основной</button>
      </div>`;
  } else if (brokenDefault) {
    html += `<div class="diag-sect">Починить модель по умолчанию</div>
      <div class="diag-sub muted">Провайдер «${esc(brokenDefault.key)}» недоступен, но и живого провайдера с моделями в конфиге нет \u2014 замену выбрать не из чего.</div>`;
  }

  // Три действия, о которых просили: починить конфиг, сверить модели с живым
  // сервером и проверить сам инструмент. Автофикс и обновление моделей идут
  // через diff-подтверждение — как и любая другая запись в этом инструменте.
  html += `<div class="diag-sect">Действия</div>
    <div class="diag-fix">
      <button class="btn btn-mini" id="diagAutoFix" type="button">Исправить автоматически</button>
      <button class="btn btn-mini" id="diagRefreshModels" type="button">Обновить модели</button>
      <button class="btn btn-mini" id="diagSelfCheck" type="button">Самопроверка</button>
      <button class="btn btn-mini" id="diagCopyReport" type="button" title="Скопировать сводку в буфер — без ключей">Скопировать отчёт</button>
    </div>
    <div class="diag-fix">
      <label class="check-line"><input type="checkbox" id="diagPrune" /> удалять модели, которых больше нет на сервере</label>
    </div>
    <div class="diag-sub" id="diagActionStatus"></div>
    <div id="diagActionOut"></div>`;

  html += `<div class="diag-sect">Конфиг (${issues.length})</div>`;
  if (!issues.length) html += `<div class="ok-line">\u2713 Проблем не найдено</div>`;
  else html += issues.map((i) => `<div class="${i.severity === "error" ? "err-line" : "ok-line"}" style="color:var(--text)">${i.severity === "error" ? "\u2715" : "\u26a0"} ${esc(i.message)}</div>`).join("");

  html += `</div>`;
  el.innerHTML = html;

  const autoBtn = $("#diagAutoFix");
  if (autoBtn) autoBtn.onclick = () => doAutoFix();
  const refreshBtn = $("#diagRefreshModels");
  if (refreshBtn) refreshBtn.onclick = () => doRefreshModels();
  const selfBtn = $("#diagSelfCheck");
  if (selfBtn) selfBtn.onclick = () => doSelfCheck();
  const reportBtn = $("#diagCopyReport");
  if (reportBtn) reportBtn.onclick = () => copyDiagReport();

  const pick = $("#diagModelPick");
  const fixBtn = $("#diagSetDefault");
  if (pick && fixBtn) {
    fixBtn.onclick = async () => {
      const model = pick.value;
      if (!model) return;
      setBtnLoading(fixBtn, true);
      // The hash guards against overwriting a file edited elsewhere since we
      // read it, same as every other write path.
      const resp = await api("/api/set-default-model", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, configPath: state.configPath, hash: state.configHash }),
      });
      setBtnLoading(fixBtn, false);
      if (resp && resp.ok) {
        toast(`Модель по умолчанию: ${model}`, "ok");
        await refreshConfigState();
        refreshUndo();
        await diagnose(); // re-render so the badge and the tag move
      } else {
        toast((resp && resp.error) || "Не удалось сменить модель", "err");
      }
    };
  }

  // A reachable endpoint that refuses the key is still a broken setup: counting
  // only `!p.ok` reported "всё в порядке" for a config that cannot run.
  // `unknown` is not a fault: it means the provider was deliberately not
  // probed, so counting it would make a healthy config report problems.
  const badProvider = providers.some((p) =>
    p.reach === "down" || p.fault === "key" || p.fault === "nokey" || (p.reach == null && !p.ok));
  const hasErr = issues.some((i) => i.severity === "error") || badProvider;
  toast(hasErr ? "Диагностика: есть проблемы" : "Диагностика: всё в порядке", hasErr ? "err" : "ok");
}

/**
 * Автоисправление конфига: preview -> diff -> подтверждение -> запись.
 * Чинит только однозначное (мусорные поля, ключ не в том месте, $VAR,
 * неполные limit/cost, висячий default). Переменная окружения и пустой список
 * моделей остаются ручными шагами — о них пишет remaining.
 */
async function doAutoFix() {
  const st = $("#diagActionStatus");
  const out = $("#diagActionOut");
  if (st) st.textContent = "Считаю исправления…";
  if (out) out.innerHTML = "";
  const r = await api("/api/autofix-preview", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ configPath: state.configPath }),
  });
  if (!r || !r.ok) {
    if (st) st.textContent = "";
    return toast((r && r.error) || "Не удалось построить план исправлений", "err");
  }
  const fixes = asArray(r.fixes);
  const skipped = asArray(r.skipped);
  state.configHash = r.hash || state.configHash;
  if (!fixes.length) {
    if (st) st.textContent = "Исправлять нечего — конфиг уже в порядке.";
    if (out && skipped.length) {
      out.innerHTML = `<div class="diag-sub">Вручную: ${esc(skipped.map((s) => s.message).join("; "))}</div>`;
    }
    return;
  }
  if (st) st.textContent = `Найдено исправлений: ${fixes.length}${skipped.length ? `, вручную: ${skipped.length}` : ""}`;
  openDiff({
    title: "Автоисправление конфига",
    meta: `<div class="diff-path">${esc(r.path || "")}</div>
      <div class="diff-stat"><span class="plus">+${r.diff ? r.diff.added : 0}</span>
      <span class="minus">-${r.diff ? r.diff.removed : 0}</span></div>`,
    diff: r.diff,
    hint: fixes.slice(0, 6).map((f) => f.message).join("; ") + (fixes.length > 6 ? `… (+${fixes.length - 6})` : ""),
    confirmLabel: `Исправить (${fixes.length})`,
    onConfirm: async () => {
      closeDiff();
      const res = await api("/api/autofix-apply", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ configPath: state.configPath, hash: state.configHash }),
      });
      if (res && res.conflict) await refreshConfigState();
      if (!res || !res.ok) return toast((res && res.error) || "Не удалось применить исправления", "err");
      if (res.hash) state.configHash = res.hash;
      if (res.backupFile) setBackupInfo(`\u21bb Автобэкап: ${res.backupFile}`);
      refreshBackups();
      refreshUndo();
      toast(`Исправлено: ${(res.fixed || []).length}`, "ok");
      await diagnose();
    },
  });
}

/**
 * Обновление моделей: сверяет конфиг с живым /models каждого провайдера.
 * Сначала показывает план (что добавится/пропадёт), пишет только после
 * подтверждения. Существующие записи не перезаписываются.
 */
async function doRefreshModels() {
  const st = $("#diagActionStatus");
  const out = $("#diagActionOut");
  const prune = $("#diagPrune") ? $("#diagPrune").checked : false;
  if (st) st.textContent = "Опрашиваю серверы…";
  if (out) out.innerHTML = "";
  const r = await api("/api/refresh-models", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ configPath: state.configPath, prune }),
  });
  if (!r || !r.ok) {
    if (st) st.textContent = "";
    return toast((r && r.error) || "Не удалось обновить модели", "err");
  }
  state.configHash = r.hash || state.configHash;
  const rows = asArray(r.providers);
  if (!rows.length) {
    if (st) st.textContent = "В конфиге нет провайдеров для обновления.";
    return;
  }
  // План целиком — в память: фильтр «только бесплатные» применяется локально,
  // без повторного опроса серверов, а на запись уходит белый список id.
  state.refreshPlan = rows;
  renderRefreshPlan();
}

function refreshSelectedIds() {
  const freeOnly = $("#diagFreeOnly") ? $("#diagFreeOnly").checked : false;
  const ids = [];
  for (const p of asArray(state.refreshPlan)) {
    if (!p.ok) continue;
    for (const a of asArray(p.added)) {
      const id = typeof a === "string" ? a : a.id;
      const free = typeof a === "object" && !!a.free;
      if (id && (!freeOnly || free)) ids.push(id);
    }
  }
  return ids;
}

function renderRefreshPlan() {
  const st = $("#diagActionStatus");
  const out = $("#diagActionOut");
  const rows = asArray(state.refreshPlan);
  const prune = $("#diagPrune") ? $("#diagPrune").checked : false;
  const freeOnly = $("#diagFreeOnly") ? $("#diagFreeOnly").checked : false;
  const totalAdd = rows.reduce((n, p) => n + asArray(p.added).length, 0);
  const totalDel = prune ? rows.reduce((n, p) => n + (p.removedCount || asArray(p.removed).length), 0) : 0;
  const willApply = refreshSelectedIds().length;
  if (st) st.textContent = `Новых моделей: ${totalAdd}${freeOnly ? " (показаны к записи только бесплатные)" : ""}${prune ? `, пропавших: ${totalDel}` : ""}`;
  if (!out) return;
  const fmtAdded = (added) => {
    const list = asArray(added);
    if (!list.length) return "нового нет";
    return "+ " + list.slice(0, 8).map((a) => {
      const id = typeof a === "string" ? a : a.id;
      const free = typeof a === "object" && !!a.free;
      const dim = freeOnly && !free ? ` style="opacity:.45"` : "";
      return `<span${dim}>${esc(id)}${free ? ` <span class="tag free">free</span>` : ""}</span>`;
    }).join(", ") + (list.length > 8 ? `\u2026 (+${list.length - 8})` : "");
  };
  out.innerHTML = rows.map((p) => {
    const removed = prune ? asArray(p.removed) : [];
    const detail = p.ok
      ? `${fmtAdded(p.added)}`
        + `${removed.length ? `<br>− ${esc(removed.slice(0, 8).join(", "))}${removed.length > 8 ? `\u2026` : ""}` : ""}`
      : esc(p.message || "ошибка");
    return `<div class="diag-row"><span class="diag-name">${esc(p.key)}</span>`
      + `<span class="diag-meta">${p.ok ? `всего на сервере: ${p.total ?? "?"}` : "не опрошен"}</span></div>`
      + `<div class="diag-sub">${detail}</div>`;
  }).join("")
    + ((totalAdd || totalDel)
      ? `<div class="diag-fix">`
        + `<label class="check-line"><input type="checkbox" id="diagFreeOnly"${freeOnly ? " checked" : ""} /> только бесплатные</label>`
        + `<button class="btn btn-mini" id="diagRefreshApply" type="button">Применить (${willApply + totalDel})</button></div>`
      : "");
  const freeBox = $("#diagFreeOnly");
  if (freeBox) freeBox.onchange = () => renderRefreshPlan();
  const applyBtn = $("#diagRefreshApply");
  if (applyBtn) {
    applyBtn.onclick = async () => {
      setBtnLoading(applyBtn, true);
      try {
        const res = await api("/api/refresh-models", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            configPath: state.configPath, hash: state.configHash,
            prune: $("#diagPrune") ? $("#diagPrune").checked : false,
            apply: true, models: refreshSelectedIds(),
          }),
        });
        if (res && res.conflict) await refreshConfigState();
        if (!res || !res.ok) return toast((res && res.error) || "Не удалось записать модели", "err");
        if (res.hash) state.configHash = res.hash;
        if (res.backupFile) setBackupInfo(`\u21bb Автобэкап: ${res.backupFile}`);
        refreshBackups();
        refreshUndo();
        toast(res.noop ? "Модели уже актуальны" : "Список моделей обновлён. Перезапусти opencode.", "ok");
        await diagnose();
      } finally {
        setBtnLoading(applyBtn, false);
      }
    };
  }
}

/**
 * Самопроверка инструмента: Node, каталоги, конфиг, прокси, справочник.
 * Сеть здесь не приговор: недоступный models.dev — предупреждение, а не ошибка.
 */
async function doSelfCheck() {
  const st = $("#diagActionStatus");
  const out = $("#diagActionOut");
  if (st) st.textContent = "Проверяю сам инструмент…";
  if (out) out.innerHTML = "";
  const r = await api("/api/selfcheck" + "?configPath=" + encodeURIComponent(state.configPath || ""));
  if (!r || !r.ok) {
    if (st) st.textContent = "";
    return toast((r && r.error) || "Самопроверка не удалась", "err");
  }
  const list = asArray(r.checks);
  const bad = list.filter((c) => !c.ok && c.critical).length;
  if (st) st.textContent = bad ? `Самопроверка: проблем ${bad}` : "Самопроверка: всё в порядке";
  if (out) {
    out.innerHTML = `<div class="diag-sect">Самопроверка</div>` + list.map((c) =>
      `<div class="diag-row"><span class="diag-name">${esc(c.label)}</span>`
      + `${c.ok ? `<span class="ok-line">\u2713</span>` : `<span class="err-line">\u2715</span>`}</div>`
      + `<div class="diag-sub">${esc(c.message || "")}</div>`
    ).join("");
  }
  toast(bad ? "Самопроверка: есть проблемы" : "Самопроверка: всё в порядке", bad ? "err" : "ok");
}

/**
 * Daily freebies digest: what providers are giving away right now (promos,
 * trials, student plans) plus the service news that affect availability.
 * Read-only by design — a perk is a lead to check, not a button that spends.
 */
async function renderDigest(force) {
  const el = $("#issues");
  el.hidden = false;
  el.innerHTML = `<div class="result-card"><h3>Халява</h3><div class="ok-line" style="color:var(--muted)">Загружаю…</div></div>`;
  syncSidePlaceholder();
  const r = await api("/api/digest" + (force ? "?refresh=1" : ""));
  if (!r || (!r.ok && !asArray(r.perks).length && !asArray(r.news).length)) {
    el.innerHTML = `<div class="result-card"><h3>Халява</h3>`
      + `<div class="err-line">\u2715 ${esc((r && r.error) || "не удалось загрузить")}</div></div>`;
    return toast("Дайджест недоступен", "err");
  }
  const perks = asArray(r.perks);
  const news = asArray(r.news);
  const when = r.as_of ? `данные борда на ${esc(r.as_of)}` : "дата неизвестна";
  const stale = r.stale ? ` \u00b7 <span class="warn-line">кэш (сеть недоступна)</span>` : "";
  let html = `<div class="result-card"><h3>Халява</h3>`
    + `<div class="ok-line" style="color:var(--muted)">${when}${stale}</div>`
    + `<div class="diag-fix"><button class="btn btn-mini" id="digestRefresh" type="button">Обновить</button></div>`
    + `<div class="diag-sect">Раздают (${perks.length})</div>`;
  if (!perks.length) html += `<div class="ok-line" style="color:var(--muted)">\u2014 пусто \u2014</div>`;
  for (const p of perks) {
    const badge = p.status === "upcoming" ? "скоро" : p.status === "active" ? "идёт" : esc(p.status || "");
    html += `<div class="diag-row"><span class="diag-name">${esc(p.title || p.id || "?")}</span>`
      + `<span class="tag">${esc(badge)}</span></div>`
      + `<div class="diag-sub">${esc([p.provider, p.product].filter(Boolean).join(" · "))}`
      + `${p.window ? ` \u00b7 ${esc(p.window)}` : ""}</div>`
      + (p.summary ? `<div class="diag-sub">${esc(p.summary)}</div>` : "")
      + (p.claim ? `<div class="diag-sub">Как забрать: ${esc(p.claim)}</div>` : "")
      + (p.source ? `<div class="diag-sub"><a class="digest-link" href="${esc(p.source)}" target="_blank" rel="noopener">источник \u2197</a></div>` : "");
  }
  html += `<div class="diag-sect">Новости (${news.length})</div>`;
  if (!news.length) html += `<div class="ok-line" style="color:var(--muted)">\u2014 пусто \u2014</div>`;
  for (const n of news.slice(0, 12)) {
    html += `<div class="diag-row"><span class="diag-name">${esc(n.title || n.id || "?")}</span></div>`
      + `<div class="diag-sub">${esc([n.provider, n.product].filter(Boolean).join(" · "))}`
      + (n.source ? ` \u00b7 <a class="digest-link" href="${esc(n.source)}" target="_blank" rel="noopener">источник \u2197</a>` : "")
      + `</div>`;
  }
  html += `</div>`;
  el.innerHTML = html;
  const rb = $("#digestRefresh");
  if (rb) rb.onclick = async () => {
    setBtnLoading(rb, true);
    try { await renderDigest(true); } finally { setBtnLoading(rb, false); }
  };
}

/**
 * Strips anything that looks like a credential from a diagnostics report.
 *
 * The report is meant to be pasted into chats and issues, so this errs on the
 * side of masking: `sk-…` tokens, Bearer values and key-shaped fields. Env
 * references (`{env:FOO}`) are names, not secrets, and are kept — without them
 * the report cannot explain an env-missing fault.
 *
 * Exported on `window` so verify-ui can exercise the real function instead of
 * pattern-matching the source.
 */
function maskSecretsForReport(text) {
  const stash = [];
  const safe = String(text ?? "").replace(/\{env:[A-Za-z_][A-Za-z0-9_]*\}/g, (m) => {
    stash.push(m);
    return `\u0000${stash.length - 1}\u0000`;
  });
  // \u0000 is excluded from the value class: it marks the stashed {env:…}
  // placeholders above, and matching it would mask the stash itself.
  const masked = safe
    .replace(/sk-[A-Za-z0-9\-_]{8,}/g, "sk-****")
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/=]+/gi, "Bearer ****")
    .replace(/((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)([^"'\s,}\u0000]+)/gi, "$1****");
  return masked.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
}
if (typeof window !== "undefined") window.maskSecretsForReport = maskSecretsForReport;

/**
 * Copies the last diagnostics run as markdown. No new probe, no secrets: the
 * payload on screen never held a key, and provider error texts are masked on
 * top of that because a server may echo a credential back inside its message.
 */
async function copyDiagReport() {
  const d = state.lastDiag;
  if (!d) return toast("Сначала запусти диагностику", "err");
  const lines = [
    "# Provider Studio — отчёт диагностики",
    "",
    `Дата: ${new Date().toISOString()}`,
    `Конфиг: ${(d.path || "")}`,
    `Модель по умолчанию: ${(d.model || "—")}`,
  ];
  if (d.proxy) lines.push(`Прокси: ${d.proxy}`);
  lines.push("", "## Провайдеры");
  const providers = asArray(d.providers);
  if (!providers.length) lines.push("- нет провайдеров");
  for (const p of providers) {
    const state_ = p.reach === "unknown" ? "не проверяется"
      : p.reach === "up" && !p.fault ? "доступен"
      : `${p.reach || "?"}${p.fault ? ` (ошибка: ${p.fault})` : ""}`;
    lines.push(`- ${p.key}: моделей ${p.nModels ?? "?"} — ${state_} — ${p.conn || ""} [${p.baseURL || "—"}]`);
  }
  lines.push("", "## Конфиг");
  const issues = asArray(d.issues);
  if (!issues.length) lines.push("- проблем не найдено");
  for (const i of issues) lines.push(`- [${i.severity}] ${i.message}`);
  await navigator.clipboard.writeText(maskSecretsForReport(lines.join("\n")));
  toast("Отчёт скопирован (без секретов)", "ok");
}

init();