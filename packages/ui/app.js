"use strict";


function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "checked") node.checked = Boolean(value);
    // A textarea ignores the `value` attribute, so a form reopened on a saved provider showed an
    // empty box and its save wiped what was there (instructionsAppend, 2026-09-23).
    else if (key === "value" && tag === "textarea") node.value = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  for (const child of children || []) {
    if (child !== null && child !== undefined) node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

let toastTimer = null;
function toast(message, isError, raw) {
  const box = $("#toast");
  box.replaceChildren(el("div", { text: message }));
  if (raw) box.appendChild(el("div", { class: "toast-raw", text: raw }));
  box.classList.toggle("error", Boolean(isError));
  box.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove("show"), isError ? 6500 : 3200);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const raw = (body.errors || [body.error || body.raw || `HTTP ${res.status}`]).join("; ");
    const error = new Error(raw);
    error.body = body;
    error.status = res.status;
    throw error;
  }
  return body;
}

// The router writes `cli.models` to settings.json on this save (they only take effect there). If
// that write could not happen it says so here — a slot that silently does nothing is the bug this
// call used to be, so a failure must reach the screen rather than the router log.
async function configRequest(next) {
  const out = await api("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
  if (out && out.warning) toast(out.warning, true);
  return out;
}

// A save sends the whole config, so it starts from what the router holds now rather than the copy
// this screen loaded: the router writes config.json too (measured wires and effort ladders, hand
// edits), and a save built on an old copy put all of that back. Seen 2026-10-02: adding a provider
// restored three OpenCode ladders realigned five hours earlier, so the app's effort menus never narrowed.
async function latestConfig() {
  try { currentConfig = await api("/api/config"); } catch { /* the save that follows reports an unreachable router */ }
  return currentConfig;
}

function modelsOf(provider) {
  const value = (provider && provider.models) || [];
  return value.map((model) => typeof model === "string" ? { id: model, name: model } : model).filter((model) => model && model.id);
}
function labelOf(model) { return model.name || model.id; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function safeName(value) { return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "provider"; }
function uniqueName(name, providers) {
  const base = safeName(name);
  let value = base;
  let number = 2;
  while (providers[value]) value = `${base}-${number++}`;
  return value;
}
function groupedModels(config) {
  const groups = [];
  for (const [name, provider] of Object.entries(config.providers || {})) {
    // A native Claude provider becomes a mapping target only after the explicit account-pool opt-in.
    // API-key and legacy login providers remain OpenAI-ingress-only.
    if (provider.type === "anthropic" && !provider.accountPool) continue;
    let models = modelsOf(provider);
    if (!models.length && provider.type === "chatgpt") models = CHATGPT_MODELS;
    if (models.length) groups.push({ name, provider, models });
  }
  return groups;
}
function presetById(id) { return presets.find((preset) => preset.id === id); }
function modelEffortLevels(provider, model) {
  const entry = modelsOf(provider).find((item) => item.id === model);
  return entry && Array.isArray(entry.effortLevels) ? entry.effortLevels : undefined;
}
// The ChatGPT ladders the Codex catalogue reports (measured 2026-09-23): every model takes
// low..max, and only these add ultra. The live probe replaces this table when it can be reached.
const CHATGPT_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const CHATGPT_ULTRA_MODELS = new Set(["gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra", "gpt-6-sol"]);
function fallbackEffortLevels(provider, model) {
  if (!provider) return [];
  const explicit = modelEffortLevels(provider, model);
  if (explicit !== undefined) return explicit;
  if (provider.type === "chatgpt") return CHATGPT_ULTRA_MODELS.has(model) ? [...CHATGPT_EFFORT_LEVELS, "ultra"] : [...CHATGPT_EFFORT_LEVELS];
  // What the router's grok adapter sends a model the proxy's listing has not described.
  if (provider.type === "grok") return ["low", "medium", "high", "xhigh"];
  const preset = provider.preset && presetById(provider.preset);
  if (provider.type === "openai-compatible") return provider.caps && provider.caps.reasoning === "effort" && Array.isArray(provider.caps.effortLevels) ? provider.caps.effortLevels : [];
  return provider.caps && Array.isArray(provider.caps.effortLevels) ? provider.caps.effortLevels : (preset && preset.effortLevels) || [];
}
function effortLevelsFor(providerName, model) {
  const provider = currentConfig && currentConfig.providers && currentConfig.providers[providerName];
  const catalog = effortCatalog && effortCatalog.providers && effortCatalog.providers[providerName];
  if (catalog) return (catalog.models && catalog.models[model]) || catalog.default || [];
  return fallbackEffortLevels(provider, model);
}
function providerSupportsEffort(provider, model) {
  return fallbackEffortLevels(provider, model).length > 0;
}
function hasModelEffortData(provider) {
  return modelsOf(provider).some((model) => Array.isArray(model.effortLevels));
}
function modelEffortTag(model) {
  if (!Array.isArray(model.effortLevels)) return null;
  return model.effortLevels.length ? t("providers.modelEffort") : t("providers.modelNoEffort");
}
// Routed models do not share a context window, so each picker entry carries its own. What the user
// typed wins; otherwise whatever the vendor's /models reported (`context_length`); otherwise the
// global cli.autoCompactWindow fallback. This is the model's real window, not a compaction point.
function discoveredContextWindow(providerName, modelId) {
  const provider = currentConfig && currentConfig.providers && currentConfig.providers[providerName];
  const entry = provider && modelsOf(provider).find((item) => item.id === modelId);
  return entry && Number.isFinite(entry.contextWindow) ? entry.contextWindow : undefined;
}
function savedContextWindow(modelId) {
  const entry = ((currentConfig && currentConfig.cli && currentConfig.cli.extraModels) || []).find((item) => item.model === modelId);
  return entry && Number.isFinite(entry.contextWindow) ? entry.contextWindow : undefined;
}

let currentConfig = null;
let status = null;
let loadedUiRevision = null;
let claudeModels = FALLBACK_CLAUDE_MODELS;
let presets = FALLBACK_PRESETS;
let effortCatalog = null;
let slotsLoaded = false;
let providersLoaded = false;
let clientsLoaded = false;
let pickerBusy = false;
let probeStates = new Map();
let chatgptLoginBusy = false;
let chatgptLoginMessage = "";

function selectOption(value, text) { return el("option", { value }, [text]); }
function badge(kind, text) { return el("span", { class: `badge ${kind} dot`, text }, []); }
function hint(text) { return el("p", { class: "hint", text }, []); }
/** One row of an inset group: a label (and quieter lines under it) on the left, a value or control on the right. */
function cell(label, value, sub, extraClass) {
  const lines = (Array.isArray(sub) ? sub : [sub]).filter(Boolean).map((line) => typeof line === "string" ? el("span", { class: "cell-sub", text: line }) : line);
  return el("div", { class: `cell${extraClass ? ` ${extraClass}` : ""}` }, [
    el("div", { class: "cell-text" }, [typeof label === "string" ? el("span", { class: "cell-label", text: label }) : label, ...lines]),
    value ? el("div", { class: "cell-value" }, Array.isArray(value) ? value : [value]) : null,
  ]);
}
/** A titled group of rows with an optional note under it — the System Settings section shape. */
function section(title, rows, footer, action) {
  return el("section", { class: "section" }, [
    title || action ? el("div", { class: "section-head" }, [title ? el("h3", { class: "section-title", text: title }) : el("span"), action || null]) : null,
    el("div", { class: "group" }, rows.filter(Boolean)),
    ...(Array.isArray(footer) ? footer : [footer]).filter(Boolean).map((text) => el("p", { class: "group-footer", text })),
  ]);
}
const SVG_NS = "http://www.w3.org/2000/svg";
/** A small line icon; the paths are drawn in currentColor so the icon follows the text around it. */
function svgIcon(viewBox, paths, cls) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  if (cls) svg.setAttribute("class", cls);
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}
function chevronIcon() { return svgIcon("0 0 8 13", ["M1.5 1.5l5 5-5 5"], "chevron"); }

function showView(name) {
  for (const button of $all(".nav-btn")) button.classList.toggle("active", button.dataset.view === name);
  for (const view of $all(".view")) view.classList.toggle("active", view.id === `view-${name}`);
  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
  if (name === "slots" && !slotsLoaded) void loadSlots();
  if (name === "providers" && !providersLoaded) void loadProviders();
  if (name === "clients" && !clientsLoaded) void loadClients();
  if (name === "logs") queueMicrotask(() => void refreshRequests());
  // Read again on every visit: the bar's ⚙ panel saves the same settings.
  if (name === "mod") queueMicrotask(() => void loadMod());
}
for (const button of $all(".nav-btn")) button.addEventListener("click", () => showView(button.dataset.view));
window.addEventListener("hashchange", () => showView((location.hash || "#health").slice(1)));
showView((location.hash || "#health").slice(1) || "health");

// The sidebar carries one language menu and About another (the sidebar is a tab bar on a phone).
(function setupLanguage() {
  const lang = (typeof CURRENT_LANG !== "undefined" && CURRENT_LANG) || "en";
  for (const select of $all(".lang-select")) {
    for (const [code, name] of LANGUAGES) {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = name;
      option.selected = code === lang;
      select.append(option);
    }
    select.addEventListener("change", () => {
      try { localStorage.setItem("clauderipple_lang", select.value); } catch { /* unavailable */ }
      location.reload();
    });
  }
})();

async function loadCatalogs() {
  const [modelResult, presetResult, effortResult] = await Promise.allSettled([api("/api/claude-models"), api("/api/presets"), api("/api/effort-levels")]);
  if (modelResult.status === "fulfilled" && Array.isArray(modelResult.value.models) && modelResult.value.models.length) claudeModels = modelResult.value.models;
  if (presetResult.status === "fulfilled" && Array.isArray(presetResult.value.presets) && presetResult.value.presets.length) presets = presetResult.value.presets;
  if (effortResult.status === "fulfilled" && effortResult.value && effortResult.value.providers) effortCatalog = effortResult.value;
}

// ---- Status -------------------------------------------------------------------------

async function refreshHealth() {
  try {
    status = await api("/api/status");
  } catch (error) {
    $("#health-desktop").replaceChildren(cell(t("health.connection"), badge("bad", t("health.disconnected"))));
    return;
  }
  // Served files changed underneath an open window (e.g. after an update): reload, unless a form is open.
  if (status.uiRevision) {
    if (loadedUiRevision === null) loadedUiRevision = status.uiRevision;
    else if (loadedUiRevision !== status.uiRevision && $("#modal-backdrop").hidden) location.reload();
  }
  const desktop = $("#health-desktop");
  desktop.replaceChildren(cell(
    t("health.connection"),
    status.settings.pointsAtRouter ? badge("ok", t("health.connected")) : badge("bad", t("health.notConnected")),
    status.settings.pointsAtRouter ? t("health.connectedHelp") : t("health.notConnectedHelp"),
  ));
  $("#health-requests").replaceChildren(el("div", { class: "row" }, [el("span", { class: "k", text: t("health.requests") }), el("span", { class: "v", text: t("health.requestsFmt", Object.fromEntries(Object.entries(status.stats || {}).map(([key, value]) => [key, typeof value === "number" ? value.toLocaleString() : value]))) })]));
  renderHealthProviders();
  if (clientsLoaded) renderClients();
  if (modState.settings) renderModNotice();
  const details = $("#health-details");
  details.replaceChildren(
    versionRow(),
    // Which files answer, and since when: the only way to see that an update actually replaced the router.
    ...(status.runtime ? [cell(t("health.runtime"), null, [el("span", { class: "cell-sub mono", text: status.runtime.router || "?" }), new Date(status.runtime.startedAt).toLocaleString()])] : []),
    el("div", { class: "row" }, [el("span", { class: "k", text: t("health.routes") }), el("span", { class: "v", text: String(status.routes) })]),
    el("div", { class: "row" }, [el("span", { class: "k", text: t("health.cli") }), el("span", { class: "v", text: status.cliVersion })]),
  );
}

// The update check runs on a click, not with the 5-second refresh: it asks the npm registry. What an
// update means depends on how this copy was installed, so the router's CLI decides and runs it; the
// router restarts on the new version and the served-files check above reloads this page.
let updateState = { busy: false, check: null };
function versionRow() {
  const check = updateState.check;
  // The version reads as the row's label; what the update check found sits under it, the action on the right.
  let note = null;
  let button = null;
  if (check && check.newer && check.kind === "checkout") {
    note = t("update.checkout", { latest: check.latest });
  } else {
    const action = check && check.newer;
    const label = updateState.busy ? t("update.checking")
      : check && check.running ? t("update.running")
      : action ? (check.kind === "packaged" ? t("update.download", { latest: check.latest }) : t("update.install", { latest: check.latest }))
      : t("update.check");
    button = el("button", { class: action ? "btn" : "btn secondary", type: "button", text: label });
    button.disabled = updateState.busy || Boolean(check && check.running);
    button.addEventListener("click", () => void (action ? startUpdate() : checkForUpdate()));
    if (check && !check.newer && !updateState.busy) note = t("update.latest");
  }
  const row = cell(el("span", { class: "cell-label", text: `${t("health.version")} ${status.version}` }), button, note);
  row.id = "health-version-row";
  return row;
}
function renderVersionRow() {
  const row = $("#health-version-row");
  if (row) row.replaceWith(versionRow());
}
async function checkForUpdate() {
  updateState = { busy: true, check: updateState.check };
  renderVersionRow();
  try { updateState = { busy: false, check: await api("/api/update") }; }
  catch (error) { updateState = { busy: false, check: null }; toast(t("update.checkFailed"), true, error.message); }
  renderVersionRow();
}
async function startUpdate() {
  const check = updateState.check;
  if (check.kind === "packaged") { window.open("https://github.com/PBJ-2/clauderipple/releases/latest", "_blank", "noreferrer"); return; }
  if (!confirm(t("update.confirm", { latest: check.latest, current: check.current }))) return;
  updateState = { busy: true, check };
  renderVersionRow();
  try {
    await api("/api/update", { method: "POST" });
    updateState = { busy: false, check: { ...check, running: true } };
    toast(t("update.started"));
  } catch (error) {
    updateState = { busy: false, check };
    toast(t("update.failed"), true, error.message);
  }
  renderVersionRow();
}

function quotaLine(name) {
  const quota = status && status.chatgpt && status.chatgpt.quota && status.chatgpt.quota[name];
  const primary = quota && quota.rate_limits && quota.rate_limits.primary;
  if (!primary) return null;
  // The usage figure is what anyone acts on. The reset countdown was a second number beside it
  // that nobody does anything with, so it is left out.
  return t("health.quota", { percent: primary.used_percent, reset: "" });
}
/**
 * One line a person can read. Vendors answer with a JSON body and sometimes an escaped one inside
 * it; the useful part is the status and the vendor's own message, not the envelope around them.
 * The full text stays on the element's title.
 */
function shortError(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const status = raw.match(/\b(\d{3})\b/);
  let message = "";
  try {
    const json = raw.slice(raw.indexOf("{"));
    const parsed = JSON.parse(json);
    const err = parsed.error || parsed;
    message = String(err.message || err.error || "").trim();
  } catch { /* not JSON, or truncated: fall back to the raw head */ }
  if (!message) message = raw.replace(/\s+/g, " ").slice(0, 120);
  const head = status ? `HTTP ${status[1]}` : "";
  const line = [head, message].filter(Boolean).join(" · ");
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

/** How long a probe result speaks for the provider before the live reading takes over. */
const PROBE_TTL_MS = 90_000;
function probeIsStale(state) { return !state.pending && typeof state.at === "number" && Date.now() - state.at > PROBE_TTL_MS; }
function stateFor(name) { return probeStates.get(name); }
function chatgptLoginButton(onChange) {
  const button = el("button", { class: "btn secondary", type: "button", text: t("providers.chatgptLogin") });
  button.disabled = chatgptLoginBusy;
  button.addEventListener("click", () => void startChatgptLogin(onChange));
  return button;
}
/**
 * Runs the browser sign-in, which adds an account (or signs one in again). Finished is the sign-in
 * process ending, not "signed in": with an account already there, "signed in" is true from the start.
 */
async function startChatgptLogin(onChange, adding) {
  if (chatgptLoginBusy) return;
  chatgptLoginBusy = true;
  chatgptLoginMessage = adding ? t("providers.chatgptAddWaiting") : t("providers.chatgptLoginWaiting");
  onChange && onChange();
  try {
    await api("/api/chatgpt-login", { method: "POST" });
    const deadline = Date.now() + 6 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const login = await api("/api/chatgpt-login");
      if (login.running === false && login.ok === true) {
        toast(adding ? t("providers.chatgptAdded") : t("providers.chatgptLoginDone"));
        await refreshHealth();
        return;
      }
      if (login.running === false && login.ok === false) {
        toast(t("common.actionFailed"), true, login.output);
        return;
      }
    }
  } catch (error) {
    toast(t("common.actionFailed"), true, error.message);
  } finally {
    chatgptLoginBusy = false;
    chatgptLoginMessage = "";
    onChange && onChange();
  }
}
/**
 * Which of a provider's credentials are resting, and until when. Absent for a provider with one
 * credential: a row that can only ever say "ready" is noise. Ids and labels only — never a key.
 */
function credentialLine(name) {
  const pool = (status && status.credentials && status.credentials[name]) || [];
  if (!pool.length) return null;
  const parts = pool.map((c) => {
    const who = c.label || c.id;
    if (c.state === "quarantined") return `${who}: ${t("pool.quarantined")}`;
    if (c.state === "cooling") return `${who}: ${t("pool.cooling", { seconds: c.cooldownSeconds ?? 0 })}`;
    return `${who}: ${t("pool.ready")}`;
  });
  const resting = pool.filter((c) => c.state !== "ready").length;
  return el("div", { class: `small ${resting ? "bad-text" : ""}`.trim(), text: parts.join(" · ") });
}

/**
 * One verdict on a provider's connection, which the badge and the detail heading both show. They
 * used to decide separately: the heading kept a failure from a restart long after the badge had
 * healed, and both read a check still running as "disconnected" (Gemini, 2026-10-02).
 */
function providerConnection(name) {
  const live = status && status.providers && status.providers[name];
  // A successful TCP probe (or an older model probe) cannot undo a real billing refusal.
  if (live && live.exhaustion) return { level: "warn", text: `${live.exhaustion.reason.replace(/_/g, " ")} · ${new Date(live.exhaustion.until).toLocaleTimeString()}` };
  // Reaching the host is not the same as being able to use it. A ChatGPT provider with no
  // credentials would otherwise read "Connected" and send the user off believing it works.
  if (live && live.needsLogin) return { level: "warn", text: t("providerStatus.loginNeeded") };
  if (live && live.needsVerification) return { level: "warn", text: t("providers.googleVerifyNeeded") };
  const state = stateFor(name);
  if (state && state.pending) return { level: "warn", text: t("providerStatus.checking") };
  // A probe is the better evidence — it actually called the provider — but only while it is fresh.
  // One caught mid-restart used to sit there in red for the rest of the session, while the poll
  // every five seconds said the provider was fine and a fresh probe agreed. After PROBE_TTL_MS the
  // live reading takes over, so a stale failure heals itself instead of needing a manual re-check.
  if (state && !probeIsStale(state)) {
    if (state.ok) return { level: "ok", text: t("providerStatus.connected") };
    // The key was accepted and the plan refused: saying "check your key" sends the operator to the
    // one thing that is not wrong. Measured 2026-09-22 against OpenCode's free-tier 403.
    if (state.auth === "not-entitled") return { level: "bad", text: t("providerStatus.notEntitled") };
    if (state.auth === "bad-key") return { level: "bad", text: t("providerStatus.keyNeeded") };
    return { level: "bad", text: t("providerStatus.disconnected") };
  }
  if (live) return live.reachable ? { level: "ok", text: t("providerStatus.connected") } : { level: "bad", text: t("providerStatus.disconnected") };
  if (state) return { level: "bad", text: t("providerStatus.disconnected") };
  return { level: "warn", text: t("providerStatus.checking") };
}
function providerState(name) {
  const verdict = providerConnection(name);
  return badge(verdict.level, verdict.text);
}
function renderHealthProviders() {
  const box = $("#health-providers");
  const providers = Object.entries((currentConfig && currentConfig.providers) || (status && status.providers) || {});
  if (!providers.length) {
    box.replaceChildren(hint(t("health.noProviders")));
    return;
  }
  box.replaceChildren(...providers.map(([name, provider]) => {
    const live = status && status.providers && status.providers[name];
    const lines = [];
    const quota = quotaLine(name);
    if (quota) lines.push(el("span", { class: "cell-sub", text: quota }));
    // Claude subscription accounts, one line each: the current login and every account added here.
    // Before the config has loaded the rows come from the status, which names the sign-in source
    // rather than the auth mode.
    if (provider.type === "anthropic" && (provider.auth === "claude-code" || (live && live.authSource))) {
      const usage = ((status && status.claude && status.claude.accounts) || [])
        .map((account) => ({ account, text: chatgptQuotaText(account.quota) }))
        .filter(({ text }) => text)
        .map(({ account, text }) => el("div", { text: `${claudeAccountLabel(account)} · ${text}` }));
      if (usage.length) lines.push(el("div", { class: "cell-sub account-usage" }, usage));
    }
    const pool = credentialLine(name);
    if (pool) lines.push(pool);
    if (live && live.needsLogin && provider.type === "chatgpt") {
      lines.push(el("div", { class: "cell-actions" }, [
        chatgptLoginButton(() => renderHealthProviders()),
        chatgptLoginMessage ? el("span", { class: "small", text: chatgptLoginMessage }) : null,
      ]));
    }
    // The row opens the provider's own page; a button inside it keeps its own click.
    const row = cell(el("span", { class: "cell-label", text: name }), [providerState(name, provider), chevronIcon()], lines, "provider-status link");
    row.tabIndex = 0;
    const open = (event) => { if (!event.target.closest("button, a")) openProvider(name, provider); };
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => { if (event.key === "Enter" && event.target === row) open(event); });
    return row;
  }));
}

