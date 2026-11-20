// The dashboard's way back from a missing Claude Desktop entry (2026-11-19): its own re-apply
// action, which posts /api/picker/reapply and never the switch's /api/picker (that runs `picker
// off`, removing the CA with a second Windows dialog), and a connection card that offers repair.
// The production functions run unchanged; only the browser boundaries are stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../../ui/app.js", import.meta.url), "utf8");
const slice = (from: string, to: string): string => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `app.js no longer has ${from}`);
  return source.slice(start, end);
};

type Call = { path: string; opts: { method?: string; body?: string } };
function reapplyHarness(fail?: { output: string }) {
  const calls: Call[] = [];
  const toasts: { message: string; error: boolean; detail?: string }[] = [];
  const msg = { textContent: "" };
  const buttons: { disabled: boolean }[] = [];
  let refreshes = 0;
  const ui = new Function("h", `
    const t = (key) => key;
    const el = (tag, attrs) => { const node = { tag, ...attrs, disabled: attrs.disabled === "" }; h.buttons.push(node); return node; };
    const $ = () => h.msg;
    const $all = () => h.buttons;
    const api = async (path, opts) => { h.calls.push({ path, opts }); if (h.fail) { const e = new Error("HTTP 500"); e.body = { ok: false, output: h.fail.output }; throw e; } return { ok: true }; };
    const toast = (message, error, detail) => h.toasts.push({ message, error: Boolean(error), detail });
    const refreshHealth = async () => { h.refreshes(); };
    let pickerBusy = false;
    ${slice("function pickerReapplyButton(key)", "async function toggleStatusMod(")}
    return { pickerReapplyButton, reapplyPicker, busy: () => pickerBusy };
  `)({ calls, toasts, msg, buttons, fail, refreshes: () => refreshes++ }) as { pickerReapplyButton(key: string): { text: string; onclick: () => void; "data-key": string }; reapplyPicker(): Promise<void>; busy(): boolean };
  return { ui, calls, toasts, msg, buttons, refreshes: () => refreshes };
}

test("the re-apply button posts /api/picker/reapply only and tells the person to restart Claude Desktop", async () => {
  const h = reapplyHarness();
  const button = h.ui.pickerReapplyButton("picker-reapply:clients");
  assert.equal(button.text, "picker.reapply");
  assert.equal(button["data-key"], "picker-reapply:clients", "named, so the five-second rebuild gives focus back");
  const running = h.ui.reapplyPicker();
  assert.equal(h.ui.busy(), true);
  assert.equal(h.buttons.every((b) => b.disabled), true, "every re-apply button is disabled while it runs");
  await h.ui.reapplyPicker(); // ignored while the first one runs
  await running;
  assert.deepEqual(h.calls.map((c) => [c.path, c.opts.method]), [["/api/picker/reapply", "POST"]]);
  assert.ok(!h.calls.some((c) => c.path === "/api/picker"), "never the switch's route");
  assert.deepEqual(h.toasts, [{ message: "picker.reapplyDone", error: false, detail: undefined }]);
  assert.equal(h.ui.busy(), false);
  assert.equal(h.refreshes(), 1);
});

test("a refused re-apply shows the CLI's reason, not a bare HTTP status", async () => {
  const h = reapplyHarness({ output: "✓ x\nerror: Claude is on its default connection (`clauderipple direct on`)\nCommand failed" });
  await h.ui.reapplyPicker();
  assert.deepEqual(h.toasts, [{ message: "common.actionFailed", error: true, detail: "Claude is on its default connection (`clauderipple direct on`)" }]);
});