let statusModBusy = false;
let codexBusy = false;
function renderClients() {
  if (!currentConfig || !status) return;
  const picker = status.picker || { enabled: false, last: null };
  const last = picker.last || null;
  const names = status.pickerModels || [];
  // The switch rows are static markup, so a five-second refresh never takes keyboard focus off one;
  // only the rows after the switch are rebuilt.
  const pickerGroup = $("#client-picker-rows");
  while (pickerGroup.children.length > 1) pickerGroup.lastElementChild.remove();
  if (picker.enabled) {
    pickerGroup.append(
      el("div", { class: "cell-note", text: t("picker.models", { count: names.length, names: names.join(", ") || "—" }) }),
      el("div", { class: "cell-note", text: last && last.at ? t("picker.lastAt", { at: new Date(last.at).toLocaleString() }) : t("picker.never") }),
    );
  }
  const pickerSwitch = $("#client-picker-toggle");
  pickerSwitch.checked = Boolean(picker.enabled);
  pickerSwitch.disabled = pickerBusy;
  // Turning it on asks first (the OS trust prompt follows); a "no" puts the switch back.
  pickerSwitch.onchange = () => {
    if (!picker.enabled && !confirm(t("picker.confirmOn"))) { pickerSwitch.checked = false; return; }
    pickerSwitch.disabled = true;
    void togglePicker(!picker.enabled, true);
  };
  renderClientPickerModels(picker.enabled);
  renderModelSlots();
  const modEnabled = Boolean(status.statusMod);
  const modSwitch = $("#client-status-mod-toggle");
  modSwitch.checked = modEnabled;
  modSwitch.disabled = statusModBusy;
  modSwitch.onchange = () => { modSwitch.disabled = true; void toggleStatusMod(!modEnabled); };
  const toolsLimited = Boolean(currentConfig.cli && currentConfig.cli.limitWorkerTools);
  const toolsSwitch = $("#client-worker-tools-toggle");
  toolsSwitch.checked = toolsLimited;
  toolsSwitch.onchange = () => { toolsSwitch.disabled = true; void toggleWorkerTools(!toolsLimited).finally(() => { toolsSwitch.disabled = false; }); };
  void renderCodexClient();
  const groups = groupedModels(currentConfig);
  const mapped = Object.entries(currentConfig.routes || {}).map(([source, route]) => cell(
    labelOf(claudeModels.find((model) => model.id === source) || { id: source }),
    el("span", { text: labelOf((groups.find((group) => group.name === route.provider) || { models: [] }).models.find((model) => model.id === route.model) || { id: route.model }) }),
  ));
  $("#client-claude-code-rows").replaceChildren(...(mapped.length ? mapped : [el("div", { class: "cell-note", text: t("slots.noChanges") })]));
}
function renderClientPickerModels(enabled) {
  const card = $("#client-picker-models-card");
  card.hidden = !enabled;
  if (!enabled) return;
  const box = $("#client-picker-models");
  const checked = new Set(((currentConfig.cli && currentConfig.cli.extraModels) || []).map((item) => item.model));
  box.replaceChildren();
  for (const group of groupedModels(currentConfig)) for (const model of group.models) {
    const input = el("input", { type: "checkbox", checked: checked.has(model.id) });
    input.dataset.model = model.id;
    input.dataset.provider = group.name;
    input.dataset.name = labelOf(model);
    const discovered = discoveredContextWindow(group.name, model.id);
    const saved = savedContextWindow(model.id);
    // Blank means "use the global fallback"; the placeholder says what that would be.
    const windowField = el("input", {
      type: "number", class: "model-window", min: "1", step: "1000",
      value: saved !== undefined ? String(saved) : "",
      placeholder: discovered !== undefined ? String(discovered) : t("slots.windowGlobal"),
      title: t("slots.windowHelp"),
    });
    windowField.hidden = !input.checked;
    windowField.dataset.model = model.id;
    windowField.addEventListener("change", () => void saveClientPickerModels());
    input.addEventListener("change", () => { windowField.hidden = !input.checked; void saveClientPickerModels(); });
    // Two lines: the name owns the first — on one line it was the thing that collapsed, down to
    // "GPT…" — and the provider and the window share the second. The field sits outside the
    // <label>, because inside it every click toggles the checkbox instead of reaching the field.
    box.appendChild(el("div", { class: "picker-model", title: model.id }, [
      el("label", { class: "pm-main" }, [input, el("span", { text: labelOf(model) })]),
      el("small", { text: group.name }),
      windowField,
    ]));
  }
  if (!box.childElementCount) box.appendChild(hint(t("slots.noProviderModels")));
}
// Claude Code picks these before a request exists, so routing cannot reach them: a search, a title
// or a subagent goes wherever the CLI already decided. Left empty, Claude answers them — which is
// why a routed session still searches on Claude quota until `smallFast` is pointed somewhere.
const MODEL_SLOTS = ["smallFast", "subagent", "main"];

// A provider the router measured as unable to search. Only the router can know this — it comes from
// the status snapshot, never from the model's name — and the `smallFast` slot is exactly where it
// matters, because a search sent to such a model comes back as invented prose or a visible failure.
// A plan that searches on another of its endpoints does so for the models it names only.
function providerCannotSearch(name, model) {
  const entry = status && status.providers && status.providers[name];
  if (!entry || entry.webSearch === true) return false;
  const id = String(model || "").replace(/@[^@]*$/, "");
  return !(Array.isArray(entry.webSearchModels) && entry.webSearchModels.includes(id));
}

function renderModelSlots() {
  const rows = $("#client-model-slots");
  if (!rows) return;
  const chosen = (currentConfig.cli && currentConfig.cli.models) || {};
  rows.replaceChildren(...MODEL_SLOTS.map((slot) => {
    const select = el("select", {});
    select.appendChild(el("option", { value: "", text: t("slots.slotDefault") }));
    for (const group of groupedModels(currentConfig)) for (const model of group.models) {
      const option = el("option", { value: model.id, text: `${labelOf(model)} · ${group.name}` });
      if (chosen[slot] === model.id) option.selected = true;
      // `smallFast` is what a WebSearch runs on, so an inability to search is fatal there and
      // merely worth knowing everywhere else.
      if (slot === "smallFast" && providerCannotSearch(group.name, model.id)) {
        option.textContent += ` — ${t("slots.noWebSearch")}`;
      }
      select.appendChild(option);
    }
    // A model the config names but no provider offers any more would otherwise vanish silently.
    if (chosen[slot] && !allKnownModelIds(currentConfig).has(chosen[slot])) {
      const orphan = el("option", { value: chosen[slot], text: `${chosen[slot]} (?)` });
      orphan.selected = true;
      select.appendChild(orphan);
    }
    select.onchange = () => void saveModelSlots();
    select.dataset.slot = slot;
    select.setAttribute("aria-label", t(`slots.slot.${slot}`));
    return cell(t(`slots.slot.${slot}`), select, t(`slots.slotHelp.${slot}`), "slot-row");
  }));
}

async function saveModelSlots() {
  if (!currentConfig) return;
  const next = clone(await latestConfig());
  // Every slot is recorded, empty ones included. A select put back to "default (Claude)" has to
  // remove the env key, and the router tells "clear this" from "leave this alone" by whether the
  // slot is present at all — so dropping empty values here would make the choice a silent no-op.
  const models = {};
  for (const select of $all("#client-model-slots select")) models[select.dataset.slot] = select.value;
  next.cli = { ...(next.cli || {}), models };
  try {
    await configRequest(next);
    currentConfig = next;
    // Saying "saved" over a choice that will make every search fail is the same silent no-op this
    // screen was already guilty of once. The label on the option warns before the fact; this catches
    // a session that already had it selected.
    const owners = models.smallFast ? providersOffering(next, models.smallFast) : [];
    if (owners.length && providerCannotSearch(owners[0], models.smallFast)) toast(t("slots.noWebSearchWarn"), true);
    else toast(t("slots.slotSaved"));
  } catch (error) { toast(t("common.saveFailed"), true, error.message); }
}

function clientPickerSelections() {
  return $all("#client-picker-models input[type=checkbox]:checked").map((input) => {
    const field = $(`#client-picker-models input.model-window[data-model="${CSS.escape(input.dataset.model)}"]`);
    const typed = field && field.value.trim() ? Number(field.value) : NaN;
    const contextWindow = Number.isFinite(typed) && typed > 0 ? Math.floor(typed) : discoveredContextWindow(input.dataset.provider, input.dataset.model);
    return { id: input.dataset.model, name: input.dataset.name, provider: input.dataset.provider, contextWindow };
  });
}
async function saveClientPickerModels() {
  if (!currentConfig) return;
  const next = applyPickerSelections(clone(await latestConfig()), clientPickerSelections());
  try { await configRequest(next); currentConfig = next; toast(t("slots.saved")); } catch (error) { toast(t("common.saveFailed"), true, error.message); }
}
function pickerModeOn() {
  return Boolean(status && status.picker && status.picker.enabled);
}
// Ticking "show in the Claude app picker" only records which models to show; nothing appears until
// picker mode itself is on. Ask right after saving so the user is not left with a silent no-op
// (the box was ticked, picker mode stayed off, and the picker never changed — seen on Windows, 2026-09-14).
async function offerPickerOn(wanted) {
  if (!wanted || pickerModeOn()) return;
  if (!confirm(t("providers.pickerOffPrompt"))) return;
  await togglePicker(true, true);
}
async function togglePicker(enabled, confirmed = false) {
  if (pickerBusy) return;
  if (enabled && !confirmed && !confirm(t("picker.confirmOn"))) return;
  pickerBusy = true;
  $("#client-picker-msg").textContent = t("picker.working");
  try {
    await api("/api/picker", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
    toast(enabled ? t("picker.doneOn") : t("picker.doneOff"));
    if (currentConfig) currentConfig.picker = { ...(currentConfig.picker || {}), enabled };
  } catch (error) {
    toast(t("common.actionFailed"), true, error.message);
  } finally {
    pickerBusy = false;
    $("#client-picker-msg").textContent = "";
    void refreshHealth();
  }
}
async function toggleStatusMod(enabled) {
  if (statusModBusy) return;
  statusModBusy = true;
  try {
    await api("/api/status-mod", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
    toast(t("statusMod.saved"));
  } catch (error) {
    toast(t("common.actionFailed"), true, error.message);
  } finally {
    statusModBusy = false;
    void refreshHealth();
  }
}
async function toggleWorkerTools(enabled) {
  if (!currentConfig) return;
  const next = clone(await latestConfig());
  next.cli = { ...(next.cli || {}), limitWorkerTools: enabled };
  try {
    await configRequest(next);
    currentConfig = next;
    toast(t("common.saved"));
  } catch (error) { toast(t("common.saveFailed"), true, error.message); }
  renderClients();
}
async function renderCodexClient() {
  const path = $("#client-codex-rows");
  const toggle = $("#client-codex-toggle");
  try {
    const codex = await api("/api/codex");
    path.textContent = codex.configPath || "";
    path.classList.remove("bad-text");
    toggle.checked = Boolean(codex.enabled);
    toggle.disabled = codexBusy;
    toggle.onchange = () => { toggle.disabled = true; void toggleCodex(!codex.enabled); };
  } catch (error) {
    path.textContent = error.message;
    path.classList.add("bad-text");
    toggle.disabled = true;
  }
}
async function toggleCodex(enabled) {
  if (codexBusy) return;
  codexBusy = true;
  $("#client-codex-msg").textContent = t("picker.working");
  try { const result = await api("/api/codex", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) }); toast(t("common.saved"), false, result.output); }
  catch (error) { toast(t("common.actionFailed"), true, error.message); }
  finally { codexBusy = false; $("#client-codex-msg").textContent = ""; void renderCodexClient(); }
}
void Promise.all([loadCatalogs(), refreshHealth()]);
setInterval(refreshHealth, 5000);

// ---- Model links --------------------------------------------------------------------

function claudeSelect(selected) {
  const select = el("select", {});
  for (const model of claudeModels) select.appendChild(selectOption(model.id, labelOf(model)));
  select.value = selected || claudeModels[0].id;
  return select;
}
function targetSelect(route) {
  const select = el("select", {});
  select.appendChild(selectOption("", t("slots.passthrough")));
  for (const group of groupedModels(currentConfig)) {
    const optgroup = el("optgroup", { label: group.name });
    for (const model of group.models) optgroup.appendChild(selectOption(JSON.stringify([group.name, model.id]), labelOf(model)));
    select.appendChild(optgroup);
  }
  select.value = route ? JSON.stringify([route.provider, route.model]) : "";
  return select;
}
function effortSelect(value, levels) {
  const select = el("select", {});
  for (const effort of levels) select.appendChild(selectOption(effort, effort));
  select.value = levels.includes(value) ? value : (levels.includes("high") ? "high" : levels[0]);
  return select;
}
function routeFromTarget(value) {
  if (!value) return null;
  try {
    const [provider, model] = JSON.parse(value);
    return provider && model ? { provider, model } : null;
  } catch { return null; }
}
// One mapping per row: the Claude model, what answers it, and its effort. On a narrow window the
// three stack, so each carries its own small label (hidden where the column heads show).
function slotRow(id, route) {
  const row = el("div", { class: "map-row" });
  const source = claudeSelect(id);
  const target = targetSelect(route);
  source.setAttribute("aria-label", t("slots.th.claude"));
  target.setAttribute("aria-label", t("slots.th.target"));
  const initialTarget = routeFromTarget(target.value);
  const effort = effortSelect(route && route.effort, initialTarget ? effortLevelsFor(initialTarget.provider, initialTarget.model) : ["high"]);
  effort.setAttribute("aria-label", t("slots.th.effort"));
  const effortCell = el("div", { class: "map-col map-effort" }, [el("span", { class: "map-label", text: t("slots.th.effort") }), effort]);
  const remove = el("button", { class: "icon-btn remove", type: "button", title: t("common.remove"), "aria-label": t("common.remove"), onclick: () => { row.remove(); updateSlotSummary(); scheduleSlotsSave(); } }, [svgIcon("0 0 20 20", ["M10 2.8a7.2 7.2 0 1 0 0 14.4 7.2 7.2 0 0 0 0-14.4z", "M6.6 10h6.8"])]);
  function sync() {
    const selected = routeFromTarget(target.value);
    const levels = selected ? effortLevelsFor(selected.provider, selected.model) : [];
    const supported = levels.length > 0;
    const prior = effort.value;
    effort.replaceChildren(...levels.map((level) => selectOption(level, level)));
    if (supported) effort.value = levels.includes(prior) ? prior : (levels.includes("high") ? "high" : levels[0]);
    effort.disabled = !supported;
    effortCell.classList.toggle("muted-cell", !supported);
    if (!supported) {
      effortCell.dataset.empty = t("common.notAvailable");
      effortCell.title = t("slots.noEffort");
    } else {
      delete effortCell.dataset.empty;
      effortCell.removeAttribute("title");
    }
    updateSlotSummary();
  }
  target.addEventListener("change", () => { sync(); scheduleSlotsSave(); });
  source.addEventListener("change", () => { updateSlotSummary(); scheduleSlotsSave(); });
  effort.addEventListener("change", scheduleSlotsSave);
  row.append(
    el("div", { class: "map-col map-source" }, [el("span", { class: "map-label", text: t("slots.th.claude") }), source]),
    el("span", { class: "map-arrow", "aria-hidden": "true", text: "→" }),
    el("div", { class: "map-col map-target" }, [el("span", { class: "map-label", text: t("slots.th.target") }), target]),
    effortCell,
    el("div", { class: "map-remove" }, [remove]),
  );
  row._get = () => ({ id: source.value, route: routeFromTarget(target.value), effort: effort.value });
  sync();
  return row;
}
async function loadSlots() {
  slotsLoaded = true;
  try {
    await loadCatalogs();
    currentConfig = await api("/api/config");
    const rows = $("#slots-list");
    rows.replaceChildren();
    const routes = currentConfig.routes || {};
    const ids = [...claudeModels.map((model) => model.id), ...Object.keys(routes).filter((id) => !claudeModels.some((model) => model.id === id))];
    for (const id of ids) rows.appendChild(slotRow(id, routes[id]));
    updateSlotSummary();
  } catch (error) {
    toast(t("common.loadFailed"), true, error.message);
  }
}
$("#slots-add").addEventListener("click", () => {
  if (!currentConfig) return;
  $("#slots-list").appendChild(slotRow(claudeModels[0].id, null));
  updateSlotSummary();
});
function allKnownModelIds(config) { return new Set(groupedModels(config).flatMap((group) => group.models.map((model) => model.id))); }
// Which providers carry this exact id. One is what lets the router route it with no rule at all;
// two is the ambiguity it refuses to guess through, and the only case a rule is still needed.
function providersOffering(config, id) { return groupedModels(config).filter((group) => group.models.some((model) => model.id === id)).map((group) => group.name); }
// Whose entry this is. A `direct` rule used to answer it, but since 2026-09-19 a model routes by
// the provider that declares it and most models have no rule at all — so the answer is the
// providers, with the rule kept only for the ambiguity they cannot settle: two offering one id.
function pickerOwner(config, id) {
  const offering = providersOffering(config, id);
  if (offering.length < 2) return offering[0];
  const rule = (config.direct || []).filter((entry) => id.startsWith(entry.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
  return rule && offering.includes(rule.provider) ? rule.provider : offering[0];
}
/**
 * The picker entries belonging to every provider but the one being saved — the ones no checkbox on
 * this form can speak for, and which the rebuild must therefore be told to keep.
 *
 * Asking `direct` who owned them dropped all of them: the rules stopped being written in 2026-09-19
 * and only the legacy `gpt-` prefix still matched anything, so one save of any provider emptied the
 * picker of every non-GPT model (measured 2026-09-22 — deepseek and five more went that way).
 */
function pickerSelectionsExcept(config, providerName) {
  return ((config.cli && config.cli.extraModels) || [])
    .filter((entry) => entry.model !== null && entry.model !== undefined)
    // The window is part of the entry; rebuilding without it reset every other provider's.
    .map((entry) => ({ id: entry.model, name: entry.name, contextWindow: entry.contextWindow, provider: pickerOwner(config, entry.model) }))
    .filter((entry) => entry.provider && entry.provider !== providerName);
}
function applyPickerSelections(next, selections) {
  const known = allKnownModelIds(next);
  // An entry no provider offers any more has no checkbox — the list is built from the providers —
  // so keeping it here left removed models in the app picker forever, twice over once the same id
  // had been written twice. Orphans go, the rest is deduplicated by model id, and the direct rules
  // that served only an orphan go with it. A prefix rule that is not a model id (the legacy gpt-
  // one) is not an orphan and stays.
  const currentExtras = (next.cli && next.cli.extraModels) || [];
  const orphans = new Set(currentExtras.filter((entry) => entry.model && !known.has(entry.model)).map((entry) => entry.model));
  const selected = selections.filter((entry) => entry.id && entry.provider && known.has(entry.id));
  const extras = new Map();
  const direct = new Map();
  for (const entry of selected) {
    // Without this the rebuild would drop the window on every checkbox click.
    extras.set(entry.id, { model: entry.id, name: entry.name || entry.id, ...(Number.isFinite(entry.contextWindow) && entry.contextWindow > 0 ? { contextWindow: entry.contextWindow } : {}) });
    // A rule per ticked model is no longer what makes it route: since 2026-09-19 the router sends a
    // model to the one provider whose own `models` list carries it (routing.ts, "declared models").
    // Writing one anyway restated the same fact in a second place and piled up — one config reached
    // eighteen. It is still written for the case the router deliberately refuses to guess: an id
    // that MORE THAN ONE provider offers, where only the operator knows which deal is meant. Keep
    // this condition and the router's in step; the router is the one that decides.
    if (providersOffering(next, entry.id).length > 1) direct.set(entry.id, { prefix: entry.id, provider: entry.provider });
  }
  next.cli = { ...(next.cli || {}), extraModels: [...extras.values()] };
  // A rule survives when it is not a model id at all (the legacy `gpt-` prefix), or when it names an
  // id two providers offer, which the router will not resolve on its own. Dropping that second kind
  // because the model happens not to be ticked in the picker would stop it routing: the config here
  // has `deepseek-v4-pro` on a direct mapping and on OpenCode Go, and it is in no picker list.
  // An orphan goes either way — no provider offers it, and nothing in the interface can uncheck it.
  const preservedDirect = (next.direct || []).filter((rule) =>
    !orphans.has(rule.prefix) && (!known.has(rule.prefix) || providersOffering(next, rule.prefix).length > 1));
  const byPrefix = new Map(preservedDirect.map((rule) => [rule.prefix, rule]));
  for (const [prefix, rule] of direct) if (!byPrefix.has(prefix)) byPrefix.set(prefix, rule);
  next.direct = [...byPrefix.values()];
  // A legacy gpt- prefix rule is intentionally retained by the filter above.
  return next;
}
function updateSlotSummary() {
  const summaries = $all("#slots-list .map-row").map((row) => row._get()).filter((item) => item.route).slice(0, 3).map((item) => {
    const source = claudeModels.find((model) => model.id === item.id);
    const group = groupedModels(currentConfig).find((itemGroup) => itemGroup.name === item.route.provider);
    const target = group && group.models.find((model) => model.id === item.route.model);
    return `${labelOf(source || { id: item.id })} → ${labelOf(target || { id: item.route.model })}${effortLevelsFor(item.route.provider, item.route.model).length ? ` (${item.effort})` : ""}`;
  });
  $("#slots-summary").textContent = summaries.length ? summaries.join(" · ") : t("slots.noChanges");
}
// Changes save themselves (debounced); there is no Save button. `slotsStatus` shows saving/saved/error.
let slotsSaveTimer = null;
let slotsSaving = false;
function slotsStatus(text, isError) {
  const box = $("#slots-status");
  box.textContent = text;
  box.classList.toggle("bad-text", Boolean(isError));
}
function scheduleSlotsSave() {
  if (!currentConfig || !slotsLoaded) return;
  clearTimeout(slotsSaveTimer);
  slotsStatus(t("slots.saving"));
  slotsSaveTimer = setTimeout(() => void saveSlots(), 500);
}
async function saveSlots() {
  if (!currentConfig || slotsSaving) return;
  slotsSaving = true;
  const next = clone(await latestConfig());
  const routes = {};
  const seen = new Set();
  for (const row of $all("#slots-list .map-row")) {
    const item = row._get();
    if (seen.has(item.id)) { slotsStatus(t("slots.duplicate"), true); slotsSaving = false; return; }
    seen.add(item.id);
    if (item.route) routes[item.id] = { ...item.route, ...(effortLevelsFor(item.route.provider, item.route.model).length ? { effort: item.effort } : {}) };
  }
  next.routes = routes;
  try {
    await configRequest(next);
    currentConfig = next;
    slotsStatus(t("slots.saved"));
    updateSlotSummary();
  } catch (error) {
    slotsStatus(`${t("common.saveFailed")} ${error.message}`, true);
  } finally {
    slotsSaving = false;
  }
}

// ---- Providers ----------------------------------------------------------------------

async function probeProvider(name, provider, onComplete) {
  probeStates.set(name, { pending: true });
  renderHealthProviders();
  try {
    const headers = provider.headers || {};
    const body = provider.type === "anthropic"
      ? { type: "anthropic", auth: provider.auth, ...(provider.auth === "api-key" && provider.apiKey ? { apiKey: provider.apiKey } : {}) }
      : provider.type === "google"
      ? { type: "google", auth: provider.auth, ...(provider.apiKey ? { apiKey: provider.apiKey } : {}), ...(provider.url ? { url: provider.url } : {}) }
      : provider.type === "grok"
      ? { type: "grok", ...Object.fromEntries(["home", "cli", "url", "clientVersion"].filter((key) => provider[key]).map((key) => [key, provider[key]])) }
      : {
        type: provider.type,
        url: provider.url,
        headers,
        modelsUrl: provider.modelsUrl || (provider.preset && presetById(provider.preset) && presetById(provider.preset).modelsUrl),
        modelsAuthHeader: provider.modelsAuthHeader || (provider.preset && presetById(provider.preset) && presetById(provider.preset).modelsAuthHeader),
        // The router reads the preset's fallback list to tag each discovered model with the wire it
        // speaks, since /models reports ids alone and one plan can serve several wires.
        preset: provider.preset,
        // Without a preset the provider's own first model is the only id known to exist there.
        probeModel: provider.probeModel || (provider.preset && presetById(provider.preset) && (presetById(provider.preset).fallbackModels || [])[0] && presetById(provider.preset).fallbackModels[0].id) || (modelsOf(provider)[0] && modelsOf(provider)[0].id),
        // Some vendors refuse a request without it rather than merely losing the cache, so a test
        // that leaves it out reports a broken provider that works perfectly.
        sessionHeader: provider.sessionHeader || (provider.preset && presetById(provider.preset) && presetById(provider.preset).sessionHeader),
        wire: provider.wire,
      };
    const result = await api("/api/providers/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    probeStates.set(name, { ...result, at: Date.now() });
    onComplete && onComplete(result);
    return result;
  } catch (error) {
    const unavailable = error.status === 404;
    const result = { ok: false, auth: unavailable ? "unknown" : "unreachable", models: [], error: unavailable ? t("providers.apiSoon") : error.message, unavailable };
    probeStates.set(name, { ...result, at: Date.now() });
    onComplete && onComplete(result);
    return result;
  } finally {
    renderHealthProviders();
  }
}
// ---- Capability measurement ---------------------------------------------------------
//
// A model's wire and its effort ladder are measured by asking it, because a vendor's `/models`
// reports ids and nothing else. That takes several small requests per model, far too long to hold a
// save behind, so the save returns at once and this runs after it and settles the config when it
// finishes. Provider name → { state, done, total }, for the line the detail view shows meanwhile.
const measureStates = new Map();

/** What the operator wants to know from a finished job: what was settled, and what would not answer. */
function measureSummary(results) {
  const measured = results.filter((entry) => entry.wire);
  if (measured.length === 0) return "";
  const failed = results.length - measured.length;
  const parts = measured.map((entry) => `${entry.id} → ${entry.wire}${entry.effortLevels ? ` (${entry.effortLevels.length ? entry.effortLevels.join("/") : t("providers.effortNone")})` : ""}`);
  return failed > 0 ? `${parts.join(", ")} · +${failed}` : parts.join(", ");
}

/**
 * Measure the models of one provider, in the background, and show the config the result settled.
 *
 * Only models missing a wire or a ladder are sent: one the operator set is their decision, and the
 * router will not overwrite it either, so measuring it again would spend requests to change nothing.
 */
async function startMeasurement(providerName, provider) {
  if (!provider || (provider.type !== "openai-compatible" && provider.type !== "anthropic-compatible")) return;
  const models = modelsOf(provider).filter((model) => !model.wire || !model.effortLevels).map((model) => model.id);
  if (models.length === 0) return;
  let jobId;
  try {
    const started = await api("/api/providers/measure", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: providerName, models }),
    });
    jobId = started.jobId;
    measureStates.set(providerName, { state: "running", done: 0, total: started.total });
    renderProviderWorkspace();
  } catch { return; } // The router is older than this screen, or said no: the save itself stands.
  try {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const job = await api(`/api/providers/measure/${jobId}`);
      measureStates.set(providerName, { state: job.state, done: job.done, total: job.total });
      renderProviderWorkspace();
      if (job.state === "running") continue;
      measureStates.delete(providerName);
      if (job.state === "failed") { toast(t("measure.failed"), true, job.error); renderProviderWorkspace(); return; }
      const results = job.results || [];
      // A model the plan refuses is not merely unmeasured: no wire will ever answer for it, so
      // saying so once here is the only chance the operator gets before a session fails on it.
      // Measured 2026-09-22: OpenCode answers every `-free` model with 403 FreeTierError.
      const barred = results.filter((entry) => typeof entry.error === "string" && entry.error.startsWith("not-entitled"));
      if (barred.length > 0) toast(t("measure.notEntitled", { models: barred.map((entry) => entry.id).join(", ") }), true);
      const summary = measureSummary(results);
      // An auth failure is reported as itself: it says nothing about any model, and leaving it as
      // "nothing was measured" would send the operator looking at the wrong thing.
      const refused = results.some((entry) => entry.error === "auth");
      // The barred models already had their own line; do not also call the round a failure when
      // every other model measured fine.
      if (summary || barred.length === 0) toast(summary ? t("measure.done", { summary }) : refused ? t("measure.authFailed") : t("measure.nothing"), !summary);
      await loadProviders();
      return;
    }
  } catch (error) {
    measureStates.delete(providerName);
    toast(t("measure.failed"), true, error.message);
    renderProviderWorkspace();
  }
}

let selectedProviderName = null;
let providerDetailTab = "overview";
let providerSearch = "";
let providerDetailGeneration = 0;

function providerKind(name, provider) {
  const preset = provider.preset && presetById(provider.preset);
  if (provider.type === "chatgpt") return t("providers.chatgpt");
  if (provider.type === "google") return `${t("providers.google")} · ${provider.auth === "antigravity" ? t("providers.googleAntigravity") : t("providers.apiKey")}`;
  if (provider.type === "grok") return t("providers.grok");
  if (provider.type === "anthropic") return provider.auth === "claude-code"
    ? `${t("providers.anthropic")} · ${provider.accountPool ? t("providers.rotationOn") : t("providers.rotationOff")}`
    : `${t("providers.anthropic")} · ${t("providers.apiKey")}`;
  if (preset) return preset.name;
  try { return new URL(provider.url).host; } catch { return provider.type || name; }
}

function providerRailItem(name, provider) {
  const selected = name === selectedProviderName;
  const button = el("button", {
    class: `provider-rail-item${selected ? " selected" : ""}`,
    type: "button",
    role: "option",
    "aria-selected": String(selected),
  }, [
    el("span", { class: "provider-rail-copy" }, [
      el("strong", { text: name }),
      el("span", { text: t("providers.modelsCountShort", { count: modelsOf(provider).length }) }),
    ]),
    providerState(name, provider),
  ]);
  button.addEventListener("click", () => openProvider(name, provider));
  return button;
}

/**
 * Show one provider's page, from its list or from the Status screen. A narrow window shows the list
 * and the page one at a time (`show-detail`), so this is also the "push" to the page.
 */
function openProvider(name, provider) {
  selectedProviderName = name;
  providerDetailTab = provider.type === "anthropic" && provider.auth === "claude-code" ? "accounts" : "overview";
  $("#view-providers").classList.add("show-detail");
  if (!$("#view-providers").classList.contains("active")) showView("providers");
  if (currentConfig && currentConfig.providers && currentConfig.providers[name]) renderProviderWorkspace();
  window.scrollTo(0, 0);
}
function closeProviderDetail() {
  $("#view-providers").classList.remove("show-detail");
  window.scrollTo(0, 0);
}

function renderProviderRail() {
  const list = $("#providers-list");
  const entries = Object.entries((currentConfig && currentConfig.providers) || {});
  const query = providerSearch.trim().toLowerCase();
  const visible = entries.filter(([name, provider]) => !query || name.toLowerCase().includes(query) || providerKind(name, provider).toLowerCase().includes(query));
  list.replaceChildren(...visible.map(([name, provider]) => providerRailItem(name, provider)));
  if (!entries.length) list.appendChild(el("div", { class: "provider-rail-empty", text: t("providers.empty") }));
  else if (!visible.length) list.appendChild(el("div", { class: "provider-rail-empty", text: t("providers.noSelection") }));
}

async function removeProvider(name, provider) {
  if (!confirm(t("providers.removeConfirm", { name }))) return;
  const next = clone(await latestConfig());
  delete next.providers[name];
  next.routes = Object.fromEntries(Object.entries(next.routes || {}).filter(([, route]) => route.provider !== name));
  next.direct = (next.direct || []).filter((rule) => rule.provider !== name);
  next.cli.extraModels = (next.cli.extraModels || []).filter((entry) => !modelsOf(provider).some((model) => model.id === entry.model));
  try {
    await configRequest(next);
    currentConfig = next;
    selectedProviderName = Object.keys(next.providers)[0] || null;
    providerDetailTab = "overview";
    slotsLoaded = false;
    clientsLoaded = false;
    closeProviderDetail();
    renderProviderWorkspace();
    toast(t("common.saved"));
  } catch (error) { toast(t("common.saveFailed"), true, error.message); }
}

function providerTabs(name, provider) {
  const tabs = [{ id: "overview", label: t("providers.overview") }];
  if ((provider.type === "anthropic" && provider.auth === "claude-code") || provider.type === "chatgpt" || (provider.type === "google" && provider.auth === "antigravity")) tabs.push({ id: "accounts", label: t("providers.accounts") });
  tabs.push({ id: "models", label: t("providers.modelsTab") });
  return el("div", { class: "provider-tabs", role: "tablist" }, tabs.map((tab) => {
    const button = el("button", { class: providerDetailTab === tab.id ? "active" : "", type: "button", role: "tab", "aria-selected": String(providerDetailTab === tab.id), text: tab.label });
    button.addEventListener("click", () => { providerDetailTab = tab.id; renderProviderDetail(); });
    return button;
  }));
}

function providerOverview(name, provider) {
  const state = stateFor(name);
  const live = status && status.providers && status.providers[name];
  const connection = section(t("providers.connection"), [
    // The kind is already under the page title; this row is only the verdict and what to do about it.
    cell(t("health.connection"), providerState(name, provider), [
      state && !state.ok && state.error ? el("span", { class: "cell-sub bad-text", text: shortError(state.error), title: state.error }) : null,
      live && live.needsLogin && provider.type === "chatgpt" ? el("div", { class: "cell-actions" }, [chatgptLoginButton(renderProviderDetail)]) : null,
    ]),
  ]);
  const models = modelsOf(provider);
  const measuring = measureStates.get(name);
  const running = measuring && measuring.state === "running";
  // Names only, as one quiet line: the Models tab is where each one is listed and edited.
  const modelSummary = section(t("providers.selectedModels"), [
    models.length ? el("div", { class: "cell-note" }, [el("span", { class: "cell-label", text: models.map(labelOf).join(", ") })]) : el("div", { class: "cell-note", text: t("providers.noModels") }),
    running ? el("div", { class: "cell-note", text: t("measure.running", { done: measuring.done, total: measuring.total }) }) : null,
  ], running ? t("measure.help") : null);
  const quota = quotaLine(name);
  return el("div", { class: "provider-panel" }, [
    connection,
    quota ? section(null, [cell(t("providers.usage"), el("span", { text: quota }))]) : null,
    modelSummary,
  ]);
}

function providerModelsPanel(name, provider) {
  const models = modelsOf(provider);
  const edit = el("button", { class: "btn secondary compact", type: "button", text: t("common.edit"), onclick: () => openProviderForm({ name, provider }) });
  return el("div", { class: "provider-panel" }, [
    section(t("providers.selectedModels"), models.length
      ? models.map((model) => cell(labelOf(model), modelEffortTag(model) ? el("span", { class: `model-effort-tag ${model.effortLevels.length ? "has-effort" : "no-effort"}`, text: modelEffortTag(model) }) : null, el("span", { class: "cell-sub mono", text: model.id }), "provider-model-row"))
      : [el("div", { class: "cell-note", text: t("providers.noModels") })], t("providers.modelsHelp"), edit),
  ]);
}

async function saveAnthropicRotation(name, provider, enabled, control, message) {
  control.disabled = true;
  message.textContent = t("providers.rotationSaving");
  const next = clone(await latestConfig());
  if (enabled) next.providers[name].accountPool = true;
  else delete next.providers[name].accountPool;
  try {
    await configRequest(next);
    currentConfig = next;
    slotsLoaded = false;
    clientsLoaded = false;
    renderProviderWorkspace();
    toast(t("providers.rotationSaved"));
  } catch (error) {
    control.checked = !enabled;
    message.textContent = "";
    toast(t("common.saveFailed"), true, error.message);
  } finally { control.disabled = false; }
}

/** The current login is named by the router in English; everything else carries the user's own label. */
function claudeAccountLabel(account) {
  return account.id === "current" ? t("providers.anthropicCurrent") : account.label;
}

/** "5h 14% · weekly 10%" under a Claude account, or nothing while its usage is unknown. */
function claudeQuotaNode(account) {
  const text = chatgptQuotaText(account && account.quota);
  return text ? el("p", { class: "small account-quota", text }) : null;
}

/** "Use first" for an account the pool does not lead with; `null` hands first place back to the current login. */
function claudePreferButton(name, id, disabled) {
  const button = el("button", { class: "btn secondary compact", type: "button", text: t("providers.preferAction") });
  button.disabled = disabled;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await api("/api/claude-accounts", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ preferred: id }) }); await refreshClaudeAccountPanel(name); }
    catch (error) { button.disabled = false; toast(t("common.actionFailed"), true, error.message); }
  });
  return button;
}

function renderClaudeAccountRows(target, data, name, generation) {
  if (generation !== providerDetailGeneration) return;
  // Rows follow the order the router tries them in: the preferred account, else the current login, first.
  const stored = Array.isArray(data.accounts) ? [...data.accounts] : [];
  const preferredIndex = stored.findIndex((account) => account.preferred);
  if (preferredIndex > 0) stored.unshift(...stored.splice(preferredIndex, 1));
  const leader = preferredIndex >= 0 ? stored[0].id : data.current ? "current" : stored[0] && stored[0].id;
  const choosable = (data.current ? 1 : 0) + stored.length > 1;
  const firstBadge = (id) => (choosable && id === leader ? el("span", { class: "badge first", text: t("providers.preferBadge") }) : null);
  const rows = [];
  const currentRow = data.current ? el("article", { class: "cell account-card current" }, [
    el("div", { class: "cell-text account-card-copy" }, [
      el("strong", { text: data.current.label }), el("span", { class: "small", text: anthropicSourceText(data.current.source) }), claudeQuotaNode(data.current), hint(t("providers.currentAccountHelp")),
      choosable && leader !== "current" ? el("div", { class: "account-card-actions" }, [claudePreferButton(name, null, false)]) : null,
    ]),
    el("div", { class: "account-card-badges" }, [firstBadge("current"), el("span", { class: "badge ok", text: t("providers.anthropicCurrent") })]),
  ]) : null;
  if (currentRow && preferredIndex < 0) rows.push(currentRow);
  for (const account of stored) {
    const unavailable = account.needsReauth || account.expiresAt <= Date.now();
    const rename = el("button", { class: "btn secondary compact", type: "button", text: t("common.edit") });
    rename.addEventListener("click", async () => {
      const label = prompt(t("providers.anthropicRenamePrompt"), account.label);
      if (!label || !label.trim() || label.trim() === account.label) return;
      try { await api(`/api/claude-accounts/${encodeURIComponent(account.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ label }) }); await refreshClaudeAccountPanel(name); }
      catch (error) { toast(t("common.actionFailed"), true, error.message); }
    });
    const remove = el("button", { class: "btn danger compact", type: "button", text: t("common.remove") });
    remove.addEventListener("click", async () => {
      if (!confirm(t("providers.anthropicRemoveConfirm", { name: account.label }))) return;
      try { await api(`/api/claude-accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" }); await refreshClaudeAccountPanel(name); }
      catch (error) { toast(t("common.actionFailed"), true, error.message); }
    });
    const actions = [rename, remove];
    if (choosable && account.id !== leader) actions.unshift(claudePreferButton(name, account.id, unavailable));
    if (unavailable) {
      const reauth = el("button", { class: "btn secondary compact", type: "button", text: t("providers.reauthAction") });
      reauth.addEventListener("click", () => openClaudeAccountConsent(name));
      actions.unshift(reauth);
    }
    rows.push(el("article", { class: "cell account-card" }, [
      el("div", { class: "cell-text account-card-copy" }, [
        el("strong", { text: account.label }), account.email && account.email !== account.label ? el("span", { class: "small", text: account.email }) : null, claudeQuotaNode(account), hint(t("providers.addedAccountHelp")),
        el("div", { class: "account-card-actions" }, actions),
      ]),
      el("div", { class: "account-card-badges" }, [firstBadge(account.id), el("span", { class: `badge ${unavailable ? "bad" : "ok"}`, text: unavailable ? t("providers.anthropicReauth") : t("pool.ready") })]),
    ]));
    if (currentRow && rows.length === 1 && preferredIndex >= 0) rows.push(currentRow);
  }
  target.replaceChildren(...(rows.length ? rows : [el("div", { class: "account-empty", text: t("providers.anthropicNoAccounts") })]));
  const preferNote = $("#claude-account-prefer");
  if (preferNote) preferNote.hidden = !choosable;
  const count = (data.current ? 1 : 0) + stored.length;
  const countNode = $("#claude-account-count");
  if (countNode) countNode.textContent = t("providers.accountCount", { count });
}

async function refreshClaudeAccountPanel(name) {
  const target = $("#claude-account-rows");
  if (!target || selectedProviderName !== name || providerDetailTab !== "accounts") return;
  const generation = providerDetailGeneration;
  try { renderClaudeAccountRows(target, await api("/api/claude-accounts"), name, generation); }
  catch (error) { if (generation === providerDetailGeneration) target.replaceChildren(el("div", { class: "bad-text small", text: error.message })); }
}

function anthropicAccountsPanel(name, provider) {
  const rotation = el("input", { type: "checkbox", checked: Boolean(provider.accountPool) });
  const rotationMessage = el("span", { class: "small" });
  rotation.addEventListener("change", () => void saveAnthropicRotation(name, provider, rotation.checked, rotation, rotationMessage));
  const add = el("button", { class: "cell-button", type: "button", text: t("providers.addClaudeAccount") });
  add.addEventListener("click", () => openClaudeAccountConsent(name));
  const removeAll = el("button", { class: "cell-button destructive", type: "button", text: t("providers.anthropicLogoutAll") });
  removeAll.addEventListener("click", async () => {
    if (!confirm(t("providers.anthropicLogoutAllConfirm"))) return;
    try { await api("/api/claude-logout", { method: "POST" }); await refreshClaudeAccountPanel(name); }
    catch (error) { toast(t("common.actionFailed"), true, error.message); }
  });
  rotation.setAttribute("role", "switch");
  rotation.setAttribute("aria-label", t("providers.anthropicPool"));
  const rows = el("div", { id: "claude-account-rows", class: "group account-card-list" }, [el("div", { class: "small", text: t("providers.checking") })]);
  // The rotation switch first (it decides whether added accounts are used at all), then the
  // accounts with "Add" at the end of their list, then the one destructive act on its own.
  const panel = el("div", { class: "provider-panel" }, [
    el("section", { class: "section" }, [
      el("div", { class: "group" }, [cell(t("providers.anthropicPool"), el("label", { class: "switch" }, [rotation, el("span")]), [t("providers.accountPoolSubtitle"), rotationMessage])]),
      !provider.accountPool ? el("div", { class: "group-footer notice" }, [el("strong", { text: t("providers.rotationOff") }), el("span", { text: t("providers.rotationRequired") })]) : null,
    ]),
    el("section", { class: "section" }, [
      el("div", { class: "section-head" }, [el("h3", { class: "section-title", text: t("providers.accountPoolTitle") }), el("span", { id: "claude-account-count", class: "small", text: t("providers.accountCount", { count: 0 }) })]),
      rows,
      el("div", { class: "group stacked-add" }, [add]),
      el("p", { class: "group-footer", text: t("providers.accountCountHelp") }),
      el("p", { id: "claude-account-prefer", class: "group-footer", text: t("providers.preferHelp"), hidden: "" }),
    ]),
    section(t("providers.dangerZone"), [removeAll], t("providers.anthropicLogoutAllConfirm")),
  ]);
  queueMicrotask(() => void refreshClaudeAccountPanel(name));
  return panel;
}

/** "5h 42%", "weekly 100% · resets 14:05" — the reset only matters once a window is full. */
function chatgptQuotaText(quota) {
  const limits = quota && quota.rate_limits;
  if (!limits) return "";
  const windowName = (w) => {
    const minutes = w.window_minutes;
    if (!minutes) return "";
    if (minutes >= 7 * 24 * 60) return t("quota.windowWeek");
    if (minutes === 300) return t("quota.window5h");
    return t("quota.windowHours", { hours: Math.round(minutes / 60) });
  };
  return [limits.primary, limits.secondary].filter((w) => w && typeof w.used_percent === "number").map((w) => {
    const line = t("quota.line", { window: windowName(w), percent: Math.round(w.used_percent) }).trim();
    if (w.used_percent < 100) return line;
    const at = typeof w.reset_after_seconds === "number" ? Date.now() + w.reset_after_seconds * 1000 : typeof w.reset_at === "number" ? w.reset_at * 1000 : null;
    return at ? `${line} · ${t("quota.resetAt", { time: new Date(at).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) })}` : line;
  }).join(" · ");
}

/** A wait people read at a glance: "1시간 29분", "12분", "40초". */
function durationText(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  if (s >= 3600) return t("time.hoursMinutes", { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) });
  if (s >= 60) return t("time.minutes", { m: Math.ceil(s / 60) });
  return t("time.seconds", { s });
}

function chatgptStateBadge(account) {
  if (account.state === "paused") return el("span", { class: "badge", text: t("providers.chatgptPaused") });
  if (account.state === "needs-login" || account.state === "quarantined") return el("span", { class: "badge bad", text: t("providers.anthropicReauth") });
  if (account.state === "needs-verification") return el("span", { class: "badge warn", text: t("providers.googleVerifyNeeded") });
  if (account.state === "cooling") return el("span", { class: "badge warn", text: t("pool.coolingFor", { duration: durationText(account.cooldownSeconds) }) });
  return el("span", { class: "badge ok", text: account.active ? t("providers.chatgptInUse") : t("providers.chatgptStandby") });
}

async function patchChatgptAccount(name, id, change) {
  try {
    await api(`/api/chatgpt-accounts/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(change) });
    await refreshChatgptAccountPanel(name);
  } catch (error) { toast(t("common.actionFailed"), true, error.message); }
}

function renderChatgptAccountRows(target, data, name, generation) {
  if (generation !== providerDetailGeneration) return;
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  const rows = accounts.map((account) => {
    const own = account.source !== "codex";
    const actions = [];
    if (account.state === "needs-login" || account.state === "quarantined") {
      const reauth = el("button", { class: "btn secondary compact", type: "button", text: t("providers.reauthAction") });
      reauth.addEventListener("click", () => void startChatgptLogin(() => void refreshChatgptAccountPanel(name), true));
      if (own) actions.push(reauth);
    }
    if (account.state === "cooling") {
      const now = el("button", { class: "btn secondary compact", type: "button", text: t("providers.chatgptClearCooldown") });
      now.addEventListener("click", () => void patchChatgptAccount(name, account.id, { clearCooldown: true }));
      actions.push(now);
    }
    if (own) {
      const pause = el("button", { class: "btn secondary compact", type: "button", text: account.paused ? t("providers.chatgptResume") : t("providers.chatgptPause") });
      pause.addEventListener("click", () => void patchChatgptAccount(name, account.id, { paused: !account.paused }));
      const rename = el("button", { class: "btn secondary compact", type: "button", text: t("common.edit") });
      rename.addEventListener("click", () => {
        const label = prompt(t("providers.anthropicRenamePrompt"), account.label);
        if (!label || !label.trim() || label.trim() === account.label) return;
        void patchChatgptAccount(name, account.id, { label });
      });
      const remove = el("button", { class: "btn danger compact", type: "button", text: t("common.remove") });
      remove.addEventListener("click", async () => {
        if (!confirm(t("providers.chatgptRemoveConfirm", { name: account.label }))) return;
        try { await api(`/api/chatgpt-accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" }); await refreshChatgptAccountPanel(name); }
        catch (error) { toast(t("common.actionFailed"), true, error.message); }
      });
      actions.push(pause, rename, remove);
    }
    const quota = chatgptQuotaText(account.quota);
    const detail = [account.email && account.email !== account.label ? account.email : null, account.planType || null].filter(Boolean).join(" · ");
    const help = account.state === "needs-login" || account.state === "quarantined" ? t("providers.chatgptReauthHelp") : own ? t("providers.chatgptOwnHelp") : t("providers.chatgptCodexHelp");
    return el("article", { class: `cell account-card${account.active ? " current" : ""}` }, [
      el("div", { class: "cell-text account-card-copy" }, [
        el("strong", { text: account.label }),
        detail ? el("span", { class: "small", text: detail }) : null,
        quota ? el("p", { class: "small account-quota", text: quota }) : null,
        hint(help),
        actions.length ? el("div", { class: "account-card-actions" }, actions) : null,
      ]),
      el("div", { class: "account-card-badges" }, [chatgptStateBadge(account)]),
    ]);
  });
  target.replaceChildren(...(rows.length ? rows : [el("div", { class: "account-empty", text: t("providers.chatgptNoAccounts") })]));
  const countNode = $("#chatgpt-account-count");
  if (countNode) countNode.textContent = t("providers.chatgptAccountCount", { count: accounts.length });
}

let googleLoginBusy = false;
/**
 * The Antigravity sign-in. Google's terms name this use as a breach and suspended accounts for it,
 * so the warning is put in front of the user and the sign-in starts only on an explicit yes.
 */
async function startGoogleLogin(onChange) {
  if (googleLoginBusy) return false;
  if (!confirm(t("providers.googleWarning"))) return false;
  googleLoginBusy = true;
  onChange && onChange();
  try {
    const started = await api("/api/google-login", { method: "POST" });
    if (started.opened === false && started.url) toast(t("providers.googleOpenManually"), false, started.url);
    const deadline = Date.now() + 6 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const login = await api("/api/google-login");
      if (login.running === false && login.ok === true) { toast(t("providers.googleAdded")); await refreshHealth(); return true; }
      if (login.running === false && login.ok === false) { toast(t("common.actionFailed"), true, login.error); return false; }
    }
    return false;
  } catch (error) {
    toast(t("common.actionFailed"), true, error.message);
    return false;
  } finally {
    googleLoginBusy = false;
    onChange && onChange();
  }
}