test("readiness codes read as their own fix, and the connection card offers repair for a missing entry", () => {
  const ui = new Function(`
    const t = (key) => key;
    let routerDown = false;
    const status = { ok: true };
    ${slice("function readinessProblemText(code)", "function renderDiagnostics()")}
    ${slice("const CONN_REASONS = [", "const CONN_ACTIONS = {")}
    return { readinessProblemText, connectionModel };
  `)() as { readinessProblemText(code: string): string; connectionModel(s: unknown): { kind: string; primary: string | null; lead: string } };
  assert.equal(ui.readinessProblemText("picker-proxy"), "health.diagnosticPickerProxy");
  assert.equal(ui.readinessProblemText("picker-restart"), "health.diagnosticPickerRestart");

  const doctor = (codes: string[], mode = "mixed") => ({ doctor: { mode, desktop: { proxy: "none" }, cli: { proxy: "ripple" }, problems: codes.map((code) => ({ code, message: code })) } });
  const missing = ui.connectionModel(doctor(["desktop-entry-missing", "mixed-mode"]));
  assert.equal(missing.kind, "warn");
  assert.equal(missing.primary, "repair", "repair applies the entry again; the direct switch would not");
  assert.equal(missing.lead, "conn.why.desktopEntryMissing");
  // Without that problem a mixed state keeps its own card.
  assert.equal(ui.connectionModel(doctor(["mixed-mode"])).primary, "direct-off");
  assert.equal(ui.connectionModel(doctor(["desktop-entry-missing"], "direct")).kind, "direct", "direct on is chosen, not broken");

  // What repair leaves alone gets its own words and no primary action: the switch back would change
  // nothing with no direct snapshot, yet report success.
  for (const [code, lead] of [["desktop-entry-other", "conn.why.desktopEntryOther"], ["desktop-entry-unreadable", "conn.why.desktopEntryUnreadable"]]) {
    const card = ui.connectionModel(doctor([code!, "mixed-mode"]));
    assert.deepEqual([card.kind, card.primary, card.lead], ["warn", null, lead], code);
  }
});

test("the re-apply action is offered only where `picker reapply` would act, and a foreign entry is named", () => {
  const ui = new Function(`
    const t = (key) => key;
    let status = null;
    ${slice("function readinessProblemText(code)", "function renderDiagnostics()")}
    return { readinessProblemText, pickerReapplyOffered, pickerEntryForeign, set: (s) => { status = s; } };
  `)() as { readinessProblemText(code: string): string; pickerReapplyOffered(s: unknown): boolean; pickerEntryForeign(s: unknown): boolean; set(s: unknown): void };
  const at = (entry: unknown, problems: string[] = ["picker-proxy"]) => ({ picker: { enabled: true, entry }, readiness: { ready: false, problems } });
  assert.equal(ui.pickerReapplyOffered(at({ state: "missing", holder: null, reapply: true })), true);
  assert.equal(ui.pickerReapplyOffered(at({ state: "other", holder: "app", reapply: true })), true);
  assert.equal(ui.pickerReapplyOffered(at({ state: "other", holder: "installation", reapply: false })), false);
  assert.equal(ui.pickerReapplyOffered(at({ state: "other", holder: "hybrid", reapply: false })), false);
  assert.equal(ui.pickerReapplyOffered(at({ state: "missing", holder: null, reapply: false })), false, "direct on");
  assert.equal(ui.pickerReapplyOffered(at({ state: "missing", holder: null, reapply: true }, ["picker-ca", "picker-proxy"])), false, "an untrusted CA is refused; `picker on` is the fix");
  for (const holder of ["installation", "hybrid"]) {
    const s = at({ state: "other", holder, reapply: false });
    assert.equal(ui.pickerEntryForeign(s), true, holder);
    ui.set(s);
    assert.equal(ui.readinessProblemText("picker-proxy"), "health.diagnosticPickerForeign", holder);
  }
  ui.set(at({ state: "unknown", holder: null, reapply: false }));
  assert.equal(ui.pickerReapplyOffered(at({ state: "unknown", holder: null, reapply: false })), false);
  assert.equal(ui.readinessProblemText("picker-proxy"), "health.diagnosticPickerUnreadable", "an unreadable library is not 're-apply it'");
  ui.set(at({ state: "missing", holder: null, reapply: true }));
  assert.equal(ui.readinessProblemText("picker-proxy"), "health.diagnosticPickerProxy");
});

test("every dashboard language names the new picker problems and actions", () => {
  const translations = fs.readFileSync(new URL("../../ui/i18n.js", import.meta.url), "utf8");
  const dictionaries = new Function(`${translations.slice(0, translations.indexOf("const LANGUAGES"))}; return I18N;`)() as Record<string, Record<string, string>>;
  const keys = ["health.diagnosticPickerProxy", "health.diagnosticPickerRestart", "health.diagnosticPickerForeign", "health.diagnosticPickerUnreadable", "picker.reapply", "picker.reapplyHelp", "picker.reapplyDone", "conn.why.desktopEntryMissing", "conn.why.desktopEntryOther", "conn.why.desktopEntryUnreadable"];
  for (const [lang, table] of Object.entries(dictionaries)) {
    for (const key of keys) assert.ok(typeof table[key] === "string" && table[key]!.trim().length > 0, `${lang} ${key}`);
    // The missing-entry advice must not be the restart-only advice it replaced.
    assert.notEqual(table["health.diagnosticPickerProxy"], table["health.diagnosticPickerRestart"], lang);
  }
});