async function patchGoogleAccount(name, id, change) {
  try {
    await api(`/api/google-accounts/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(change) });
    await refreshGoogleAccountPanel(name);
  } catch (error) { toast(t("common.actionFailed"), true, error.message); }
}
async function recheckGoogleVerification(name, id) {
  try {
    const result = await api(`/api/google-accounts/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ recheck: true }) });
    if (result.verification === "verified") toast(t("providers.googleVerified"));
    else if (result.verification === "still-required") toast(t("providers.googleStillUnverified"), true);
    else toast(t("providers.googleVerifyUnknown"), true);
    await refreshGoogleAccountPanel(name);
  } catch (error) { toast(t("common.actionFailed"), true, error.message); }
}

function renderGoogleAccountRows(target, data, name, generation) {
  if (generation !== providerDetailGeneration) return;
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  const rows = accounts.map((account) => {
    const actions = [];
    if (account.state === "needs-login" || account.state === "quarantined") {
      const reauth = el("button", { class: "btn secondary compact", type: "button", text: t("providers.reauthAction") });
      reauth.addEventListener("click", () => void startGoogleLogin(() => void refreshGoogleAccountPanel(name)));
      actions.push(reauth);
    }
    // Only the person can finish Google's check, so the page opens in their browser; the account
    // answers again on the next turn after that.
    if (account.state === "needs-verification" && account.verifyUrl) {
      const link = el("a", { class: "btn secondary compact", href: account.verifyUrl, target: "_blank", rel: "noreferrer", text: t("providers.googleVerifyAction") });
      // Coming back to this window is the likeliest moment the page has been finished: ask then.
      link.addEventListener("click", () => window.addEventListener("focus", () => void recheckGoogleVerification(name, account.id), { once: true }));
      const recheck = el("button", { class: "btn secondary compact", type: "button", text: t("providers.googleRecheck") });
      recheck.addEventListener("click", () => { recheck.disabled = true; void recheckGoogleVerification(name, account.id); });
      actions.push(link, recheck);
    }
    if (account.state === "cooling") {
      const now = el("button", { class: "btn secondary compact", type: "button", text: t("providers.chatgptClearCooldown") });
      now.addEventListener("click", () => void patchGoogleAccount(name, account.id, { clearCooldown: true }));
      actions.push(now);
    }
    const pause = el("button", { class: "btn secondary compact", type: "button", text: account.paused ? t("providers.chatgptResume") : t("providers.chatgptPause") });
    pause.addEventListener("click", () => void patchGoogleAccount(name, account.id, { paused: !account.paused }));
    const rename = el("button", { class: "btn secondary compact", type: "button", text: t("common.edit") });
    rename.addEventListener("click", () => {
      const label = prompt(t("providers.anthropicRenamePrompt"), account.label);
      if (!label || !label.trim() || label.trim() === account.label) return;
      void patchGoogleAccount(name, account.id, { label });
    });
    const remove = el("button", { class: "btn danger compact", type: "button", text: t("common.remove") });
    remove.addEventListener("click", async () => {
      if (!confirm(t("providers.googleRemoveConfirm", { name: account.label }))) return;
      try { await api(`/api/google-accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" }); await refreshGoogleAccountPanel(name); }
      catch (error) { toast(t("common.actionFailed"), true, error.message); }
    });
    actions.push(pause, rename, remove);
    const detail = [account.email && account.email !== account.label ? account.email : null, account.projectId ? t("providers.googleProject", { id: account.projectId }) : null].filter(Boolean).join(" · ");
    return el("article", { class: `cell account-card${account.active ? " current" : ""}` }, [
      el("div", { class: "cell-text account-card-copy" }, [
        el("strong", { text: account.label }),
        detail ? el("span", { class: "small", text: detail }) : null,
        hint(account.state === "needs-login" || account.state === "quarantined" ? t("providers.chatgptReauthHelp") : account.state === "needs-verification" ? t("providers.googleVerifyHelp") : t("providers.googleOwnHelp")),
        el("div", { class: "account-card-actions" }, actions),
      ]),
      el("div", { class: "account-card-badges" }, [chatgptStateBadge(account)]),
    ]);
  });
  target.replaceChildren(...(rows.length ? rows : [el("div", { class: "account-empty", text: t("providers.googleNoAccounts") })]));
  const countNode = $("#google-account-count");
  if (countNode) countNode.textContent = t("providers.chatgptAccountCount", { count: accounts.length });
}

async function refreshGoogleAccountPanel(name) {
  const target = $("#google-account-rows");
  if (!target || selectedProviderName !== name || providerDetailTab !== "accounts") return;
  const generation = providerDetailGeneration;
  try { renderGoogleAccountRows(target, await api(`/api/google-accounts?provider=${encodeURIComponent(name)}`), name, generation); }
  catch (error) { if (generation === providerDetailGeneration) target.replaceChildren(el("div", { class: "bad-text small", text: error.message })); }
}

function googleAccountsPanel(name) {
  const add = el("button", { class: "cell-button", type: "button", text: t("providers.addGoogleAccount") });
  add.disabled = googleLoginBusy;
  add.addEventListener("click", () => void startGoogleLogin(() => { renderProviderDetail(); void refreshGoogleAccountPanel(name); }));
  const rows = el("div", { id: "google-account-rows", class: "group account-card-list" }, [el("div", { class: "small", text: t("providers.checking") })]);
  const panel = el("div", { class: "provider-panel" }, [
    el("section", { class: "section" }, [
      el("div", { class: "section-head" }, [el("h3", { class: "section-title", text: t("providers.googleAccountsTitle") }), el("span", { id: "google-account-count", class: "small", text: t("providers.chatgptAccountCount", { count: 0 }) })]),
      rows,
      el("div", { class: "group stacked-add" }, [add]),
      googleLoginBusy ? el("p", { class: "group-footer", text: t("providers.googleLoginWaiting") }) : null,
      el("p", { class: "group-footer", text: t("providers.googleAccountsSubtitle") }),
      el("div", { class: "group-footer notice" }, [el("strong", { text: t("providers.googleWarningShort") })]),
    ]),
  ]);
  queueMicrotask(() => void refreshGoogleAccountPanel(name));
  return panel;
}

async function refreshChatgptAccountPanel(name) {
  const target = $("#chatgpt-account-rows");
  if (!target || selectedProviderName !== name || providerDetailTab !== "accounts") return;
  const generation = providerDetailGeneration;
  try { renderChatgptAccountRows(target, await api(`/api/chatgpt-accounts?provider=${encodeURIComponent(name)}`), name, generation); }
  catch (error) { if (generation === providerDetailGeneration) target.replaceChildren(el("div", { class: "bad-text small", text: error.message })); }
}

function chatgptAccountsPanel(name) {
  const add = el("button", { class: "cell-button", type: "button", text: t("providers.addChatgptAccount") });
  add.disabled = chatgptLoginBusy;
  const waiting = el("p", { class: "group-footer", text: chatgptLoginBusy ? t("providers.chatgptAddWaiting") : "" });
  waiting.hidden = !chatgptLoginBusy;
  add.addEventListener("click", () => void startChatgptLogin(() => { renderProviderDetail(); void refreshChatgptAccountPanel(name); }, true));
  const rows = el("div", { id: "chatgpt-account-rows", class: "group account-card-list" }, [el("div", { class: "small", text: t("providers.checking") })]);
  const panel = el("div", { class: "provider-panel" }, [
    el("section", { class: "section" }, [
      el("div", { class: "section-head" }, [el("h3", { class: "section-title", text: t("providers.chatgptAccountsTitle") }), el("span", { id: "chatgpt-account-count", class: "small", text: t("providers.chatgptAccountCount", { count: 0 }) })]),
      rows,
      el("div", { class: "group stacked-add" }, [add]),
      waiting,
      el("p", { class: "group-footer", text: t("providers.chatgptAccountsSubtitle") }),
    ]),
  ]);
  queueMicrotask(() => void refreshChatgptAccountPanel(name));
  return panel;
}

function renderProviderDetail() {
  const detail = $("#provider-detail");
  providerDetailGeneration += 1;
  const provider = currentConfig && currentConfig.providers && currentConfig.providers[selectedProviderName];
  if (!provider) {
    detail.replaceChildren(el("div", { class: "provider-detail-empty" }, [el("strong", { text: t("providers.noSelection") })]));
    return;
  }
  const name = selectedProviderName;
  const check = el("button", { class: "btn secondary", type: "button", text: t("providers.check") });
  check.addEventListener("click", async () => { check.disabled = true; await probeProvider(name, provider); check.disabled = false; renderProviderWorkspace(); });
  const edit = el("button", { class: "btn secondary", type: "button", text: t("common.edit"), onclick: () => openProviderForm({ name, provider }) });
  // Removing is the one destructive act on this page, so it sits apart at the bottom, not beside Edit.
  const remove = el("button", { class: "cell-button destructive", type: "button", text: t("providers.remove"), onclick: () => void removeProvider(name, provider) });
  const back = el("button", { class: "provider-back", type: "button", onclick: closeProviderDetail }, [svgIcon("0 0 9 15", ["M7.5 1.5l-6 6 6 6"]), el("span", { text: t("nav.providers") })]);
  const header = el("header", { class: "provider-detail-header" }, [
    el("div", {}, [el("div", { class: "provider-title-line" }, [el("h2", { text: name }), providerState(name, provider)]), el("p", { class: "small", text: providerKind(name, provider) })]),
    el("div", { class: "provider-detail-actions" }, [check, edit]),
  ]);
  let content;
  if (providerDetailTab === "accounts" && provider.type === "anthropic" && provider.auth === "claude-code") content = anthropicAccountsPanel(name, provider);
  else if (providerDetailTab === "accounts" && provider.type === "chatgpt") content = chatgptAccountsPanel(name);
  else if (providerDetailTab === "accounts" && provider.type === "google" && provider.auth === "antigravity") content = googleAccountsPanel(name);
  else if (providerDetailTab === "models") content = providerModelsPanel(name, provider);
  else { providerDetailTab = "overview"; content = providerOverview(name, provider); }
  detail.replaceChildren(back, header, providerTabs(name, provider), content, el("div", { class: "group provider-remove" }, [remove]));
}

function renderProviderWorkspace() {
  const entries = Object.entries((currentConfig && currentConfig.providers) || {});
  if (!selectedProviderName || !currentConfig.providers[selectedProviderName]) selectedProviderName = entries[0] ? entries[0][0] : null;
  renderProviderRail();
  renderProviderDetail();
}

async function loadClients() {
  clientsLoaded = true;
  try {
    await loadCatalogs();
    currentConfig = await api("/api/config");
    if (!status) status = await api("/api/status");
    renderClients();
  } catch (error) { toast(t("common.loadFailed"), true, error.message); }
}

async function loadProviders() {
  providersLoaded = true;
  try {
    await loadCatalogs();
    currentConfig = await api("/api/config");
    renderProviderWorkspace();
    void Promise.all(Object.entries(currentConfig.providers || {}).map(([name, provider]) => probeProvider(name, provider, () => {
      if ($("#view-providers").classList.contains("active")) renderProviderWorkspace();
    })));
  } catch (error) { toast(t("common.loadFailed"), true, error.message); }
}
$("#providers-search").addEventListener("input", (event) => { providerSearch = event.target.value; renderProviderRail(); });
$("#providers-add").addEventListener("click", openProviderChooser);
$("#providers-refresh").addEventListener("click", async () => {
  if (!currentConfig) return;
  const button = $("#providers-refresh");
  button.disabled = true;
  await Promise.all(Object.entries(currentConfig.providers).map(([name, provider]) => probeProvider(name, provider)));
  button.disabled = false;
  renderProviderWorkspace();
});

// ---- Provider modal -----------------------------------------------------------------

let modalCleanup = null;
function showModal(content, cleanup) {
  if (modalCleanup) modalCleanup();
  modalCleanup = cleanup || null;
  $("#modal-content").replaceChildren(content);
  $("#modal-backdrop").hidden = false;
  const first = $("#modal-content input, #modal-content button, #modal-content select");
  if (first) setTimeout(() => first.focus(), 0);
}
function closeModal() {
  const cleanup = modalCleanup;
  modalCleanup = null;
  if (cleanup) cleanup();
  $("#modal-backdrop").hidden = true;
  $("#modal-content").replaceChildren();
}
$("#modal-close").addEventListener("click", closeModal);
$("#modal-backdrop").addEventListener("click", (event) => { if (event.target === $("#modal-backdrop")) closeModal(); });
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#modal-backdrop").hidden) { closeModal(); return; }
  if (event.key === "Enter" && !$("#modal-backdrop").hidden && event.target.tagName !== "TEXTAREA") {
    const action = $("#modal-content [data-default-action]");
    if (action && !action.disabled) { event.preventDefault(); action.click(); }
  }
});

function openClaudeAccountConsent(providerName) {
  const accepted = el("input", { type: "checkbox" });
  const proceed = el("button", { class: "btn", type: "button", "data-default-action": "", text: t("providers.anthropicOAuthContinue") });
  proceed.disabled = true;
  accepted.addEventListener("change", () => { proceed.disabled = !accepted.checked; });
  proceed.addEventListener("click", () => void openClaudeAccountSignIn(providerName, false));
  showModal(el("div", { class: "oauth-consent" }, [
    el("h1", { id: "modal-title", text: t("providers.anthropicOAuthTitle") }),
    el("div", { class: "notice warn" }, [el("strong", { text: t("providers.anthropicOAuthTitle") }), el("span", { text: t("providers.anthropicOAuthWarning") })]),
    el("label", { class: "check oauth-accept" }, [accepted, el("span", { text: t("providers.anthropicOAuthAccept") })]),
    el("div", { class: "actions end" }, [el("button", { class: "btn secondary", type: "button", text: t("common.cancel"), onclick: closeModal }), proceed]),
  ]));
}

async function openClaudeAccountSignIn(providerName, manual) {
  let active = true;
  let poll = null;
  const body = el("div", { class: "oauth-progress" });
  function stopPolling() { if (poll) clearInterval(poll); poll = null; }
  function showError(state) {
    stopPolling();
    if (!active) return;
    const retry = el("button", { class: "btn secondary", type: "button", text: t("providers.anthropicSignInManual") });
    retry.addEventListener("click", () => void openClaudeAccountSignIn(providerName, true));
    body.replaceChildren(el("span", { class: "bad-text", text: t("providers.anthropicSignInFailed") }), state.error ? el("p", { class: "small", text: state.error }) : null, retry);
  }
  async function finish(state) {
    stopPolling();
    if (!active) return;
    if (!state.ok) { showError(state); return; }
    active = false;
    closeModal();
    if (selectedProviderName === providerName) {
      providerDetailTab = "accounts";
      renderProviderDetail();
    }
    toast(t("providers.anthropicLoginDone"));
  }
  function renderState(state) {
    const controls = [
      el("p", { text: state.manual ? t("providers.anthropicSignInPaste") : t("providers.anthropicSignInBrowser") }),
      state.url ? el("a", { class: "login-link", href: state.url, target: "_blank", rel: "noreferrer", text: t("providers.anthropicSignInLink") }) : null,
    ];
    if (state.manual) {
      const code = el("input", { type: "text", autocomplete: "off", placeholder: "code#state" });
      const submit = el("button", { class: "btn", type: "button", text: t("providers.anthropicSignInSubmit") });
      submit.addEventListener("click", async () => {
        submit.disabled = true;
        try { await finish(await api("/api/claude-oauth/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: code.value }) })); }
        catch (error) { showError((error.body && { ok: false, error: error.body.error }) || { ok: false, error: error.message }); }
      });
      controls.push(el("div", { class: "key-control" }, [code, submit]));
    } else controls.push(el("p", { class: "small", text: t("providers.anthropicSignInWaiting") }));
    controls.push(el("button", { class: "btn secondary", type: "button", text: t("common.cancel"), onclick: closeModal }));
    body.replaceChildren(...controls.filter(Boolean));
  }
  showModal(el("div", {}, [el("h1", { id: "modal-title", text: t("providers.anthropicOAuthTitle") }), body]), () => {
    const wasActive = active;
    active = false;
    stopPolling();
    if (wasActive) void api("/api/claude-oauth/cancel", { method: "POST" }).catch(() => {});
  });
  body.replaceChildren(el("p", { class: "small", text: t("providers.checking") }));
  try {
    const state = await api("/api/claude-oauth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manual: Boolean(manual) }) });
    if (!active) return;
    renderState(state);
    poll = setInterval(async () => {
      try {
        const next = await api("/api/claude-oauth");
        if (!next.running) await finish(next);
      } catch { /* keep the last useful state while the router is busy */ }
    }, 2000);
  } catch (error) { showError({ ok: false, error: error.message }); }
}

// The services one can connect, as grouped lists: sign-in subscriptions first, then the API-key
// presets by the format they speak (the "paste a key" note is said once per group, not per row),
// then the manual entry on its own.
function openProviderChooser() {
  const grid = el("div", { class: "chooser-grid" });
  function tile(title, help, options) {
    const button = el("button", { class: "chooser-tile", type: "button" }, [el("span", { class: "cell-text" }, [el("strong", { text: title }), help ? el("span", { text: help }) : null]), chevronIcon()]);
    button.addEventListener("click", () => openProviderForm(options));
    return button;
  }
  function group(title, tiles, footer, single) {
    if (!tiles.length) return;
    grid.appendChild(el("section", { class: "chooser-section" }, [
      title ? el("div", { class: "section-head" }, [el("h3", { class: "section-title", text: title })]) : null,
      el("div", { class: `group chooser-group chooser-tiles${single ? " single" : ""}` }, tiles),
      footer ? el("p", { class: "group-footer", text: footer }) : null,
    ]));
  }
  group(t("providers.subscriptionGroup"), [
    tile(t("providers.anthropic"), t("providers.anthropicHelp"), { kind: "anthropic" }),
    tile(t("providers.chatgpt"), t("providers.chatgptHelp"), { kind: "chatgpt" }),
    tile(t("providers.google"), t("providers.googleHelp"), { kind: "google" }),
    tile(t("providers.grok"), t("providers.grokHelp"), { kind: "grok" }),
  ], null, true);
  const native = presets.filter((preset) => (preset.kind || "anthropic-compatible") === "anthropic-compatible");
  group(t("providers.anthropicGroup"), native.map((preset) => tile(preset.name, null, { preset })), t("providers.presetHelp"));
  const openai = presets.filter((preset) => preset.kind === "openai-compatible");
  group(t("providers.openaiGroup"), openai.map((preset) => tile(preset.name, null, { preset })), `${t("providers.presetHelp")} ${t("providers.openaiGroupHelp")}`);
  group(null, [tile(t("providers.custom"), t("providers.customHelp"), { kind: "custom" })], null, true);
  showModal(el("div", {}, [el("h1", { id: "modal-title", text: t("providers.choose") }), hint(t("providers.chooseHelp")), grid]));
}
function inputRow(label, control, helpText) {
  return el("label", { class: "form-field" }, [el("span", { text: label }), control, helpText ? el("small", { text: helpText }) : null]);
}
// Checklist that stays usable with hundreds of models (OpenRouter lists 400+): a search box, checked
// entries pinned first, at most 36 visible rows, and the selection kept in a Set so filtering never
// loses ticks. `box.selected()` returns the chosen entries, each carrying whatever per-model override
// it arrived with (effortLevels, contextWindow, and the wire/url/authHeader a preset gave it) so a
// save does not strip the endpoint the model speaks.
function modelOverrideFields(model) {
  return {
    ...(Array.isArray(model.effortLevels) ? { effortLevels: [...model.effortLevels] } : {}),
    ...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
    ...(model.wire ? { wire: model.wire } : {}),
    ...(model.url ? { url: model.url } : {}),
    ...(model.authHeader ? { authHeader: model.authHeader } : {}),
  };
}
// A provider form holds the per-model fields from when it opened, and has no control for them; a
// measurement may have landed since. So a model the router already has keeps the router's values.
function withSavedModelFields(models, saved) {
  const known = new Map(modelsOf(saved).map((model) => [model.id, model]));
  return models.map((model) => known.has(model.id) ? { ...model, ...modelOverrideFields(known.get(model.id)) } : model);
}
function modelChecklist(models, checked, options = {}) {
  models = [...models];
  const selected = new Map();
  for (const model of models) if (checked.has(model.id)) selected.set(model.id, { id: model.id, name: labelOf(model), ...modelOverrideFields(model) });
  const wrap = el("div", { class: "model-picker" });
  const grid = el("div", { class: "model-checklist modal-checklist" });
  const note = el("div", { class: "small", text: "" });
  const search = models.length > 12 ? el("input", { type: "search", placeholder: t("providers.searchModels"), class: "model-search" }) : null;
  const LIMIT = 36;
  function render() {
    const q = (search ? search.value : "").trim().toLowerCase();
    const matches = models.filter((m) => !q || m.id.toLowerCase().includes(q) || labelOf(m).toLowerCase().includes(q));
    const pinned = matches.filter((m) => selected.has(m.id));
    const rest = matches.filter((m) => !selected.has(m.id)).slice(0, Math.max(0, LIMIT - pinned.length));
    grid.replaceChildren();
    for (const model of [...pinned, ...rest]) {
      const input = el("input", { type: "checkbox", checked: selected.has(model.id) });
      input.dataset.model = model.id;
      input.dataset.name = labelOf(model);
      input.addEventListener("change", () => {
        if (input.checked) selected.set(model.id, { id: model.id, name: labelOf(model), ...modelOverrideFields(model) });
        else selected.delete(model.id);
        note.textContent = summary(matches.length);
      });
      const tag = modelEffortTag(model);
      grid.appendChild(el("label", { class: "model-check", title: model.id }, [input, el("span", { text: labelOf(model) }), tag ? el("span", { class: `model-effort-tag ${model.effortLevels.length ? "has-effort" : "no-effort"}`, text: tag }) : null]));
    }
    note.textContent = summary(matches.length);
  }
  function summary(matchCount) {
    const hidden = Math.max(0, matchCount - Math.min(matchCount, LIMIT));
    return t("providers.modelsSummary", { selected: selected.size, total: models.length }) + (hidden > 0 ? " · " + t("providers.modelsHidden", { hidden }) : "");
  }
  if (search) { search.addEventListener("input", render); wrap.appendChild(search); }
  wrap.append(grid, note);
  // A provider without a model list (or one that leaves a model off it) is otherwise unusable: the
  // only ids on offer are the ones fetched, and abliteration.ai lists none (issue #42).
  if (options.allowCustom) {
    const idInput = el("input", { placeholder: t("providers.customModelPlaceholder"), autocomplete: "off", spellcheck: "false" });
    const addButton = el("button", { class: "btn secondary", type: "button", text: t("providers.customModelAdd") });
    function addTyped() {
      const id = idInput.value.trim();
      if (!id) return;
      if (!models.some((model) => model.id === id)) models.unshift({ id, name: id });
      const model = models.find((entry) => entry.id === id);
      selected.set(id, { id, name: labelOf(model), ...modelOverrideFields(model) });
      idInput.value = "";
      if (search) search.value = "";
      render();
    }
    addButton.addEventListener("click", addTyped);
    // Enter here adds the id; left to bubble, the modal's own Enter handler would save the form too.
    idInput.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); event.stopPropagation(); addTyped(); } });
    wrap.appendChild(el("div", { class: "key-control model-add" }, [idInput, addButton]));
  }
  wrap.selected = () => [...selected.values()];
  render();
  return wrap;
}
function anthropicSourceText(source) {
  if (source === "observed") return t("providers.anthropicSourceObserved");
  if (source === "keychain" || source === "credentials-file" || source === "env") return t("providers.anthropicSourceClaudeCode");
  if (source === "token-file") return t("providers.anthropicSourceTokenFile");
  return t("providers.anthropicSourceMissing");
}
function openAnthropicProviderForm(options) {
  let formActive = true;
  const existing = options.provider;
  const displayName = options.name || t("providers.anthropic");
  const nameInput = el("input", { value: displayName, maxlength: "60" });
  const auth = el("select", {}, [selectOption("claude-code", t("providers.anthropicAuthClaudeCode")), selectOption("api-key", t("providers.anthropicAuthApiKey"))]);
  auth.value = (existing && existing.auth) || "claude-code";
  const keyInput = el("input", { type: "password", autocomplete: "off", placeholder: existing && existing.apiKey ? t("providers.keySaved") : t("providers.keyPlaceholder") });
  const showKey = el("button", { class: "eye-button", type: "button", text: t("common.show") });
  showKey.addEventListener("click", () => { const show = keyInput.type === "password"; keyInput.type = show ? "text" : "password"; showKey.textContent = show ? t("common.hide") : t("common.show"); });
  const result = el("div", { class: "probe-result" });
  const probeButton = el("button", { class: "btn secondary", type: "button", text: t("providers.check") });
  const sourceLine = el("div", { class: "small" });
  let foundModels = modelsOf(existing).length ? modelsOf(existing) : claudeModels.map((model) => ({ id: model.id, name: labelOf(model) }));
  let selected = new Set(existing ? modelsOf(existing).map((model) => model.id) : foundModels.map((model) => model.id));
  const modelArea = el("div", { class: "form-field" });
  function renderModels() {
    const modelsBox = modelChecklist(foundModels, selected);
    modelArea.replaceChildren(el("span", { text: t("providers.models") }), hint(t("providers.modelsHelp")), el("small", { text: t("providers.effortLevels", { levels: "low · medium · high · max" }) }), modelsBox);
  }
  renderModels();
  const authField = inputRow(t("providers.credentials"), auth, t("providers.anthropicCredentialsHelp"));
  const keyField = el("div", { class: "form-field key-field" }, [el("span", { text: t("providers.apiKey") }), el("div", { class: "key-control" }, [keyInput, showKey]), el("small", { text: t("providers.keyHelp") })]);
  const accountPool = existing ? Boolean(existing.accountPool) : true;
  function syncAuthFields() {
    const reused = auth.value === "claude-code";
    keyField.hidden = reused;
    sourceLine.hidden = !reused;
  }
  auth.addEventListener("change", syncAuthFields);
  syncAuthFields();
  async function runProbe() {
    probeButton.disabled = true;
    result.textContent = t("providers.checking");
    try {
      const body = auth.value === "claude-code" ? { type: "anthropic", auth: "claude-code" } : { type: "anthropic", auth: "api-key", apiKey: keyInput.value || (existing && existing.apiKey) };
      const response = await api("/api/providers/probe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!formActive) return;
      sourceLine.textContent = anthropicSourceText(response.source);
      const noCredits = response.ok && /^no-credits:/.test(response.error || "");
      result.replaceChildren(...[
        el("span", { class: response.ok && !noCredits ? "ok-text" : noCredits ? "warn-text" : "bad-text", text: noCredits ? t("providers.probeNoCredits") : response.ok ? t("providers.probeOk") : response.auth === "not-entitled" ? t("providers.probeNotEntitled") : response.auth === "bad-key" ? t("providers.probeBadKey") : auth.value === "claude-code" ? anthropicSourceText(response.source) : t("providers.probeFailed") }),
        response.error ? el("div", { class: "small", text: response.error.replace(/^no-credits:\s*/, "") }) : null,
      ].filter(Boolean));
      if (Array.isArray(response.models) && response.models.length) {
        // Anthropic's own list, so a release shows up here without a ClaudeRipple update. A saved
        // model the list no longer carries stays visible and ticked rather than dropped on save.
        const listed = new Set(response.models.map((model) => model.id));
        foundModels = [...response.models, ...modelsOf(existing).filter((model) => !listed.has(model.id))];
        selected = new Set(existing ? modelsOf(existing).map((model) => model.id) : foundModels.map((model) => model.id));
        renderModels();
      }
    } catch (error) { if (formActive) result.replaceChildren(el("span", { class: "bad-text", text: t("providers.probeFailed") }), el("div", { class: "small", text: error.message })); }
    finally { if (formActive) probeButton.disabled = false; }
  }
  probeButton.addEventListener("click", () => void runProbe());
  // The Claude login needs nothing typed, so fetch the account's model list as soon as the form
  // opens: a saved provider otherwise showed only what was ticked when it was first saved.
  if (auth.value === "claude-code") setTimeout(() => void runProbe(), 0);
  const modeHint = hint("");
  function syncModeHint() { modeHint.textContent = auth.value === "claude-code" && accountPool ? t("providers.anthropicPoolRouting") : t("providers.anthropicIngressOnly"); }
  auth.addEventListener("change", syncModeHint);
  syncModeHint();
  const form = el("div", { class: "provider-form" }, [
    el("h1", { id: "modal-title", text: existing ? t("providers.edit") : t("providers.addTitle") }),
    inputRow(t("providers.name"), nameInput, t("providers.nameHelp")), authField, keyField, probeButton, sourceLine, result, modelArea,
    modeHint,
  ]);
  const saveButton = el("button", { class: "btn", type: "button", "data-default-action": "", text: existing ? t("common.save") : t("providers.add") });
  saveButton.addEventListener("click", async () => {
    const typedName = nameInput.value.trim();
    if (!typedName) { toast(t("providers.nameRequired"), true); return; }
    const next = clone(await latestConfig());
    const providerName = existing ? options.name : uniqueName(typedName, next.providers);
    const checkedModels = withSavedModelFields(form.querySelector(".model-picker").selected(), existing && next.providers[options.name]);
    const provider = { type: "anthropic", auth: auth.value, ...(auth.value === "claude-code" && accountPool ? { accountPool: true } : {}), ...(auth.value === "api-key" && (keyInput.value || (existing && existing.apiKey)) ? { apiKey: keyInput.value || existing.apiKey } : {}), models: checkedModels };
    next.providers[providerName] = provider;
    // accountPool makes these models native Claude routing targets. Without it this remains the
    // historical OpenAI ingress provider, and routing deliberately ignores it.
    saveButton.disabled = true;
    try { await configRequest(next); currentConfig = next; selectedProviderName = providerName; providerDetailTab = auth.value === "claude-code" ? "accounts" : "overview"; slotsLoaded = false; clientsLoaded = false; providersLoaded = false; closeModal(); await loadProviders(); toast(t("common.saved")); }
    catch (error) { toast(t("common.saveFailed"), true, error.message); }
    finally { saveButton.disabled = false; }
  });
  form.appendChild(el("div", { class: "actions end" }, [el("button", { class: "btn secondary", type: "button", text: t("common.cancel"), onclick: closeModal }), saveButton]));
  showModal(form, () => { formActive = false; });
  if (auth.value === "claude-code") void runProbe();
}
/**
 * What a Grok form's check leaves ticked. A handful of models, so a new provider's first listing
 * starts with all of them ticked. Every later check — and every check of a saved provider — keeps
 * what is ticked at that moment, so a model the user unticked stays unticked.
 */
function grokTickedAfterCheck(firstListing, tickedIds, listedIds) {
  return new Set(firstListing ? listedIds : tickedIds);
}

/**
 * A Grok subscription: nothing to type. The router reads the Grok CLI's own session, so the form
 * checks that it is there, lists what the proxy offers and saves the ticked models. The check runs
 * as soon as the form opens, since there is no key to wait for.
 */
function openGrokProviderForm(options) {
  let formActive = true;
  const existing = options.provider;
  const nameInput = el("input", { value: options.name || t("providers.grok"), maxlength: "60" });
  const result = el("div", { class: "probe-result" });
  const probeButton = el("button", { class: "btn secondary", type: "button", text: t("providers.check") });
  let foundModels = modelsOf(existing);
  const currentChecked = new Set(foundModels.map((model) => model.id));
  let listed = false;
  const modelArea = el("div", { class: "form-field" });
  function renderModels(checked, help) {
    modelArea.replaceChildren(el("span", { text: t("providers.models") }), hint(help || t("providers.modelsHelp")), modelChecklist(foundModels, checked, { allowCustom: true }));
  }
  renderModels(currentChecked);
  // Fields this form has no control for (a home, a binary, a pinned version) go to the probe as saved.
  const probeBody = () => ({ type: "grok", ...Object.fromEntries(["home", "cli", "url", "clientVersion"].filter((key) => existing && existing[key]).map((key) => [key, existing[key]])) });
  async function runProbe() {
    probeButton.disabled = true;
    result.textContent = t("providers.checking");
    try {
      const response = await api("/api/providers/probe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(probeBody()) });
      if (!formActive) return;
      const failed = response.auth === "missing" || response.auth === "bad-key" ? t("providers.grokSignInFirst") : t("providers.probeFailed");
      result.replaceChildren(...[
        el("span", { class: response.ok ? "ok-text" : "bad-text", text: response.ok ? t("providers.probeOk") : failed }),
        response.error ? el("div", { class: "small", text: response.error }) : null,
      ].filter(Boolean));
      if (Array.isArray(response.models) && response.models.length) {
        const ticked = modelArea.querySelector(".model-picker").selected();
        const keep = grokTickedAfterCheck(!existing && !listed, ticked.map((model) => model.id), response.models.map((model) => model.id));
        listed = true;
        foundModels = [...ticked.filter((model) => !response.models.some((m) => m.id === model.id)), ...response.models];
        renderModels(keep);
      }
    } catch (error) { if (formActive) result.replaceChildren(el("span", { class: "bad-text", text: t("providers.probeFailed") }), el("div", { class: "small", text: error.message })); }
    finally { if (formActive) probeButton.disabled = false; }
  }
  probeButton.addEventListener("click", () => void runProbe());
  const advanced = el("details", { class: "details" }, [el("summary", { text: t("common.advanced") })]);
  const identity = el("input", { type: "checkbox", checked: !(existing && existing.identity === false) });
  const append = el("textarea", { rows: "2", value: (existing && existing.instructionsAppend) || "" });
  advanced.appendChild(el("div", { class: "advanced-content" }, [
    el("div", { class: "form-field" }, [el("label", { class: "check" }, [identity, el("span", { text: t("providers.identity") })]), el("small", { text: t("providers.identityHelp") })]),
    inputRow(t("providers.append"), append, t("providers.appendHelp")),
  ]));
  const pickerInput = el("input", { type: "checkbox", checked: existing ? modelsOf(existing).some((model) => ((currentConfig.cli && currentConfig.cli.extraModels) || []).some((extra) => extra.model === model.id)) : true });
  const form = el("div", { class: "provider-form" }, [
    el("h1", { id: "modal-title", text: existing ? t("providers.edit") : t("providers.addTitle") }),
    inputRow(t("providers.name"), nameInput, t("providers.nameHelp")),
    el("div", { class: "form-field" }, [el("span", { text: t("providers.credentials") }), hint(t("providers.grokFormHelp")), el("small", { class: "warn-text", text: t("providers.grokWarningShort") })]),
    probeButton, result, modelArea,
    el("label", { class: "check picker-check" }, [pickerInput, el("span", { text: t("providers.showInPicker") })]),
    pickerModeOn() ? null : hint(t("providers.pickerOffHint")),
    advanced,
  ]);
  const saveButton = el("button", { class: "btn", type: "button", "data-default-action": "", text: existing ? t("common.save") : t("providers.add") });
  saveButton.addEventListener("click", async () => {
    const typedName = nameInput.value.trim();
    if (!typedName) { toast(t("providers.nameRequired"), true); return; }
    const next = clone(await latestConfig());
    const providerName = existing ? options.name : uniqueName(typedName, next.providers);
    const saved = existing && (next.providers[options.name] || existing);
    const checkedModels = withSavedModelFields(form.querySelector(".model-picker").selected(), saved);
    const formKeys = new Set(["type", "identity", "instructionsAppend", "models"]);
    const kept = saved ? Object.fromEntries(Object.entries(saved).filter(([key]) => !formKeys.has(key))) : {};
    next.providers[providerName] = {
      ...kept,
      type: "grok",
      identity: identity.checked,
      ...(append.value.trim() ? { instructionsAppend: append.value.trim() } : {}),
      models: checkedModels,
    };
    const existingSelections = pickerSelectionsExcept(next, providerName);
    applyPickerSelections(next, pickerInput.checked ? [...existingSelections, ...checkedModels.map((model) => ({ ...model, provider: providerName }))] : existingSelections);
    saveButton.disabled = true;
    try { await configRequest(next); currentConfig = next; selectedProviderName = providerName; providerDetailTab = "overview"; slotsLoaded = false; clientsLoaded = false; providersLoaded = false; closeModal(); await loadProviders(); toast(t("common.saved")); await offerPickerOn(pickerInput.checked && checkedModels.length > 0); }
    catch (error) { toast(t("common.saveFailed"), true, error.message); }
    finally { saveButton.disabled = false; }
  });
  form.appendChild(el("div", { class: "actions end" }, [el("button", { class: "btn secondary", type: "button", text: t("common.cancel"), onclick: closeModal }), saveButton]));
  showModal(form, () => { formActive = false; });
  void runProbe();
}

function openGoogleProviderForm(options) {
  let formActive = true;
  const existing = options.provider;
  const nameInput = el("input", { value: options.name || t("providers.google"), maxlength: "60" });
  const keyInput = el("input", { type: "password", autocomplete: "off", placeholder: existing && existing.apiKey ? t("providers.keySaved") : t("providers.keyPlaceholder") });
  const showKey = el("button", { class: "eye-button", type: "button", text: t("common.show") });
  showKey.addEventListener("click", () => { const show = keyInput.type === "password"; keyInput.type = show ? "text" : "password"; showKey.textContent = show ? t("common.hide") : t("common.show"); });
  const keyField = el("div", { class: "form-field key-field" }, [el("span", { text: t("providers.apiKey") }), el("div", { class: "key-control" }, [keyInput, showKey]), el("small", { text: t("providers.googleKeyHelp") })]);
  const auth = el("select", {}, [selectOption("api-key", t("providers.googleAuthApiKey")), selectOption("antigravity", t("providers.googleAntigravity"))]);
  auth.value = (existing && existing.auth) || "api-key";
  const authField = inputRow(t("providers.credentials"), auth, t("providers.googleAuthHelp"));
  const login = el("button", { class: "btn secondary", type: "button", text: t("providers.addGoogleAccount") });
  login.addEventListener("click", async () => {
    login.disabled = true;
    if (await startGoogleLogin()) await runProbe();
    if (formActive) login.disabled = false;
  });
  const loginField = el("div", { class: "form-field" }, [el("span", { text: t("providers.googleLogin") }), login, el("small", { class: "warn-text", text: t("providers.googleWarningShort") })]);
  function syncAuth() {
    keyField.hidden = auth.value !== "api-key";
    loginField.hidden = auth.value !== "antigravity";
  }
  auth.addEventListener("change", syncAuth);
  syncAuth();
  const result = el("div", { class: "probe-result" });
  const probeButton = el("button", { class: "btn secondary", type: "button", text: t("providers.check") });
  let foundModels = modelsOf(existing);
  const currentChecked = new Set(foundModels.map((model) => model.id));
  const modelArea = el("div", { class: "form-field" });
  function renderModels(checked, help) {
    modelArea.replaceChildren(el("span", { text: t("providers.models") }), hint(help || t("providers.modelsHelp")), modelChecklist(foundModels, checked, { allowCustom: true }));
  }
  renderModels(currentChecked);
  async function runProbe() {
    probeButton.disabled = true;
    result.textContent = t("providers.checking");
    try {
      const body = auth.value === "antigravity" ? { type: "google", auth: "antigravity" } : { type: "google", auth: "api-key", apiKey: keyInput.value.trim() || (existing && existing.apiKey) };
      const response = await api("/api/providers/probe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!formActive) return;
      const failed = response.auth === "bad-key" ? t("providers.probeBadKey") : response.auth === "missing" && auth.value === "antigravity" ? t("providers.googleSignInFirst") : t("providers.probeFailed");
      result.replaceChildren(...[
        el("span", { class: response.ok ? "ok-text" : "bad-text", text: response.ok ? t("providers.probeOk") : failed }),
        response.error ? el("div", { class: "small", text: response.error }) : null,
      ].filter(Boolean));
      if (Array.isArray(response.models) && response.models.length) {
        const ticked = modelArea.querySelector(".model-picker").selected();
        // The catalogue lists dozens of Gemini variants, so a new provider starts with none ticked
        // rather than all of them; saved and typed picks stay ticked and visible.
        const keep = new Set([...currentChecked, ...ticked.map((model) => model.id)]);
        foundModels = [...ticked.filter((model) => !response.models.some((m) => m.id === model.id)), ...response.models];
        renderModels(keep, t("providers.modelsFoundMany"));
      }
    } catch (error) { if (formActive) result.replaceChildren(el("span", { class: "bad-text", text: t("providers.probeFailed") }), el("div", { class: "small", text: error.message })); }
    finally { if (formActive) probeButton.disabled = false; }
  }
  probeButton.addEventListener("click", () => void runProbe());
  const advanced = el("details", { class: "details" }, [el("summary", { text: t("common.advanced") })]);
  const identity = el("input", { type: "checkbox", checked: !(existing && existing.identity === false) });
  const append = el("textarea", { rows: "2", value: (existing && existing.instructionsAppend) || "" });
  advanced.appendChild(el("div", { class: "advanced-content" }, [
    el("div", { class: "form-field" }, [el("label", { class: "check" }, [identity, el("span", { text: t("providers.identity") })]), el("small", { text: t("providers.identityHelp") })]),
    inputRow(t("providers.append"), append, t("providers.appendHelp")),
  ]));
  const pickerInput = el("input", { type: "checkbox", checked: Boolean(existing && modelsOf(existing).some((model) => ((currentConfig.cli && currentConfig.cli.extraModels) || []).some((extra) => extra.model === model.id))) });
  const form = el("div", { class: "provider-form" }, [
    el("h1", { id: "modal-title", text: existing ? t("providers.edit") : t("providers.addTitle") }),
    inputRow(t("providers.name"), nameInput, t("providers.nameHelp")), authField, keyField, loginField, probeButton, result, modelArea,
    el("label", { class: "check picker-check" }, [pickerInput, el("span", { text: t("providers.showInPicker") })]),
    pickerModeOn() ? null : hint(t("providers.pickerOffHint")),
    advanced,
  ]);
  const saveButton = el("button", { class: "btn", type: "button", "data-default-action": "", text: existing ? t("common.save") : t("providers.add") });
  saveButton.addEventListener("click", async () => {
    const typedName = nameInput.value.trim();
    if (!typedName) { toast(t("providers.nameRequired"), true); return; }
    const next = clone(await latestConfig());
    const providerName = existing ? options.name : uniqueName(typedName, next.providers);
    const apiKey = auth.value === "api-key" ? keyInput.value.trim() || (existing && existing.apiKey) : undefined;
    const saved = existing && (next.providers[options.name] || existing);
    const checkedModels = withSavedModelFields(form.querySelector(".model-picker").selected(), saved);
    // Fields this form has no control for (defaultEffort, a hand-written setting) survive the save.
    const formKeys = new Set(["type", "auth", "apiKey", "identity", "instructionsAppend", "models"]);
    const kept = saved ? Object.fromEntries(Object.entries(saved).filter(([key]) => !formKeys.has(key))) : {};
    next.providers[providerName] = {
      ...kept,
      type: "google",
      auth: auth.value,
      ...(apiKey ? { apiKey } : {}),
      ...(existing && existing.url ? { url: existing.url } : {}),
      identity: identity.checked,
      ...(append.value.trim() ? { instructionsAppend: append.value.trim() } : {}),
      models: checkedModels,
    };
    // Same rule as the other provider forms: read after the provider is updated, so an unticked
    // model is already undeclared and falls out of the picker on its own.
    const existingSelections = pickerSelectionsExcept(next, providerName);
    applyPickerSelections(next, pickerInput.checked ? [...existingSelections, ...checkedModels.map((model) => ({ ...model, provider: providerName }))] : existingSelections);
    saveButton.disabled = true;
    try { await configRequest(next); currentConfig = next; selectedProviderName = providerName; providerDetailTab = auth.value === "antigravity" ? "accounts" : "overview"; slotsLoaded = false; clientsLoaded = false; providersLoaded = false; closeModal(); await loadProviders(); toast(t("common.saved")); await offerPickerOn(pickerInput.checked && checkedModels.length > 0); }
    catch (error) { toast(t("common.saveFailed"), true, error.message); }
    finally { saveButton.disabled = false; }
  });
  form.appendChild(el("div", { class: "actions end" }, [el("button", { class: "btn secondary", type: "button", text: t("common.cancel"), onclick: closeModal }), saveButton]));
  showModal(form, () => { formActive = false; });
  // An existing provider can already reach its catalogue (a stored key or a signed-in account), so
  // the full list is shown straight away.
  if (existing && (existing.apiKey || existing.auth === "antigravity")) void runProbe();
}
function openProviderForm(options) {
  const existing = options.provider;
  const preset = options.preset || (existing && existing.preset && presetById(existing.preset));
  const isChatgpt = options.kind === "chatgpt" || (existing && existing.type === "chatgpt");
  const isAnthropic = options.kind === "anthropic" || (existing && existing.type === "anthropic");
  const isOpenAi = !isChatgpt && !isAnthropic && ((existing && existing.type === "openai-compatible") || (preset && preset.kind === "openai-compatible"));
  const isCustom = options.kind === "custom";
  const displayName = options.name || (preset && preset.name) || (isChatgpt ? t("providers.chatgpt") : isAnthropic ? t("providers.anthropic") : t("providers.customName"));
  if (isAnthropic) { openAnthropicProviderForm(options); return; }
  if (options.kind === "google" || (existing && existing.type === "google")) { openGoogleProviderForm(options); return; }
  if (options.kind === "grok" || (existing && existing.type === "grok")) { openGrokProviderForm(options); return; }
  const nameInput = el("input", { value: displayName, maxlength: "60" });
  const keyInput = el("input", { type: "password", autocomplete: "off", placeholder: t("providers.keyPlaceholder") });
  const showKey = el("button", { class: "eye-button", type: "button", text: t("common.show") });
  showKey.addEventListener("click", () => { const show = keyInput.type === "password"; keyInput.type = show ? "text" : "password"; showKey.textContent = show ? t("common.hide") : t("common.show"); });
  const currentHeaders = (existing && existing.headers) || {};
  const headerKind = preset ? preset.authHeader : (isOpenAi || Object.keys(currentHeaders).some((key) => key.toLowerCase() === "authorization") ? "authorization-bearer" : "x-api-key");
  const existingKey = headerKind === "authorization-bearer" ? String(currentHeaders.authorization || "").replace(/^Bearer\s+/i, "") : currentHeaders["x-api-key"] || "";
  if (existingKey) keyInput.placeholder = t("providers.keySaved");
  const urlInput = el("input", { value: (existing && existing.url) || (preset && preset.anthropicBaseUrl) || "", placeholder: "https://" });
  const wireSelect = el("select", {}, [selectOption("chat", "Chat Completions"), selectOption("responses", "Responses")]);
  wireSelect.value = (existing && existing.wire) || (preset && preset.wire) || "chat";
  // A provider entered by hand speaks whichever API its docs name, so the form asks instead of
  // assuming Anthropic: an OpenAI-compatible address was saved as Anthropic and tested on
  // /v1/messages, which answered 404 (2026-10-07, reported by a user).
  const formatSelect = el("select", {}, [selectOption("anthropic", "Anthropic Messages"), selectOption("chat", "OpenAI Chat Completions"), selectOption("responses", "OpenAI Responses")]);
  const openAiNow = () => isCustom ? formatSelect.value !== "anthropic" : isOpenAi;
  const wireNow = () => isCustom ? formatSelect.value : wireSelect.value;
  const pickerInput = el("input", { type: "checkbox", checked: Boolean(existing && (existing.models || []).some((model) => {
    const id = typeof model === "string" ? model : model.id;
    return ((currentConfig.cli && currentConfig.cli.extraModels) || []).some((extra) => extra.model === id);
  })) });
  const initialModels = modelsOf(existing).length ? modelsOf(existing) : (preset ? (preset.fallbackModels || []) : (isChatgpt ? CHATGPT_MODELS : []));
  let foundModels = initialModels;
  const currentChecked = new Set(modelsOf(existing).map((model) => model.id));
  // Everything starts ticked only for a new provider. An existing one keeps its saved picks even
  // when that is none: treating "no models" as "not decided yet" re-ticked the whole fallback list
  // every time the form opened, and saving then declared all of them (2026-09-29, opencode-zen).
  const checklistOptions = { allowCustom: !isChatgpt };
  const modelsBox = modelChecklist(foundModels, existing ? currentChecked : new Set(foundModels.map((model) => model.id)), checklistOptions);
  const providerEffortLevels = isChatgpt
    ? effortLevelsFor(options.name || "chatgpt", "gpt-5.6-terra")
    : (existing ? effortLevelsFor(options.name, initialModels[0] && initialModels[0].id) : fallbackEffortLevels({ ...(preset ? { preset: preset.id } : {}), ...(isCustom ? { caps: {} } : {}) }, initialModels[0] && initialModels[0].id));
  const modelArea = el("div", { class: "form-field" }, [
    el("span", { text: t("providers.models") }),
    hint(t("providers.modelsHelp")),
    hasModelEffortData({ models: initialModels }) ? null : el("small", { text: t("providers.effortLevels", { levels: providerEffortLevels.length ? providerEffortLevels.join(" · ") : t("providers.effortNone") }) }),
    modelsBox,
  ]);
  const result = el("div", { class: "probe-result" });
  const probeButton = el("button", { class: "btn secondary", type: "button", text: t("providers.check") });
  const advanced = el("details", { class: "details" });
  advanced.append(el("summary", { text: t("common.advanced") }));
  const advancedContent = el("div", { class: "advanced-content" });
  let chatgptFields = [];
  if (!isChatgpt) {
    // A hand-entered provider shows the address above, outside this section; one input cannot sit in
    // both places, and this row was left with its label and help but no field.
    if (!isCustom) advancedContent.appendChild(inputRow(t("providers.url"), urlInput, isOpenAi ? t("providers.openaiUrlHelp") : t("providers.urlHelp")));
    if (isOpenAi) advancedContent.appendChild(inputRow(t("providers.wire"), wireSelect, t("providers.wireHelp")));
    if (isCustom) {
      const authSelect = el("select", {}, [selectOption("x-api-key", "x-api-key"), selectOption("authorization-bearer", "Authorization: Bearer")]);
      authSelect.value = headerKind;
      advancedContent.appendChild(inputRow(t("providers.keyType"), authSelect, t("providers.keyTypeHelp")));
      let authPicked = false;
      authSelect.addEventListener("change", () => { authPicked = true; keyInput.dataset.headerKind = authSelect.value; });
      // OpenAI-compatible APIs take the key as a Bearer token, so follow the format until the
      // header has been picked by hand.
      formatSelect.addEventListener("change", () => {
        if (authPicked) return;
        authSelect.value = openAiNow() ? "authorization-bearer" : "x-api-key";
        keyInput.dataset.headerKind = authSelect.value;
      });
    }
    const extraHeaders = el("textarea", { rows: "2", placeholder: "header-name: value" });
    const additional = Object.entries(currentHeaders).filter(([key]) => key.toLowerCase() !== "x-api-key" && key.toLowerCase() !== "authorization");
    extraHeaders.value = additional.map(([key, value]) => `${key}: ${value}`).join("\n");
    advancedContent.appendChild(inputRow(t("providers.extraHeaders"), extraHeaders, t("providers.extraHeadersHelp")));
    advancedContent._extraHeaders = extraHeaders;
    // Without a line of its own the model reads Claude Code's system prompt and answers that it is
    // Claude, which is what DeepSeek did before this was offered here too.
    const identity = el("input", { type: "checkbox", checked: !(existing && existing.identity === false) });
    const append = el("textarea", { rows: "2", value: (existing && existing.instructionsAppend) || "" });
    advancedContent.append(
      el("div", { class: "form-field" }, [el("label", { class: "check" }, [identity, el("span", { text: t("providers.identity") })]), el("small", { text: t("providers.identityHelp") })]),
      inputRow(t("providers.append"), append, t("providers.appendHelp")),
    );
    advancedContent._prompt = { identity, append };
  } else {
    const auth = el("select", {}, [selectOption("auto", t("providers.authAuto")), selectOption("own", t("providers.authOwn")), selectOption("borrow-codex", t("providers.authBorrow"))]);
    auth.value = (existing && existing.auth) || "auto";
    const login = el("button", { class: "btn secondary", type: "button", text: t("providers.chatgptLogin") });
    login.addEventListener("click", () => void startChatgptLogin(() => {
      login.disabled = chatgptLoginBusy;
      loginHelp.textContent = chatgptLoginMessage || t("providers.loginHelp");
    }));
    const loginHelp = el("small", { text: t("providers.loginHelp") });
    const effort = effortSelect((existing && existing.defaultEffort) || "high", ["low", "medium", "high", "xhigh", "max"]);
    const identity = el("input", { type: "checkbox", checked: !(existing && existing.identity === false) });
    const append = el("textarea", { rows: "2", value: (existing && existing.instructionsAppend) || "" });
    chatgptFields = [
      inputRow(t("providers.credentials"), auth, t("providers.credentialsHelp")),
      el("div", { class: "form-field" }, [el("span", { text: t("providers.login") }), login, loginHelp]),
      inputRow(t("providers.defaultEffort"), effort, t("providers.defaultEffortHelp")),
    ];
    advancedContent.append(
      el("div", { class: "form-field" }, [el("label", { class: "check" }, [identity, el("span", { text: t("providers.identity") })]), el("small", { text: t("providers.identityHelp") })]),
      inputRow(t("providers.append"), append, t("providers.appendHelp")),
    );
    advancedContent._chatgpt = { auth, effort, identity, append };
  }
  advanced.appendChild(advancedContent);
  const customUrlRow = isCustom ? inputRow(t("providers.url"), urlInput, t("providers.urlHelp")) : null;
  if (isCustom) formatSelect.addEventListener("change", () => {
    customUrlRow.querySelector("small").textContent = openAiNow() ? t("providers.openaiUrlHelp") : t("providers.urlHelp");
  });
  const form = el("div", { class: "provider-form" }, [
    el("h1", { id: "modal-title", text: existing ? t("providers.edit") : t("providers.addTitle") }),
    inputRow(t("providers.name"), nameInput, t("providers.nameHelp")),
    !isChatgpt ? el("div", { class: "form-field key-field" }, [el("span", { text: t("providers.apiKey") }), el("div", { class: "key-control" }, [keyInput, showKey]), el("small", { text: t("providers.keyHelp") })]) : null,
    isCustom ? inputRow(t("providers.wire"), formatSelect, t("providers.formatHelp")) : null,
    customUrlRow,
    ...chatgptFields,
    !isChatgpt ? probeButton : null,
    result,
    modelArea,
    el("label", { class: "check picker-check" }, [pickerInput, el("span", { text: t("providers.showInPicker") })]),
    pickerModeOn() ? null : hint(t("providers.pickerOffHint")),
    advanced,
  ]);
  function readHeaders() {
    const headers = {};
    const kind = keyInput.dataset.headerKind || headerKind;
    const key = keyInput.value.replace(/^\s*bearer\s+/i, "").replace(/\s+/g, "");
    if (key) {
      if (kind === "authorization-bearer") headers.authorization = `Bearer ${key}`;
      else headers["x-api-key"] = key;
    } else if (existingKey) {
      if (kind === "authorization-bearer") headers.authorization = currentHeaders.authorization;
      else headers["x-api-key"] = currentHeaders["x-api-key"];
    }
    const rawHeaders = advancedContent._extraHeaders && advancedContent._extraHeaders.value;
    for (const line of String(rawHeaders || "").split("\n")) {
      const at = line.indexOf(":");
      if (at > 0 && line.slice(0, at).trim()) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    return headers;
  }
  function draftProvider() {
    if (isChatgpt) {
      const chat = advancedContent._chatgpt;
      return { type: "chatgpt", auth: chat.auth.value, defaultEffort: chat.effort.value, identity: chat.identity.checked, ...(chat.append.value.trim() ? { instructionsAppend: chat.append.value.trim() } : {}) };
    }
    const prompt = advancedContent._prompt;
    return {
      type: openAiNow() ? "openai-compatible" : "anthropic-compatible",
      url: urlInput.value.trim(),
      ...(prompt ? { identity: prompt.identity.checked } : {}),
      ...(prompt && prompt.append.value.trim() ? { instructionsAppend: prompt.append.value.trim() } : {}),
      ...(preset ? { preset: preset.id } : {}),
      // A vendor that asks for a session header keys its prompt cache on it, so carry it from the
      // preset rather than leaving the user to discover the bill.
      ...(preset && preset.sessionHeader ? { sessionHeader: preset.sessionHeader } : {}),
      ...(openAiNow() ? { wire: wireNow(), caps: { effortLevels: (preset && preset.effortLevels) || [], reasoning: preset && preset.effortLevels && preset.effortLevels.length ? "effort" : "none" } } : {}),
      ...(Object.keys(readHeaders()).length ? { headers: readHeaders() } : {}),
    };
  }
  function probeDraft() {
    const d = draftProvider();
    if (preset) { d.modelsUrl = preset.modelsUrl; d.modelsAuthHeader = preset.modelsAuthHeader; d.probeModel = (preset.fallbackModels || [])[0] && preset.fallbackModels[0].id; }
    // With nothing to list models from, test with a model the user ticked rather than a made-up id
    // the provider is bound to refuse.
    else {
      const ticked = modelArea.querySelector(".model-picker").selected();
      if (ticked.length) d.probeModel = ticked[0].id;
      // OpenAI-compatible APIs list their models beside the endpoints, so a hand-entered one need
      // not have every id typed in.
      if (d.type === "openai-compatible" && d.url) d.modelsUrl = `${d.url.replace(/\/+$/, "")}/models`;
    }
    return d;
  }
  async function runProbe() {
    const draft = probeDraft();
    if (!draft.url || !/^https?:\/\//.test(draft.url)) { toast(t("providers.urlRequired"), true); return; }
    probeButton.disabled = true;
    result.textContent = t("providers.checking");
    const temporary = `__new_${Date.now()}`;
    const response = await probeProvider(temporary, draft);
    probeButton.disabled = false;
    const noCredits = response.ok && /^no-credits:/.test(response.error || "");
    const headline = noCredits ? t("providers.probeNoCredits") : response.ok ? t("providers.probeOk") : response.auth === "not-entitled" ? t("providers.probeNotEntitled") : response.auth === "bad-key" ? t("providers.probeBadKey") : response.unavailable ? t("providers.apiSoon") : t("providers.probeFailed");
    result.replaceChildren(...[
      el("span", { class: response.ok && !noCredits ? "ok-text" : noCredits ? "warn-text" : "bad-text", text: headline }),
      response.error ? el("div", { class: "small", text: response.error.replace(/^no-credits:\s*/, "") }) : null,
    ].filter(Boolean));
    const listed = Boolean(response.models && response.models.length);
    const ticked = modelArea.querySelector(".model-picker").selected();
    foundModels = listed ? response.models.map((model) => typeof model === "string" ? { id: model, name: model } : model) : (preset ? (preset.fallbackModels || []) : foundModels);
    const keep = existing || foundModels.length > 12 ? new Set([...currentChecked, ...ticked.map((m) => m.id)]) : new Set(foundModels.map((model) => model.id));
    // Saved picks that the provider no longer lists stay visible and ticked so nothing is dropped silently.
    for (const saved of modelsOf(existing)) if (keep.has(saved.id) && !foundModels.some((m) => m.id === saved.id)) foundModels = [saved, ...foundModels];
    // So do ids typed in before the test: the provider's list replacing them would undo the typing.
    for (const typed of ticked) if (!foundModels.some((m) => m.id === typed.id)) { foundModels = [typed, ...foundModels]; keep.add(typed.id); }
    modelArea.querySelector(".model-picker").replaceWith(modelChecklist(foundModels, keep, checklistOptions));
    const listHint = listed ? (foundModels.length > 12 ? t("providers.modelsFoundMany") : t("providers.modelsFound")) : preset ? t("providers.modelsFallback") : t("providers.customModelHint");
    modelArea.replaceChildren(el("span", { text: t("providers.models") }), hint(listHint), modelArea.querySelector(".model-picker") || document.createTextNode(""));
  }
  probeButton && probeButton.addEventListener("click", runProbe);
  // Editing a provider that can list models: fetch the full list right away so the saved picks are
  // shown among everything available, not as a two-entry list.
  if (existing && !isChatgpt && preset && preset.modelsUrl && existingKey) setTimeout(() => void runProbe(), 0);
  // ChatGPT has no key field and no probe button, so without this the list stayed the built-in
  // fallback and a model OpenAI shipped after this release never appeared. Ask the backend for its
  // catalogue in the background: ticks survive, new models arrive unticked, and a failure just
  // leaves the fallback list standing.
  let formActive = true;
  if (isChatgpt) {
    const chat = advancedContent._chatgpt;
    void (async () => {
      let response;
      try {
        response = await api("/api/providers/probe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "chatgpt", auth: chat.auth.value, name: options.name }),
        });
      } catch { return; }
      if (!formActive || !Array.isArray(response.models) || !response.models.length) return;
      // Captured while the fetched list is checked, not against the fallback it is about to replace.
      const keep = new Set([...currentChecked, ...modelArea.querySelector(".model-picker").selected().map((model) => model.id)]);
      // A model the catalogue no longer lists but the config still names stays visible and ticked,
      // so a save cannot drop it silently.
      const named = new Set(response.models.map((model) => model.id));
      foundModels = [...response.models, ...foundModels.filter((saved) => !named.has(saved.id))];
      modelArea.querySelector(".model-picker").replaceWith(modelChecklist(foundModels, keep));
      modelArea.replaceChildren(
        el("span", { text: t("providers.models") }),
        hint(t("providers.modelsHelp")),
        hint(t("providers.modelsFoundLive", { n: response.models.length })),
        modelArea.querySelector(".model-picker"),
      );
    })();
  }
  const saveButton = el("button", { class: "btn", type: "button", "data-default-action": "", text: existing ? t("common.save") : t("providers.add") });
  saveButton.addEventListener("click", async () => {
    const typedName = nameInput.value.trim();
    if (!typedName) { toast(t("providers.nameRequired"), true); return; }
    const provider = draftProvider();
    if (!isChatgpt && (!provider.url || !/^https?:\/\//.test(provider.url))) { toast(t("providers.urlRequired"), true); return; }
    const next = clone(await latestConfig());
    const providerName = existing ? options.name : uniqueName(typedName, next.providers);
    const saved = existing && (next.providers[options.name] || existing);
    if (existing && providerName !== options.name) delete next.providers[options.name];
    const checkedModels = withSavedModelFields(form.querySelector(".model-picker").selected(), saved);
    provider.models = checkedModels;
    // The form rebuilds the provider from its own fields, so anything it has no field for
    // (debugDump, a hand-written setting) is carried over from the saved one rather than dropped.
    // A field the form owns is left to the draft, so clearing it in the form still clears it.
    const formKeys = new Set(isChatgpt
      ? ["type", "auth", "defaultEffort", "identity", "instructionsAppend", "models"]
      : ["type", "url", "identity", "instructionsAppend", "preset", "sessionHeader", "wire", "caps", "headers", "models"]);
    const kept = saved ? Object.fromEntries(Object.entries(saved).filter(([key]) => !formKeys.has(key))) : {};
    next.providers[providerName] = { ...kept, ...provider };
    // Read after `next.providers` has been updated, so an unticked model is already undeclared here
    // and falls out on its own, and a renamed provider answers to its new name.
    const existingSelections = pickerSelectionsExcept(next, providerName);
    if (pickerInput.checked) {
      applyPickerSelections(next, [...existingSelections, ...checkedModels.map((model) => ({ ...model, provider: providerName }))]);
    } else {
      applyPickerSelections(next, existingSelections);
    }
    saveButton.disabled = true;
    try {
      await configRequest(next);
      currentConfig = next;
      selectedProviderName = providerName;
      providerDetailTab = "overview";
      slotsLoaded = false;
      providersLoaded = false;
      closeModal();
      await loadProviders();
      toast(t("common.saved"));
      await offerPickerOn(pickerInput.checked && checkedModels.length > 0);
      // Detached on purpose. Measuring asks every ticked model several questions, which is far
      // longer than a save should take, and a model whose wire is still unknown works exactly as it
      // did before — it is only unmeasured. The result lands in the config when it arrives.
      void startMeasurement(providerName, next.providers[providerName]);
    } catch (error) {
      toast(t("common.saveFailed"), true, error.message);
    } finally { saveButton.disabled = false; }
  });
  form.appendChild(el("div", { class: "actions end" }, [el("button", { class: "btn secondary", type: "button", text: t("common.cancel"), onclick: closeModal }), saveButton]));
  showModal(form, () => { if (isChatgpt) formActive = false; });
}

// ---- ClaudeRipple mod ---------------------------------------------------------------
//
// The mod's settings live in the router (GET/PUT /api/mod-settings); the ⚙ panel in the bar edits
// the same object. As in System Settings a change applies itself: it is saved after a short pause
// with the revision it was made on. A 409 means another surface saved first — its settings are
// shown and the change made here is dropped, rather than quietly overwriting theirs.

const MOD_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// The band's parts the person can turn off (`hide`), then the ones it shows only when turned on
// (`extras`, as the mod's settings.ts EXTRAS): the judge's reason is in the effort's tip alone.
const MOD_PARTS = ["timer", "route"];
const MOD_EXTRAS = ["context", "limits"];
// Named in themselves, as the mod's own Look card lists them.
const MOD_LANGUAGES = [["ko", "한국어"], ["en", "English"], ["zh", "简体中文"], ["ja", "日本語"], ["es", "Español"], ["pt", "Português"]];
// Claude Code's own agent with a model: what the mod offers besides the generated workers, smallest
// first, and their current model ids (packages/mod/hooks/settings.ts CLAUDE_WORKERS).
const MOD_CLAUDE_MODELS = ["haiku", "sonnet", "opus", "fable"];
const MOD_CLAUDE_IDS = { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5", fable: "claude-fable-5-1" };
// The four workers, low to max (the mod's rung ids: light, standard, hard, plan).
const MOD_RUNGS = ["light", "standard", "hard", "plan"];
const modClaude = (model, effort) => ({ target: { agent: "general-purpose", model }, effort });
/** The mod's defaults (packages/mod/hooks/settings.ts), for a router that has stored nothing yet. */
const MOD_DEFAULTS = {
  effortAuto: true, judge: "haiku", judgeModel: "deepseek-v4.1-flash", jevSource: "typesafe",
  bias: 0, floor: "low", ceiling: "max", agentAuto: "auto",
  rules: {
    general: { mode: "ladder", rungs: {
      light: [{ target: { agent: "deepseek-v4-1-flash" }, effort: "max" }], standard: [{ target: { agent: "gpt-6-1-sol" }, effort: "medium" }],
      hard: [{ target: { agent: "gpt-6-astra" }, effort: "high" }], plan: [modClaude("opus", "high")],
    } },
  },
  allow: [], allowKnown: [], modes: [], providers: {},
  fallback: { agent: "general-purpose", model: "sonnet" },
  keepWarm: false, keepWarmHours: 2, keepWarmMinTokens: 30000,
  compactWith: "haiku", handoffSkill: "", handoffAfter: "continue", handoffButton: "advised",
  swampAt: 50, layout: "dashboard", appearance: "auto", language: "auto", hide: ["reason"], extras: [], setupDone: false,
};

let modState = { settings: null, revision: 0, options: null, retiredNote: false };
let modSaveTimer = null;
let modSaving = false;
let modSaveAgain = false;

/**
 * The router hands back the mod's full normalized settings; this only fills what an older router
 * (or an empty store) leaves out, so the page never draws a control over `undefined`. Fields this
 * page does not know are kept and sent back as they came.
 */
function modNormalize(raw) {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? clone(raw) : {};
  return {
    ...clone(MOD_DEFAULTS),
    ...value,
    rules: { ...clone(MOD_DEFAULTS.rules), ...(value.rules || {}) },
    allow: Array.isArray(value.allow) ? value.allow : [],
    allowKnown: Array.isArray(value.allowKnown) ? value.allowKnown : [],
    modes: Array.isArray(value.modes) ? value.modes : [],
    providers: { ...(value.providers || {}) },
    hide: Array.isArray(value.hide) ? value.hide : clone(MOD_DEFAULTS.hide),
  };
}

function modCap(text) { return text ? text.charAt(0).toLocaleUpperCase() + text.slice(1) : text; }
function modEffortName(effort) { return t(`mod.effort.${effort}`); }
function modSigned(n) { return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0"; }
function modTargetValue(target) { return target && target.agent ? (target.model ? `${target.agent}+${target.model}` : target.agent) : ""; }
function modTargetOf(value) {
  const plus = value.indexOf("+");
  return plus < 0 ? { agent: value } : { agent: value.slice(0, plus), model: value.slice(plus + 1) };
}
function modAgents() { return (modState.options && modState.options.agents) || []; }
function modProviderInfo(name) { return ((modState.options && modState.options.providers) || []).find((provider) => provider.name === name); }
function modModels() {
  const seen = new Set();
  return ((modState.options && modState.options.models) || []).filter((model) => !model.judgeOnly && !seen.has(model.model) && seen.add(model.model));
}

/** Rebuild a region in place, keeping keyboard focus on the control that had it. */
function modRedraw(root, nodes) {
  const active = document.activeElement;
  const key = active && root.contains(active) ? active.dataset.key : null;
  root.replaceChildren(...nodes.filter(Boolean));
  if (key) {
    const again = root.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (again) again.focus();
  }
}
function modSwitch(key, checked, label, onChange) {
  const input = el("input", { type: "checkbox", role: "switch", "data-key": key, "aria-label": label, checked });
  input.addEventListener("change", () => onChange(input.checked));
  return el("span", { class: "switch" }, [input, el("span")]);
}
function modSegmented(key, choices, value, label, onPick) {
  return el("div", { class: "segmented", role: "radiogroup", "aria-label": label }, choices.map((choice) => {
    const on = String(choice.value) === String(value);
    const button = el("button", { type: "button", class: on ? "active" : "", role: "radio", "aria-checked": String(on), "data-key": `${key}:${choice.value}`, text: choice.label, ...(choice.disabled ? { disabled: "" } : {}) });
    button.addEventListener("click", () => { if (!on) onPick(choice.value); });
    return button;
  }));
}
/** A pop-up menu. Items are `{value, label}` or `{group, items}`; a saved value no longer offered stays visible. */
function modSelect(key, items, value, label, onChange, cls) {
  const select = el("select", { "data-key": key, "aria-label": label, class: cls });
  const known = new Set();
  const add = (parent, item) => { known.add(String(item.value)); parent.appendChild(el("option", { value: item.value, text: item.label })); };
  for (const item of items) {
    if (!item.group) { add(select, item); continue; }
    if (!item.items.length) continue;
    const group = el("optgroup", { label: item.group });
    for (const entry of item.items) add(group, entry);
    select.appendChild(group);
  }
  if (!known.has(String(value))) select.appendChild(el("option", { value, text: `${value}${t("mod.unavailable")}` }));
  select.value = String(value);
  select.addEventListener("change", () => onChange(select.value));
  return select;
}
function modSection(title, rows, footers, action) {
  return el("section", { class: "section" }, [
    title || action ? el("div", { class: "section-head" }, [title ? el("h3", { class: "section-title", text: title }) : el("span"), action || null]) : null,
    el("div", { class: "group" }, rows.filter(Boolean)),
    ...(footers || []).filter(Boolean).map((footer) => typeof footer === "string" ? el("p", { class: "group-footer", text: footer }) : footer),
  ]);
}
function modCard(id, title, blurb, sections) {
  return el("section", { class: "mod-card", "aria-labelledby": `mod-card-${id}` }, [
    el("div", { class: "mod-card-head" }, [el("h2", { id: `mod-card-${id}`, text: title }), blurb ? el("p", { class: "hint", text: blurb }) : null]),
    ...sections.filter(Boolean),
  ]);
}
// ---- GPT Fast (one global value shared by every session and the Ripple bar)

let modFast = { value: null, revision: -1, status: "unavailable", writing: false, error: "" };
let modFastEpoch = 0;
let modFastReading = null;

function modFastReply(body) {
  if (!body || body.scope !== "global" || (body.fast !== null && typeof body.fast !== "boolean") || !Number.isSafeInteger(body.revision) || body.revision < 0) throw new Error(t("mod.fast.invalidReply"));
  return body;
}
function modFastAccept(body) {
  if (body.revision < modFast.revision) return;
  modFast = { ...modFast, value: body.fast, revision: body.revision, status: "ready", error: "" };
}
async function modFastRead() {
  if (modFastReading || modFast.writing) return;
  const epoch = modFastEpoch, token = {};
  modFastReading = token;
  try {
    const body = modFastReply(await api("/api/fast", { cache: "no-store", signal: AbortSignal.timeout(5000) }));
    if (epoch === modFastEpoch) modFastAccept(body);
  } catch (error) {
    if (epoch === modFastEpoch) modFast = { ...modFast, status: "unavailable", error: `${t("common.loadFailed")} ${error.message}` };
  } finally {
    if (modFastReading === token) modFastReading = null;
    if (epoch === modFastEpoch) modFastRenderState();
  }
}
async function modFastWrite(target) {
  if (modFast.writing || modFast.status !== "ready" || (target !== null && typeof target !== "boolean")) return;
  const epoch = ++modFastEpoch;
  const focused = document.activeElement;
  const focusKey = $("#mod-fast-control")?.contains(focused) ? focused.dataset.key : null;
  // A read started before this write cannot acknowledge (or fail) the new value.
  modFastReading = null;
  modFast = { ...modFast, writing: true, error: "" };
  modFastRenderState();
  try {
    const body = modFastReply(await api("/api/fast", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ fast: target }), signal: AbortSignal.timeout(5000) }));
    if (body.fast !== target || body.revision < modFast.revision) throw new Error(t("mod.fast.invalidReply"));
    if (epoch === modFastEpoch) modFastAccept(body);
  } catch (error) {
    // A timeout may have happened after persistence; keep the last acknowledgement, but mark it unknown until read back.
    if (epoch === modFastEpoch) modFast = { ...modFast, status: "unavailable", error: `${t("common.saveFailed")} ${error.message}` };
  } finally {
    if (epoch === modFastEpoch) {
      modFast = { ...modFast, writing: false };
      modFastRenderState();
      // Disabling a replaced button drops focus to body. Restore it after saving, but never steal
      // focus if the user moved elsewhere while the request was pending.
      if (focusKey && (!document.activeElement || document.activeElement === document.body)) {
        const root = $("#mod-fast-control");
        const button = root.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
        if (button && !button.disabled) button.focus();
        else root.focus(); // a failed save leaves every button disabled; keep keyboard users inside the card
      }
    }
  }
}
function modFastRenderState() {
  const root = $("#mod-fast-control");
  if (!root) return;
  const known = modFast.status === "ready";
  const selected = known ? String(modFast.value) : "unavailable";
  const label = t("mod.fast.title");
  const controlState = `${selected}:${modFast.writing}`;
  if (root.dataset.state !== controlState) {
    root.dataset.state = controlState;
    modRedraw(root, [modSegmented("session-fast", [
      { value: "null", label: "Auto" }, { value: "true", label: "ON" }, { value: "false", label: "OFF" },
    ].map(choice => ({ ...choice, disabled: !known || modFast.writing })), selected, label, value => void modFastWrite(value === "null" ? null : value === "true"))]);
  }
  const state = $("#mod-fast-status");
  state.textContent = modFast.writing ? t("slots.saving") : modFast.error || (known ? t("mod.fast.synced") : t("mod.fast.loading"));
  state.classList.toggle("bad-text", Boolean(modFast.error));
}
function modFastMount() {
  const root = $("#mod-fast");
  if (!root.firstChild) {
    root.replaceChildren(modCard("fast", t("mod.fast.title"), t("mod.fast.blurb"), [modSection(null, [
      cell(t("mod.fast.mode"), el("div", { id: "mod-fast-control", tabindex: "-1" }), el("span", { id: "mod-fast-status", class: "cell-sub", role: "status" }), "wide"),
    ], [t("mod.fast.help"), t("mod.fast.scope")])]));
  }
  modFastRenderState();
  void modFastRead();
}
function modFastPoll() {
  if (location.hash === "#mod" && !document.hidden) void modFastRead();
}
setInterval(modFastPoll, 3000);
window.addEventListener("focus", modFastPoll);
document.addEventListener("visibilitychange", modFastPoll);

// ---- Saving

function modStatus(text, isError) {
  const box = $("#mod-status");
  box.textContent = text;
  box.classList.toggle("bad-text", Boolean(isError));
}
function modPatch(change) {
  modState.settings = { ...modState.settings, ...change };
  modRefresh();
  clearTimeout(modSaveTimer);
  modStatus(t("slots.saving"));
  modSaveTimer = setTimeout(() => { modSaveTimer = null; void saveMod(); }, 450);
}
function modSetRule(domain, rule) { modPatch({ rules: { ...modState.settings.rules, [domain]: rule } }); }
async function saveMod() {
  if (modSaving) { modSaveAgain = true; return; }
  modSaving = true;
  try {
    const out = await api("/api/mod-settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, settings: modState.settings, revision: modState.revision }) });
    modState.revision = Number(out.revision) || modState.revision + 1;
    // The router's copy is the normalized one; take it unless a newer change is already waiting.
    if (out.settings && !modSaveTimer && !modSaveAgain) { modState.settings = modNormalize(out.settings); modRefresh(); }
    modStatus(t("mod.saved"));
  } catch (error) {
    if (error.status === 409 && error.body && "settings" in error.body) {
      clearTimeout(modSaveTimer);
      modSaveTimer = null;
      modSaveAgain = false;
      modState.settings = modNormalize(error.body.settings);
      modState.revision = Number(error.body.revision) || 0;
      modRefresh();
      modStatus(t("mod.conflict"), true);
      toast(t("mod.conflict"), true);
    } else {
      modStatus(`${t("common.saveFailed")} ${error.message}`, true);
    }
  } finally {
    modSaving = false;
    if (modSaveAgain) { modSaveAgain = false; void saveMod(); }
  }
}
async function loadMod() {
  modFastMount();
  // A change still on its way would be overwritten by what the router holds now.
  if (modSaveTimer || modSaving) return;
  let retired = false;
  const [settingsResult, optionsResult] = await Promise.allSettled([api("/api/mod-settings"), api("/api/mod-options")]);
  if (settingsResult.status === "rejected") {
    if (!modState.settings) {
      $("#mod-content").replaceChildren(modSection(null, [el("div", { class: "cell-note bad-text", text: `${t("common.loadFailed")} ${settingsResult.reason.message}` })]));
      return;
    }
  } else {
    modState.settings = modNormalize(settingsResult.value.settings);
    modState.revision = Number(settingsResult.value.revision) || 0;
    retired = settingsResult.value.legacy === true;
  }
  modState.options = optionsResult.status === "fulfilled" ? optionsResult.value : null;
  await modLoadResets();
  if (retired) modState.retiredNote = true;
  modRefresh();
  // The settings came back without Auto and the field rules; saving them as they are keeps the note to this once.
  if (retired) modPatch({});
}
function modRefresh() {
  if (!modState.settings) return;
  renderModNotice();
  modRedraw($("#mod-content"), [modEffortCard(), modWorkersCard(), modJudgeCard(), modCacheCard(), modHandoffCard(), modLookCard()]);
}
/** Settings for a mod that is switched off do nothing until it is on; the switch lives in Clients. */
function renderModNotice() {
  const box = $("#mod-notice");
  const off = Boolean(status) && !status.statusMod;
  if (box.dataset.state === String(off)) return;
  box.dataset.state = String(off);
  box.hidden = !off;
  box.replaceChildren(...(off ? [el("div", { class: "group" }, [cell(
    el("span", { class: "cell-label", text: t("mod.offNotice", { clients: t("nav.clients") }) }),
    el("button", { class: "btn secondary compact", type: "button", text: t("nav.clients"), onclick: () => showView("clients") }),
  )])] : []));
}

// ---- Cards

function modEffortCard() {
  const s = modState.settings;
  const efforts = MOD_EFFORTS.map((effort) => ({ value: effort, label: modEffortName(effort) }));
  const range = el("input", { type: "range", class: "lean-range", min: "-2", max: "2", step: "1", value: String(s.bias), "data-key": "bias", "aria-label": t("mod.lean"), "aria-valuetext": modSigned(s.bias) });
  range.addEventListener("change", () => modPatch({ bias: Number(range.value) }));
  const lean = el("div", { class: "lean" }, [
    el("span", { class: "lean-end", text: t("mod.cheaper") }),
    el("div", { class: "lean-track" }, [range, el("div", { class: "lean-ticks", "aria-hidden": "true" }, [-2, -1, 0, 1, 2].map(() => el("span")))]),
    el("span", { class: "lean-end", text: t("mod.smarter") }),
  ]);
  const inverted = MOD_EFFORTS.indexOf(s.ceiling) < MOD_EFFORTS.indexOf(s.floor);
  return modCard("effort", t("mod.effort"), t("mod.effortBlurb"), [modSection(null, [
    cell(t("mod.auto"), modSwitch("effort-auto", s.effortAuto, t("mod.auto"), (on) => modPatch({ effortAuto: on })), modCap(t("mod.autoHint"))),
    cell(t("mod.lean"), lean, modCap(t("mod.leanHint")), "wide"),
    cell(t("mod.floor"), modSelect("floor", efforts, s.floor, t("mod.floor"), (floor) => modPatch({ floor }), "narrow")),
    cell(t("mod.ceiling"), modSelect("ceiling", efforts, s.ceiling, t("mod.ceiling"), (ceiling) => modPatch({ ceiling }), "narrow"), inverted ? el("span", { class: "cell-sub warn-text", text: modCap(t("mod.floorWins")) }) : null),
  ])]);
}

// ---- The four workers (docs/specs/2026-10-12-worker-tiers.md)

/**
 * Everything a worker can run: the router's workers (each with its model's effort ladder and how it
 * is paid for), Claude Code's own agent on each Claude model, and the session's own model.
 */
function modChoices() {
  const options = modState.options || {};
  const claudeEfforts = Array.isArray(options.claudeEfforts) && options.claudeEfforts.length ? options.claudeEfforts : ["low", "medium", "high", "xhigh", "max"];
  const workers = modAgents().map((agent) => {
    const info = modProviderInfo(agent.provider);
    return {
      value: agent.name, label: agent.model, model: agent.model, provider: agent.provider,
      billing: /(?::|-)free$/i.test(agent.model) ? "free" : agent.billing || (info && info.billing) || null,
      usable: !info || info.usable !== false,
      efforts: Array.isArray(agent.efforts) ? agent.efforts : effortLevelsFor(agent.provider, agent.model),
    };
  });
  const claude = MOD_CLAUDE_MODELS.map((alias) => ({
    value: `general-purpose+${alias}`, label: `Claude ${modCap(alias)}`, model: MOD_CLAUDE_IDS[alias], provider: "anthropic",
    billing: "subscription", usable: true, efforts: claudeEfforts, claude: true,
  }));
  const session = { value: "general-purpose", label: t("mod.sessionModel"), model: null, provider: null, billing: null, usable: true, efforts: claudeEfforts, claude: true };
  return [...workers, ...claude, session];
}
function modChoiceOf(target) { const value = modTargetValue(target); return modChoices().find((choice) => choice.value === value); }
/** The efforts a model takes, in the mod's terms; an unknown ladder offers them all. */
function modLadderOf(choice) {
  const levels = choice && Array.isArray(choice.efforts) ? choice.efforts.filter((effort) => MOD_EFFORTS.includes(effort)) : [];
  return levels.length ? levels : [...MOD_EFFORTS];
}
/** The nearest effort a model takes, ties going up: how the router clamps one (compat.ts). */
function modNearest(effort, ladder) {
  if (ladder.includes(effort)) return effort;
  const at = MOD_EFFORTS.indexOf(effort);
  return ladder.reduce((best, next) => {
    const d = Math.abs(MOD_EFFORTS.indexOf(next) - at);
    const bd = Math.abs(MOD_EFFORTS.indexOf(best) - at);
    return d < bd || (d === bd && MOD_EFFORTS.indexOf(next) > MOD_EFFORTS.indexOf(best)) ? next : best;
  });
}
/** The group a model sits in: its provider, Claude's own together. */
function modGroupName(choice) { return choice.claude ? "Claude" : choice.provider; }
/** Choices in provider groups, each group tagged free / pay-per-token / subscription. */
function modGroups(choices) {
  const groups = [];
  for (const choice of choices) {
    const name = modGroupName(choice);
    let group = groups.find((entry) => entry.name === name);
    if (!group) { group = { name, billing: choice.billing, items: [] }; groups.push(group); }
    group.items.push(choice);
  }
  return groups;
}
function modGroupLabel(group) { return group.billing ? `${group.name} · ${t(`mod.billing.${group.billing}`)}` : group.name; }

// ---- The models to use: what the four workers are filled from and may run on

/** An allow-list key: a worker's agent name, or `general-purpose:<model>` for Claude's own. */
function modTickKey(choice) { return choice.claude ? choice.value.replace("+", ":") : choice.value; }
/** The models that can be ticked: every worker and Claude's own; the session's model is always there. */
function modTickable() { return modChoices().filter((choice) => choice.value !== "general-purpose"); }
/** Whether a model is ticked: an empty list means every model, an old provider name ticks that provider's, and a model added after the list was last written (absent from `allowKnown`) ticks on. */
function modTicked(choice) {
  const allow = modState.settings.allow || [];
  const known = modState.settings.allowKnown || [];
  return !allow.length || allow.includes(modTickKey(choice)) || allow.includes(choice.provider) || known.length > 0 && !known.includes(modTickKey(choice));
}
/** Ticks one model; every model on again is stored as [], and the last one on cannot go off. */
function modTick(choice, on) {
  const all = modTickable();
  const known = all.map(modTickKey);
  const kept = new Set(all.filter((model) => modTicked(model)).map(modTickKey));
  if (on) kept.add(modTickKey(choice)); else kept.delete(modTickKey(choice));
  const allow = kept.size === known.length ? [] : known.filter((key) => kept.has(key));
  modPatch({ allow, allowKnown: allow.length ? known : [] });
}
function modTickRows() {
  const choices = modTickable();
  if (!choices.length) return [el("div", { class: "cell-note", text: t("mod.noModels") })];
  const onCount = choices.filter(modTicked).length;
  return modGroups(choices).map((group) => {
    const boxes = group.items.map((choice) => {
      const on = modTicked(choice);
      const input = el("input", { type: "checkbox", "data-key": `tick:${modTickKey(choice)}`, "aria-label": `${choice.label} · ${group.name}`, checked: on });
      if (on && onCount === 1) input.disabled = true;
      input.addEventListener("change", () => modTick(choice, input.checked));
      // A model paid differently from its group (a :free model on a paid provider) says so beside its name.
      const other = choice.billing && choice.billing !== group.billing ? el("span", { class: "model-effort-tag", text: t(`mod.billing.${choice.billing}`) }) : null;
      const off = choice.usable ? null : el("span", { class: "model-effort-tag warn-text", text: t("mod.notUsable") });
      return el("label", { class: "model-check", title: choice.model || choice.label }, [input, el("span", { text: choice.label }), other, off]);
    });
    return el("div", { class: "tick-group" }, [el("div", { class: "tick-head", text: modGroupLabel(group) }), el("div", { class: "model-checklist" }, boxes)]);
  });
}

// ---- The four workers: a meaning, the pick, and one menu to change it

/** The general ladder's rungs; the router fills any that are empty, so a missing one is only a failed load. */
function modRungs() {
  const general = modState.settings.rules.general;
  return general && general.mode === "ladder" && general.rungs ? general.rungs : {};
}
/** One menu of `model · effort` for the ticked models, effort limited to what each model takes; the session's model too. */
function modPickSelect(key, step, shown, label, onPick) {
  const choices = modChoices().filter((choice) => choice.value === "general-purpose" || modTicked(choice));
  const groups = modGroups(choices).map((group) => ({
    group: modGroupLabel(group),
    items: group.items.flatMap((choice) => modLadderOf(choice).map((effort) => ({ value: `${choice.value}|${effort}`, label: `${choice.label} · ${modEffortName(effort)}${choice.usable ? "" : t("mod.unavailableNow")}` }))),
  }));
  const current = step ? `${modTargetValue(step.target)}|${shown}` : "";
  const items = [...(step ? [] : [{ value: "", label: "—" }]), ...groups];
  // A pick that is not on offer now (its model unticked, or gone) keeps showing rather than a wrong neighbour.
  if (step && !groups.some((group) => group.items.some((item) => item.value === current))) {
    const choice = modChoiceOf(step.target);
    items.unshift({ value: current, label: `${choice ? choice.label : modTargetValue(step.target)} · ${modEffortName(shown)}${t("mod.unavailable")}` });
  }
  return modSelect(key, items, current, label, (value) => {
    if (!value) return;
    const bar = value.lastIndexOf("|");
    onPick(modTargetOf(value.slice(0, bar)), value.slice(bar + 1));
  }, "rung-model");
}
function modRungRows(mode) {
  const rungs = mode ? mode.rungs : modRungs();
  return MOD_RUNGS.map((rung) => {
    const steps = rungs[rung] || [];
    const name = t(`mod.rung.${rung}`);
    const save = (next) => {
      const updated = { ...rungs, [rung]: next };
      if (mode) modUpdateMode(mode.id, { rungs: updated });
      else modSetRule("general", { mode: "ladder", rungs: updated });
    };
    const rows = steps.map((step, index) => {
      const choice = modChoiceOf(step.target);
      const shown = modNearest(step.effort, modLadderOf(choice));
      const key = `worker:${mode ? mode.id : "base"}:${rung}:${index}`;
      const select = modPickSelect(key, step, shown, `${name} ${index + 1}`, (target, effort) => save(steps.map((item, at) => at === index ? { target, effort } : item)));
      const move = (delta) => { const next = [...steps]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; save(next); };
      const button = (suffix, text, label, disabled, onclick) => el("button", { type: "button", class: "btn secondary compact", "data-key": `${key}:${suffix}`, text, "aria-label": label, ...(disabled ? { disabled: "" } : {}), onclick });
      return el("li", { class: "rung-item" }, [
        select,
        el("div", { class: "rung-actions" }, [
          button("up", "↑", t("mod.modeMoveUp"), index === 0, () => move(-1)),
          button("down", "↓", t("mod.modeMoveDown"), index === steps.length - 1, () => move(1)),
          button("remove", "✕", t("common.remove"), steps.length <= 1, () => save(steps.filter((_, at) => at !== index))),
        ]),
        choice && !choice.usable ? el("small", { class: "warn-text", text: t("mod.rungUnusable") }) : null,
      ]);
    });
    const add = el("button", { type: "button", class: "btn secondary compact", "data-key": `worker-add:${mode ? mode.id : "base"}:${rung}`, text: t("mod.modeAddModel"), onclick: () => {
      const choice = modChoices().find((item) => item.value !== "general-purpose" && modTicked(item)) || modChoices().at(-1);
      save([...steps, { target: modTargetOf(choice.value), effort: modNearest("medium", modLadderOf(choice)) }]);
    } });
    return cell(el("span", { class: "cell-label strong", text: name }), el("div", { class: "rung-list" }, [el("ol", {}, rows), add]), modCap(t(`mod.rungHint.${rung}`)), "wide rung-row");
  });
}
/** Said once after settings that still held Auto or field rules are read: they became the four workers. */
function modRetiredNote() {
  const close = el("button", { class: "btn secondary compact", type: "button", "data-key": "retired-ok", text: t("common.close"), onclick: () => { modState.retiredNote = false; modRefresh(); } });
  return modSection(null, [cell(el("span", { class: "cell-label", text: t("mod.retired") }), close, null, "offer-row")]);
}
// ---- Operating modes (docs/specs/2026-10-12-worker-tiers.md "Operating modes")
//
// A tab edits a saved worker set; activation is always an explicit, separate action.
let modModeTab = "";
/** Providers a mode can end at the reset of, known now: ChatGPT ones, then Claude ('anthropic'). */
let modResetProviders = [];

/** Only actual future reset timestamps enable the option, never a provider type alone. */
function modQuotaKnown(accounts, binding = false) {
  return (accounts || []).some((account) => {
    if (account.state === "paused" || account.state === "needs-login") return false;
    const quota = account.quota || {};
    const windows = Object.values(quota.rate_limits || {}).filter(Boolean);
    const selected = binding ? windows.sort((a, b) => (b.used_percent || 0) - (a.used_percent || 0)).slice(0, 1) : windows;
    return selected.some((window) => {
      if (!window) return false;
      const at = typeof window.reset_at === "number" ? window.reset_at * (window.reset_at > 1e12 ? 1 : 1000)
        : typeof window.reset_after_seconds === "number" && typeof quota.at === "number" ? quota.at + window.reset_after_seconds * 1000 : NaN;
      return Number.isFinite(at) && at > Date.now();
    });
  });
}
async function modLoadResets() {
  const providers = (modState.options && modState.options.providers) || [];
  const chatgpt = await Promise.all(providers.filter((provider) => provider.type === "chatgpt").map(async (provider) => {
    try {
      const body = await api(`/api/chatgpt-accounts?provider=${encodeURIComponent(provider.name)}`);
      return body.provider === provider.name && modQuotaKnown(body.accounts) ? [provider.name] : [];
    } catch (error) { console.warn("Mode quota unavailable", provider.name, error.message); return []; }
  }));
  // The mod reads Claude's reset from the band's binding limit, under the name 'anthropic'.
  const claude = providers.some((provider) => provider.type === "anthropic") && modQuotaKnown(status && status.claude && status.claude.accounts, true);
  modResetProviders = [...chatgpt.flat(), ...(claude ? ["anthropic"] : [])];
}
/** The name a reset provider goes by: Claude, ChatGPT, or another ChatGPT provider's own name. */
function modResetLabel(provider) {
  return provider === "anthropic" ? "Claude" : provider === "chatgpt" ? "ChatGPT" : provider;
}
/** Choosing reset starts on a known provider the mode's workers use, else the first known one. */
function modResetDefault(rungs) {
  const used = new Set(Object.values(rungs).flatMap((steps) => steps.map((step) => { const choice = modChoiceOf(step.target); return choice && choice.provider; })));
  return modResetProviders.find((provider) => used.has(provider)) || modResetProviders[0];
}
function modUpdateMode(id, change) {
  modPatch({ modes: modState.settings.modes.map((mode) => mode.id === id ? { ...mode, ...change } : mode) });
}
function modSetActive(id) {
  // The start time is when a mode that runs until the quota resets counts its reset from.
  modPatch(id ? { activeMode: id, activeSince: Date.now() } : { activeMode: undefined, activeSince: undefined });
}
function modRemoveMode(mode) {
  if (!confirm(t("mod.modeRemoveConfirm", { name: mode.name }))) return;
  const s = modState.settings;
  modPatch({ modes: s.modes.filter((entry) => entry.id !== mode.id), ...(s.activeMode === mode.id ? { activeMode: undefined, activeSince: undefined } : {}) });
}
function modModeTabs() {
  const s = modState.settings;
  const tabs = [{ id: "", name: t("mod.modeNone") }, ...s.modes];
  if (!tabs.some((tab) => tab.id === modModeTab) && modModeTab !== "+") modModeTab = "";
  const buttons = tabs.map((tab) => {
    const on = (s.activeMode || "") === tab.id;
    return el("button", { type: "button", role: "tab", class: modModeTab === tab.id ? "active" : "", "aria-selected": String(modModeTab === tab.id), "aria-controls": "worker-tab-panel", "data-key": `mode-tab:${tab.id || "base"}`, onclick: () => { modModeTab = tab.id; modRefresh(); } }, [
      el("span", { text: tab.name }), on ? el("span", { class: "mode-on", text: t("mod.modeOn") }) : null,
    ]);
  });
  buttons.push(el("button", { type: "button", role: "tab", "aria-selected": String(modModeTab === "+"), "data-key": "mode-add", text: t("mod.modeAdd"), ...(s.modes.length >= 20 ? { disabled: "" } : {}), onclick: () => { modModeTab = "+"; modRefresh(); } }));
  return el("div", { class: "mode-tabs", role: "tablist", "aria-label": t("mod.modes") }, buttons);
}
function modNewMode() {
  const input = el("input", { type: "text", class: "text-field", maxlength: "40", "data-key": "mode-new-name", "aria-label": t("mod.modeName"), placeholder: t("mod.modeName") });
  const add = () => {
    const name = input.value.trim();
    if (!name) { toast(t("mod.modeNameRequired"), true); input.focus(); return; }
    const mode = { id: `mode-${crypto.randomUUID()}`, name, rungs: clone(modRungs()), delegation: "normal", until: "none" };
    modModeTab = mode.id;
    modPatch({ modes: [...modState.settings.modes, mode] });
  };
  input.addEventListener("keydown", (event) => { if (event.key === "Enter") add(); });
  return modSection(t("mod.modeAddTitle"), [cell(t("mod.modeName"), [input, el("button", { type: "button", class: "btn compact", text: t("common.save"), "data-key": "mode-create", onclick: add })], t("mod.modeNameHelp"), "wide")]);
}
/** A datetime-local value for an epoch-ms time, in this browser's zone. */
function modLocalTime(ms) {
  const at = new Date(ms);
  const two = (n) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}`;
}
function modModeSection(mode) {
  const on = modState.settings.activeMode === mode.id;
  const name = el("input", { type: "text", class: "text-field", value: mode.name, maxlength: "40", "data-key": `mode-name:${mode.id}`, "aria-label": t("mod.modeName") });
  name.addEventListener("change", () => {
    if (!name.value.trim()) { name.value = mode.name; toast(t("mod.modeNameRequired"), true); return; }
    modUpdateMode(mode.id, { name: name.value.trim() });
  });
  const known = modResetProviders.length > 0;
  const kind = typeof mode.until === "number" ? "time" : mode.until && typeof mode.until === "object" ? "reset" : "none";
  const untilOf = (value) => value === "time" ? Date.now() + 3 * 3_600_000 : value === "reset" ? { reset: modResetDefault(mode.rungs) } : value;
  const until = modSegmented("mode-until", [
    { value: "none", label: t("mod.modeUntilNone") }, { value: "time", label: t("mod.modeUntilTime") },
    { value: "reset", label: t("mod.modeUntilResetChoice"), disabled: !known },
  ], kind, t("mod.modeUntil"), (value) => modUpdateMode(mode.id, { until: untilOf(value) }));
  const reset = until.querySelector('[data-key="mode-until:reset"]');
  if (!known) {
    reset.setAttribute("aria-describedby", "mode-reset-reason");
    until.appendChild(el("span", { id: "mode-reset-reason", class: "mode-reset-reason", text: t("mod.modeResetUnknown") }));
  }
  const endControls = [until];
  if (kind === "time") {
    const at = el("input", { type: "datetime-local", class: "text-field", "data-key": "mode-until-time", value: modLocalTime(mode.until), "aria-label": t("mod.modeUntilTime") });
    at.addEventListener("change", () => {
      const ms = new Date(at.value).getTime();
      if (!Number.isFinite(ms) || ms <= Date.now()) { at.value = modLocalTime(mode.until); toast(t("mod.modeTimePast"), true); return; }
      modUpdateMode(mode.id, { until: ms });
    });
    endControls.push(at);
  }
  if (kind === "reset") {
    // Only providers whose reset is known now; a saved one that is not stays shown as unavailable.
    const label = (provider) => t("mod.modeUntilResetOf", { provider: modResetLabel(provider) });
    const items = modResetProviders.map((provider) => ({ value: provider, label: label(provider) }));
    if (!modResetProviders.includes(mode.until.reset)) items.unshift({ value: mode.until.reset, label: `${label(mode.until.reset)}${t("mod.unavailable")}` });
    endControls.push(modSelect("mode-until-reset", items, mode.until.reset, t("mod.modeResetProvider"), (reset) => modUpdateMode(mode.id, { until: { reset } })));
  }
  const endHelp = kind === "reset" ? t("mod.modeResetHelp", { provider: modResetLabel(mode.until.reset) }) : null;
  return modSection(null, [
    cell(t("mod.modeName"), name),
    ...modRungRows(mode),
    cell(t("mod.modeDelegation"), modSegmented("mode-delegation", [{ value: "normal", label: t("mod.modeNormal") }, { value: "eager", label: t("mod.modeEager") }], mode.delegation, t("mod.modeDelegation"), (delegation) => modUpdateMode(mode.id, { delegation })), null, "wide"),
    cell(t("mod.modeUntil"), el("div", { class: "mode-until" }, endControls), endHelp, "wide"),
    cell(t("mod.modeActive"), [
      el("button", { type: "button", class: "btn compact", "data-key": "mode-toggle", text: t(on ? "mod.modeTurnOff" : "mod.modeTurnOn"), onclick: () => modSetActive(on ? "" : mode.id) }),
      el("button", { type: "button", class: "btn secondary compact", "data-key": `mode-remove:${mode.id}`, text: t("common.remove"), onclick: () => modRemoveMode(mode) }),
    ], on ? t("mod.modeOn") : null, "wide"),
  ]);
}

function modWorkersCard() {
  const s = modState.settings;
  return modCard("workers", t("mod.workers"), t("mod.workersBlurb"), [
    modState.options ? null : modSection(null, [el("div", { class: "cell-note warn-text", text: t("mod.optionsFailed") })]),
    modState.retiredNote ? modRetiredNote() : null,
    modSection(null, [
      cell(t("mod.takesOver"), modSegmented("agent-auto", [{ value: "off", label: t("mod.off") }, { value: "auto", label: "ripple:auto" }, { value: "all", label: t("mod.allSpawns") }], s.agentAuto, t("mod.takesOver"), (agentAuto) => modPatch({ agentAuto })), null, "wide"),
    ], [t("mod.takesOverHelp"), t("mod.takesOverHelp2")]),
    modModeTabs(),
    el("div", { id: "worker-tab-panel", role: "tabpanel" }, modModeTab === "+" ? [modNewMode()] : modModeTab ? [modModeSection(s.modes.find((mode) => mode.id === modModeTab))] : [
      modSection(t("mod.models"), modTickRows(), [t("mod.modelsHelp")]),
      modSection(t("mod.fourWorkers"), modRungRows(), [t("mod.modeOrderHelp")]),
      s.activeMode ? modSection(null, [cell(t("mod.modeActive"), el("button", { type: "button", class: "btn secondary compact", "data-key": "mode-base-on", text: t("mod.modeUseBase"), onclick: () => modSetActive("") }))]) : null,
    ].filter(Boolean)),
  ]);
}

function modJudgeCard() {
  const s = modState.settings;
  const zen = modState.options && modState.options.zen;
  const rows = [cell(t("mod.judge"), modSegmented("judge", [{ value: "haiku", label: t("mod.haiku") }, { value: "jev", label: t("mod.jev") }, { value: "model", label: t("mod.routerModel") }], s.judge, t("mod.judge"), (judge) => modPatch({ judge })), null, "wide")];
  const footers = [];
  if (s.judge === "haiku") rows.push(el("div", { class: "cell-note", text: t("mod.haikuHint") }));
  if (s.judge === "jev") {
    rows.push(cell(t("mod.jevSource"), modSegmented("jev-source", [{ value: "typesafe", label: t("mod.typesafe") }, { value: "zen", label: t("mod.zen") }], s.jevSource, t("mod.jevSource"), (jevSource) => modPatch({ jevSource })), null, "wide"));
    if (s.jevSource === "zen") {
      rows.push(zen && zen.configured
        ? cell(t("mod.model"), el("span", { class: "mono", text: zen.model }), modCap(t("mod.zenKey")))
        : cell(el("span", { class: "cell-label", text: modCap(t("mod.zenMissing")) }), el("button", { class: "btn secondary compact", type: "button", text: t("nav.providers"), onclick: () => showView("providers") }), t("mod.zenAdd")));
    } else {
      rows.push(el("div", { class: "cell-note", text: t("mod.jevKeyNote") }));
    }
  }
  if (s.judge === "model") {
    const models = modModels().map((model) => ({ value: model.model, label: `${model.name || model.model} · ${model.provider}` }));
    rows.push(cell(t("mod.model"), models.length || s.judgeModel
      ? modSelect("judge-model", models, s.judgeModel, t("mod.model"), (judgeModel) => modPatch({ judgeModel }))
      : el("span", { text: modCap(t("mod.noModels")) }), modCap(t("mod.haikuFallback"))));
  }
  return modCard("judge", t("mod.judge"), t("mod.judgeBlurb"), [modSection(null, rows, footers)]);
}

function modCacheCard() {
  const s = modState.settings;
  return modCard("cache", t("mod.cache"), t("mod.cacheBlurb"), [modSection(null, [
    cell(t("mod.keepWarm"), modSwitch("keep-warm", s.keepWarm, t("mod.keepWarm"), (keepWarm) => modPatch({ keepWarm })), modCap(t("mod.keepWarmHint"))),
    cell(t("mod.for"), modSegmented("warm-hours", [1, 2, 4, 8].map((n) => ({ value: n, label: t("mod.hours", { n }) })), s.keepWarmHours, t("mod.for"), (n) => modPatch({ keepWarmHours: Number(n) })), modCap(t("mod.afterReply")), "wide"),
    cell(t("mod.chatsFrom"), modSegmented("warm-min", [10000, 30000, 60000, 100000].map((n) => ({ value: n, label: `${n / 1000}k` })), s.keepWarmMinTokens, t("mod.chatsFrom"), (n) => modPatch({ keepWarmMinTokens: Number(n) })), modCap(t("mod.tokens")), "wide"),
  ], [t("mod.warmCost")])]);
}

function modHandoffCard() {
  const s = modState.settings;
  const skill = el("input", { type: "text", class: "text-field", value: s.handoffSkill, placeholder: t("mod.noSkill"), spellcheck: "false", autocomplete: "off", "data-key": "handoff-skill", "aria-label": t("mod.fullHandoff") });
  skill.addEventListener("change", () => modPatch({ handoffSkill: skill.value.trim() }));
  return modCard("handoff", t("mod.handoff"), t("mod.handoffBlurb"), [modSection(null, [
    cell(t("mod.compactWith"), modSegmented("compact-with", [{ value: "haiku", label: t("mod.haiku") }, { value: "session", label: t("mod.sessionCompactor") }], s.compactWith, t("mod.compactWith"), (compactWith) => modPatch({ compactWith })), null, "wide"),
    cell(t("mod.afterHandoff"), modSegmented("handoff-after", [{ value: "continue", label: t("mod.continue") }, { value: "confirm", label: t("mod.confirm") }, { value: "copy", label: t("mod.copy") }], s.handoffAfter, t("mod.afterHandoff"), (handoffAfter) => modPatch({ handoffAfter })), null, "wide"),
    cell(t("mod.handoffButton"), modSegmented("handoff-button", [{ value: "advised", label: t("mod.whenAdvised") }, { value: "always", label: t("mod.always") }], s.handoffButton, t("mod.handoffButton"), (handoffButton) => modPatch({ handoffButton })), null, "wide"),
    cell(t("mod.fullHandoff"), skill, null, "wide"),
    cell(t("mod.heavyAt"), modSegmented("swamp-at", [40, 50, 60, 70].map((n) => ({ value: n, label: `${n}%` })), s.swampAt, t("mod.heavyAt"), (n) => modPatch({ swampAt: Number(n) })), modCap(t("mod.context")), "wide"),
  ])]);
}

function modLookCard() {
  const s = modState.settings;
  const languages = [{ value: "auto", label: t("mod.auto") }, ...MOD_LANGUAGES.map(([value, label]) => ({ value, label }))];
  return modCard("look", t("mod.look"), t("mod.lookBlurb"), [
    modSection(null, [
      cell(t("mod.layout"), modSegmented("layout", [{ value: "dashboard", label: t("mod.dashboard") }, { value: "minimal", label: t("mod.minimal") }], s.layout, t("mod.layout"), (layout) => modPatch({ layout })), s.layout === "minimal" ? modCap(t("mod.footerHint")) : null, "wide"),
      cell(t("mod.appearance"), modSegmented("appearance", [{ value: "auto", label: t("mod.auto") }, { value: "dark", label: t("mod.dark") }, { value: "light", label: t("mod.lightAppearance") }], s.appearance, t("mod.appearance"), (appearance) => modPatch({ appearance })), null, "wide"),
      cell(t("mod.language"), modSelect("language", languages, s.language, t("mod.language"), (language) => modPatch({ language }), "narrow")),
    ]),
    modSection(t("mod.show"), [
      ...MOD_PARTS.map((part) => {
        const shown = !s.hide.includes(part);
        return cell(t(`mod.part.${part}`), modSwitch(`part:${part}`, shown, t(`mod.part.${part}`), (on) => modPatch({ hide: on ? s.hide.filter((entry) => entry !== part) : [...s.hide, part] })));
      }),
      ...MOD_EXTRAS.map((part) => {
        const extras = s.extras || [];
        const shown = extras.includes(part);
        return cell(t(`mod.part.${part}`), modSwitch(`part:${part}`, shown, t(`mod.part.${part}`), (on) => modPatch({ extras: on ? [...extras, part] : extras.filter((entry) => entry !== part) })));
      }),
    ]),
  ]);
}

// ---- Logs ---------------------------------------------------------------------------

let logsPanel = "requests";
let requestRows = [];
let knownRequestProviders = new Set();
let requestProvider = "";
let showCountTokens = false;
let expandedRequestId = null;

function colorizeLogLine(line) {
  const cls = /\bERROR\b|\berror\b/.test(line) ? "tag-ERR" : /\bWARN\b/.test(line) ? "tag-WARN" : "tag-PASS";
  return el("div", { class: cls, text: line });
}
function formatNumber(value) { return typeof value === "number" ? value.toLocaleString() : t("common.notAvailable"); }
function formatSeconds(ms) { return t("logs.seconds", { value: (Math.max(0, ms || 0) / 1000).toFixed(ms >= 10_000 ? 1 : 2) }); }
function timeOf(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.valueOf())) return t("common.notAvailable");
  const two = (n) => String(n).padStart(2, "0");
  return `${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
}
function providerClass(name) { return name === "anthropic" ? "provider-anthropic" : name === "chatgpt" ? "provider-chatgpt" : "provider-default"; }
function summaryChip(label, value, sub) { return el("div", { class: "logs-chip" }, [el("span", { class: "label", text: label }), el("span", { class: "value", text: value }), sub ? el("span", { class: "sub", text: sub }) : null]); }

function showLogsPanel(name) {
  logsPanel = name;
  const requests = name === "requests";
  $("#logs-requests-tab").classList.toggle("active", requests);
  $("#logs-raw-tab").classList.toggle("active", !requests);
  $("#logs-requests-tab").setAttribute("aria-selected", String(requests));
  $("#logs-raw-tab").setAttribute("aria-selected", String(!requests));
  $("#logs-requests-panel").hidden = !requests;
  $("#logs-raw-panel").hidden = requests;
  if (requests) void refreshRequests();
  else void refreshLogs();
}
$("#logs-requests-tab").addEventListener("click", () => showLogsPanel("requests"));
$("#logs-raw-tab").addEventListener("click", () => showLogsPanel("raw"));
$("#logs-provider").addEventListener("change", (event) => { requestProvider = event.target.value; void refreshRequests(); });

function renderSummary(summary) {
  const total = summary && summary.total || { count: 0, ok: 0, failed: 0, input: 0, cached: 0, output: 0, avgMs: 0, cacheHitPercent: 0 };
  $("#logs-summary").replaceChildren(
    summaryChip(t("logs.summary.requests"), formatNumber(total.count)),
    summaryChip(t("logs.summary.success"), `${formatNumber(total.ok)} / ${formatNumber(total.failed)}`),
    // On its own line: with the whole input counted the number runs to eight digits, and the
    // ellipsis on one line cut the cache rate off entirely.
    summaryChip(t("logs.summary.input"), formatNumber(totalInputOf(total)), t("logs.cacheHit", { percent: total.cacheHitPercent || 0 })),
    summaryChip(t("logs.summary.output"), formatNumber(total.output)),
    summaryChip(t("logs.summary.duration"), formatSeconds(total.avgMs)),
  );
}
function renderProviderFilter(records) {
  const select = $("#logs-provider");
  for (const record of records) if (record.provider) knownRequestProviders.add(record.provider);
  const names = [...knownRequestProviders].sort();
  const before = select.value;
  select.replaceChildren(el("option", { value: "", text: t("logs.all") }));
  for (const name of names) select.appendChild(el("option", { value: name, text: name }));
  select.value = names.includes(requestProvider) ? requestProvider : "";
  if (!names.includes(requestProvider)) requestProvider = "";
  if (before && before !== select.value) select.value = requestProvider;
}
/** Everything the model read: uncached, read from the cache, and written to it. */
function totalInputOf(usage) {
  return (usage.input || 0) + (usage.cached || 0) + (usage.cacheWrite || 0);
}
function requestFastBadge(record) {
  // Use request-scoped evidence, never today's settings or the free-form note. A requested
  // priority tier is not proof that the server served it (it can answer with default).
  if (record.kind === "count_tokens") return null;
  const served = record.servedTier === "priority";
  if (!served && record.requestedTier !== "priority") return null;
  const title = `${t("logs.detail.requestedTier")}: ${record.requestedTier || t("common.notAvailable")} · ${t("logs.detail.servedTier")}: ${record.servedTier || t("common.notAvailable")}`;
  return el("span", { class: `provider-badge fast-badge${served ? "" : " requested"}`, text: served ? "⚡ fast" : t("logs.fastRequested"), title });
}
function requestDetail(record) {
  const details = [
    [t("logs.detail.id"), record.id],
    [t("logs.detail.kind"), record.kind],
    [t("logs.detail.stop"), record.stopReason || t("logs.none")],
    [t("logs.detail.requestedTier"), record.requestedTier || t("common.notAvailable")],
    [t("logs.detail.servedTier"), record.servedTier || t("common.notAvailable")],
    [t("logs.detail.uncached"), record.usage ? formatNumber(record.usage.input) : t("logs.none")],
    [t("logs.detail.cacheRead"), record.usage && record.usage.cached ? formatNumber(record.usage.cached) : t("logs.none")],
    [t("logs.detail.cacheWrite"), record.usage && record.usage.cacheWrite ? formatNumber(record.usage.cacheWrite) : t("logs.none")],
  ].map(([label, value]) => el("div", {}, [el("span", { class: "detail-label", text: label }), el("span", { class: "detail-value", text: value })]));
  if (record.note) details.push(el("div", { class: "request-note" }, [el("span", { class: "detail-label", text: t("logs.detail.note") }), el("span", { class: "detail-value", text: record.note })]));
  return el("tr", { class: "request-detail" }, [el("td", { colspan: "7" }, [el("div", { class: "request-detail-grid" }, details)])]);
}
function requestRow(record) {
  const row = el("tr", { class: "request-row", title: record.note || "", onclick: () => { expandedRequestId = expandedRequestId === record.id ? null : record.id; renderRequests(requestRows); } });
  // The requested name's `@effort` is the agent file's default, not what was sent: a marker can
  // override it, and `gpt-6-sol@medium` beside an effort of high read as a contradiction
  // (2026-09-23). The effort column is the sent value, so the source is shown without it.
  const source = record.source ? record.source.replace(/@[^@]*$/, "") : "";
  const model = el("div", { class: "request-models" }, [
    el("span", { class: "model", text: record.target }),
    requestFastBadge(record),
    source && source !== record.target ? el("span", { class: "small", text: `(${source})` }) : null,
    el("span", { class: `provider-badge ${providerClass(record.provider)}`, text: record.provider }),
  ].filter(Boolean));
  // The whole input, not the uncached remainder: a fully cached Anthropic turn reports `input: 2`,
  // which read as a two-token request (2026-09-23). The split is in the detail row.
  const totalInput = record.usage ? totalInputOf(record.usage) : 0;
  const input = record.usage
    ? el("span", { class: "token-cell", text: formatNumber(totalInput) }, [el("span", { class: "cache-pill", text: t("logs.cacheHit", { percent: Math.round(record.usage.cached / Math.max(1, totalInput) * 100) }) })])
    : el("span", { class: "no-usage", text: t("common.notAvailable") });
  const status = record.resent
    ? el("span", { class: "status-text resent", text: `${t("logs.status.resent")} ${record.status}`, title: t("logs.status.resentHelp") })
    : el("span", { class: `status-text ${record.ok ? "ok" : "bad"}`, text: `${record.ok ? t("logs.status.ok") : t("logs.status.error")} ${record.status}` });
  // Column classes let a narrow window lay the same row out as a two-line list item.
  row.append(
    el("td", { class: "c-time", text: timeOf(record.at) }),
    el("td", { class: "c-model" }, [model]),
    el("td", { class: "c-effort", text: record.effort || t("common.notAvailable") }),
    el("td", { class: "c-in" }, [input]),
    el("td", { class: record.usage ? "c-out" : "c-out no-usage", text: record.usage ? formatNumber(record.usage.output) : t("common.notAvailable") }),
    el("td", { class: "c-dur", text: formatSeconds(record.ms) }),
    el("td", { class: "c-status" }, [status]),
  );
  return row;
}
function renderRequests(records) {
  const scroll = $(".logs-table-card");
  const left = scroll.scrollLeft;
  const tbody = $("#requests-table tbody");
  tbody.replaceChildren(...records.flatMap((record) => expandedRequestId === record.id ? [requestRow(record), requestDetail(record)] : [requestRow(record)]));
  $("#requests-table").closest(".logs-table-card").hidden = records.length === 0;
  $("#requests-empty").hidden = records.length !== 0;
  scroll.scrollLeft = left;
}
async function refreshRequests() {
  if (logsPanel !== "requests") return;
  try {
    const suffix = requestProvider ? `&provider=${encodeURIComponent(requestProvider)}` : "";
    const kind = "&kind=messages";
    const [records, summary, allRecords] = await Promise.all([api(`/api/requests?n=200${suffix}${kind}`), api("/api/requests/summary?since=3600"), api("/api/requests?n=200")]);
    requestRows = Array.isArray(records.requests) ? records.requests : [];
    renderProviderFilter(Array.isArray(allRecords.requests) ? allRecords.requests : requestRows);
    renderSummary(summary);
    renderRequests(requestRows);
  } catch { /* preserve the last successful request table */ }
}
async function refreshLogs() {
  if (logsPanel !== "raw") return;
  const box = $("#logbox");
  try {
    const response = await fetch("/api/logs?n=200");
    const text = await response.text();
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
    box.replaceChildren(...text.split("\n").filter(Boolean).map(colorizeLogLine));
    if ($("#logs-autoscroll").checked || nearBottom) box.scrollTop = box.scrollHeight;
  } catch { /* preserve the last contents */ }
}
void refreshRequests();
setInterval(() => { void refreshRequests(); void refreshLogs(); }, 3000);
