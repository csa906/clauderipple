// Claude Desktop's Config Library entry gone while picker mode stays on (2026-11-19: a disk cleanup
// deleted %LOCALAPPDATA%\Claude-3p, Desktop logged "resolved (direct)" and the picker lost every
// routed model; readiness said "restart Claude Desktop", which could not help).
//
// SAFETY: nothing here reaches the real Claude-3p folder, ~/.claude/settings.json, a service manager
// or the live router. Every path is redirected into a temp dir before any module reads it, the
// supervisor is a fake and the router's status is injected.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cr-picker-entry-")));
Object.assign(process.env, {
  CLAUDERIPPLE_HOME: path.join(root, "unused-home"),
  CLAUDE_SETTINGS_PATH: path.join(root, "unused-settings.json"),
  CLAUDE_APP_SUPPORT: path.join(root, "unused-Claude-3p"),
  CLAUDERIPPLE_LAUNCH_AGENTS_DIR: path.join(root, "LaunchAgents"),
  CLAUDERIPPLE_LAUNCHER_DIR: path.join(root, "Applications"),
});
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

const { appliedIsMarked, applyAppProxy, appProxyOwner, appProxyState, configLibraryDir, currentAppProxy, ownsListedAppProxy, removeAppProxy, restoreMissingAppProxy } = await import("../src/picker.ts");
const { removeClientIntegrations } = await import("../src/integrations.ts");
const { directOff, directOn } = await import("../src/direct.ts");
const { applyProxyEnv, settingsEnv } = await import("../src/settings.ts");
const { doctor, repair } = await import("../src/doctor.ts");
const { normalizeHome } = await import("../src/ownership.ts");
type SupervisorOps = import("../src/registration.ts").SupervisorOps;
type SupervisorView = import("../src/registration.ts").SupervisorView;

const UUID = /^[a-f0-9-]{36}$/;
let n = 0;

/** A fresh home, settings.json and Config Library for one test, all under the temp root. */
function scratch(opts: { picker?: boolean; port?: number } = {}) {
  const dir = path.join(root, `t${++n}`);
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  const port = opts.port ?? 18791;
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ listen: { host: "127.0.0.1", port }, ...(opts.picker === false ? {} : { picker: { enabled: true } }) }));
  process.env.CLAUDE_SETTINGS_PATH = path.join(dir, "settings.json");
  process.env.CLAUDE_APP_SUPPORT = path.join(dir, "Claude-3p");
  process.env.CLAUDERIPPLE_HOME = home;
  return { dir, home, proxyUrl: `http://127.0.0.1:${port}`, lib: path.join(dir, "Claude-3p", "configLibrary") };
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}
function meta(): Record<string, unknown> {
  return readJson(path.join(configLibraryDir(), "_meta.json"));
}
/** Every file in the Config Library and its bytes: "untouched" means exactly this, before and after. */
function snapshotLibrary(): Record<string, string> {
  const dir = configLibraryDir();
  if (!fs.existsSync(dir)) return {};
  return Object.fromEntries(fs.readdirSync(dir).filter((f) => !f.endsWith(".lock")).sort().map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]));
}
/**
 * The contract Desktop 6.6395's Config Library editor relies on: an `entries` array, and a string
 * `appliedId` (its `listConfigs` reply fails validation without one, `VNt`) that is "" or a listed id.
 */
function assertDesktopEditorShape(m: Record<string, unknown>): void {
  assert.ok(Array.isArray(m.entries), "entries must be an array (the editor calls entries.map/.some/.push)");
  const entries = m.entries as { id?: unknown; name?: unknown }[];
  entries.map((entry) => ({ ...entry }));
  assert.equal(typeof m.appliedId, "string", "appliedId must be a string, \"\" for nothing applied");
  if (m.appliedId !== "") assert.ok(entries.some((entry) => entry.id === m.appliedId), "the applied id is listed");
}

function fakeSupervisor(view: Partial<SupervisorView> = {}, start: "already-running" | "started" | "failed" = "started") {
  const calls: string[] = [];
  const ops: SupervisorOps = {
    inspect: () => ({ registered: true, program: process.execPath, args: [], programExists: true, state: "running", pid: 1, current: true, installedHome: null, ...view }),
    register: () => { calls.push("register"); return "/fake/definition"; },
    start: () => { calls.push("start"); return start; },
  };
  return { ops, calls };
}
const answering = async (): Promise<{ version: string } | null> => ({ version: "1.0.0" });
const silent = async (): Promise<{ version: string } | null> => null;
const noSleep = async () => {};
// The CA check is a PowerShell/security child on a real machine: injected, trusted unless a test says otherwise.
const deps = (home: string, routerStatus = answering, supervisor = fakeSupervisor().ops, trusted = true) => ({ home, version: "1.0.0", supervisor, routerStatus, sleep: noSleep, healthBudgetMs: 0, remoteHostInstalled: () => false, caTrusted: () => trusted });
/** A Desktop "Default" entry applied, as Desktop's own editor leaves it. */
function desktopDefault(c: ReturnType<typeof scratch>, extra: Record<string, unknown> = {}): string {
  fs.mkdirSync(c.lib, { recursive: true });
  const def = crypto.randomUUID();
  fs.writeFileSync(path.join(c.lib, "_meta.json"), JSON.stringify({ appliedId: def, entries: [{ id: def, name: "Default" }], ...extra }));
  fs.writeFileSync(path.join(c.lib, `${def}.json`), "{}");
  return def;
}
/** What Desktop's editor does on Apply (mLi): switch appliedId, keep every other key. */
function desktopApplies(id: string): void {
  const m = meta();
  delete m.hybridPointer;
  fs.writeFileSync(path.join(configLibraryDir(), "_meta.json"), JSON.stringify({ ...m, appliedId: id }));
}
const HYBRID = { bootstrapUrl: "https://config.claude.com/bootstrap" };
/** What `off` leaves with nothing to hand back beside listed entries: those, plus a new empty "Default", applied. */
function assertSeededDefault(others: { id: string; name: string }[]): void {
  const m = meta() as { appliedId: string; entries: { id: string; name: string }[] };
  assert.match(m.appliedId, UUID);
  assert.deepEqual(m.entries, [...others, { id: m.appliedId, name: "Default" }]);
  assert.deepEqual(readJson(path.join(configLibraryDir(), `${m.appliedId}.json`)), {}, "no proxy: the app goes direct");
  assert.deepEqual(Object.keys(m).sort(), ["appliedId", "entries"]);
  assertDesktopEditorShape(m);
}
/** HOME, USERPROFILE, CODEX_HOME and XDG_CONFIG_HOME in the scratch dir for a test that runs direct on/off or uninstall. */
function isolateHome(t: { after(fn: () => void): void }, c: ReturnType<typeof scratch>): void {
  const keys = ["HOME", "USERPROFILE", "CODEX_HOME", "XDG_CONFIG_HOME"] as const;
  const saved = keys.map((k) => [k, process.env[k]] as const);
  Object.assign(process.env, { HOME: c.dir, USERPROFILE: c.dir, CODEX_HOME: path.join(c.dir, "codex"), XDG_CONFIG_HOME: path.join(c.dir, "xdg") });
  t.after(() => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

// ---- the _meta.json shape (defect 4) ------------------------------------------------------

test("a fresh Config Library gets Desktop's own shape: appliedId plus an entries list naming ours", () => {
  const c = scratch();
  assert.equal(fs.existsSync(c.lib), false);
  const r = applyAppProxy(c.proxyUrl, c.home);
  assert.match(r.id, UUID, "Desktop reads only ids of this shape");
  assert.equal(r.replaced, null);
  assert.equal(r.changed, true);
  const m = meta();
  assert.deepEqual(m, { appliedId: r.id, entries: [{ id: r.id, name: "ClaudeRipple" }], clauderipple: { ourId: r.id, previousAppliedId: null, installationHome: normalizeHome(c.home) } });
  assertDesktopEditorShape(m);
  assert.deepEqual(readJson(path.join(c.lib, `${r.id}.json`)), { egressProxyUrl: c.proxyUrl });
});

test("on beside Desktop's own entries keeps them; off restores the previous selection and every other entry", () => {
  const c = scratch();
  fs.mkdirSync(c.lib, { recursive: true });
  const def = crypto.randomUUID();
  const work = crypto.randomUUID();
  const desktopMeta = { appliedId: def, entries: [{ id: def, name: "Default" }, { id: work, name: "Work" }], somethingElse: { kept: true } };
  fs.writeFileSync(path.join(c.lib, "_meta.json"), JSON.stringify(desktopMeta));
  fs.writeFileSync(path.join(c.lib, `${def}.json`), "{}");
  fs.writeFileSync(path.join(c.lib, `${work}.json`), JSON.stringify({ egressProxyUrl: "http://corp:3128" }));

  const r = applyAppProxy(c.proxyUrl, c.home);
  assert.equal(r.replaced, def);
  const on = meta();
  assert.equal(on.appliedId, r.id);
  assert.deepEqual(on.entries, [...desktopMeta.entries, { id: r.id, name: "ClaudeRipple" }]);
  assert.deepEqual(on.somethingElse, { kept: true });
  assertDesktopEditorShape(on);

  assert.equal(removeAppProxy(c.proxyUrl, c.home), true);
  assert.deepEqual(meta(), desktopMeta, "Desktop's meta comes back exactly");
  assert.equal(fs.existsSync(path.join(c.lib, `${r.id}.json`)), false);
  assert.equal(fs.readFileSync(path.join(c.lib, `${work}.json`), "utf8"), JSON.stringify({ egressProxyUrl: "http://corp:3128" }));
});

test("off after an earlier version's meta (no entries) leaves no meta at all, which Desktop seeds itself", () => {
  const c = scratch();
  fs.mkdirSync(c.lib, { recursive: true });
  const id = crypto.randomUUID();
  fs.writeFileSync(path.join(c.lib, "_meta.json"), JSON.stringify({ appliedId: id, clauderipple: { ourId: id, previousAppliedId: null, installationHome: normalizeHome(c.home) } }));
  fs.writeFileSync(path.join(c.lib, `${id}.json`), JSON.stringify({ egressProxyUrl: c.proxyUrl }));
  assert.equal(removeAppProxy(c.proxyUrl, c.home), true);
  // An empty `entries` list would be kept by Desktop's RU() as it is, and flows that read its
  // appliedId would fail; with no file, Desktop seeds "Default" as it did before ClaudeRipple.
  assert.equal(fs.existsSync(path.join(c.lib, "_meta.json")), false);
});

test("on and off over no Config Library leave none behind", () => {
  const c = scratch();
  applyAppProxy(c.proxyUrl, c.home);
  assert.equal(removeAppProxy(c.proxyUrl, c.home), true);
  assert.deepEqual(snapshotLibrary(), {});
});

test("off restores only a selection Desktop can still read, and never applies another listed entry", () => {
  const c = scratch();
  const def = desktopDefault(c);
  const work = crypto.randomUUID();
  fs.writeFileSync(path.join(c.lib, "_meta.json"), JSON.stringify({ ...meta(), entries: [{ id: def, name: "Default" }, { id: work, name: "Work" }] }));
  fs.writeFileSync(path.join(c.lib, `${work}.json`), "{}");
  applyAppProxy(c.proxyUrl, c.home);
  // The person deletes Default in Desktop's editor while ours is applied (listing ours lifts the
  // editor's "last configuration" guard).
  fs.writeFileSync(path.join(c.lib, "_meta.json"), JSON.stringify({ ...meta(), entries: (meta().entries as { id: string }[]).filter((e) => e.id !== def) }));
  fs.rmSync(path.join(c.lib, `${def}.json`));
  assert.equal(removeAppProxy(c.proxyUrl, c.home), true);
  // "Work" was never applied by the person: it stays listed, unapplied, and Desktop's own empty
  // "Default" is seeded and applied, so the app goes direct and its sign-in still finds an id.
  assertSeededDefault([{ id: work, name: "Work" }]);

  // A previous entry an earlier version never listed, still on disk, comes back listed.
  const d = scratch();
  fs.mkdirSync(d.lib, { recursive: true });
  const prev = crypto.randomUUID();
  fs.writeFileSync(path.join(d.lib, `${prev}.json`), "{}");
  fs.writeFileSync(path.join(d.lib, "_meta.json"), JSON.stringify({ appliedId: prev }));
  applyAppProxy(d.proxyUrl, d.home);
  assert.equal(removeAppProxy(d.proxyUrl, d.home), true);
  assert.deepEqual(meta(), { appliedId: prev, entries: [{ id: prev, name: "Default" }] });
});

test("off with nothing applied before ours leaves nothing applied, even beside an entry made in Desktop's editor", () => {
  const c = scratch();
  const r = applyAppProxy(c.proxyUrl, c.home);
  assert.equal((meta().clauderipple as { previousAppliedId: unknown }).previousAppliedId, null);
  // Desktop's editor creates or duplicates without applying (uLi/dLi): a copy of ours names the router.
  const copy = crypto.randomUUID();
  fs.writeFileSync(path.join(c.lib, `${copy}.json`), JSON.stringify({ egressProxyUrl: c.proxyUrl }));
  fs.writeFileSync(path.join(c.lib, "_meta.json"), JSON.stringify({ ...meta(), entries: [...(meta().entries as unknown[]), { id: copy, name: "ClaudeRipple copy" }] }));
  assert.equal(removeAppProxy(c.proxyUrl, c.home), true);
  assertSeededDefault([{ id: copy, name: "ClaudeRipple copy" }]);
  assert.equal(fs.existsSync(path.join(c.lib, `${r.id}.json`)), false);
});

test("off of a listed-only entry over an emptied selection leaves no meta behind", () => {
  const c = scratch();
  applyAppProxy(c.proxyUrl, c.home);
  fs.writeFileSync(path.join(c.lib, "_meta.json"), JSON.stringify({ ...meta(), appliedId: "" }));
  assert.equal(removeAppProxy(c.proxyUrl, c.home), true);
  assert.equal(fs.existsSync(path.join(c.lib, "_meta.json")), false, "not {appliedId:'', entries:[]}, which Desktop would keep as it is");
});

test("what Desktop's own sign-in wrote into our entry survives apply and off", () => {
  const c = scratch();
  const def = desktopDefault(c);
  const r = applyAppProxy(c.proxyUrl, c.home);
  const file = path.join(c.lib, `${r.id}.json`);
  // signInWithAnthropicApiKey writes its provider keys into the applied entry, now that ours is listed.
  const signIn = { inferenceProvider: "anthropic", inferenceCredentialKind: "static", inferenceAnthropicApiKey: "sealed:AAAA" };
  fs.writeFileSync(file, JSON.stringify({ egressProxyUrl: c.proxyUrl, ...signIn }));
  assert.equal(applyAppProxy(c.proxyUrl, c.home).changed, false, "an entry naming this proxy is left alone");
  fs.writeFileSync(file, JSON.stringify({ egressProxyUrl: "http://127.0.0.1:19991", ...signIn }));
  assert.equal(applyAppProxy(c.proxyUrl, c.home).changed, true);
  assert.deepEqual(readJson(file), { egressProxyUrl: c.proxyUrl, ...signIn });

  assert.equal(removeAppProxy(c.proxyUrl, c.home), true);
  assert.deepEqual(readJson(file), signIn, "only our proxy goes");
  const kept = { appliedId: def, entries: [{ id: def, name: "Default" }, { id: r.id, name: "ClaudeRipple" }], clauderipple: { keptId: r.id, installationHome: normalizeHome(c.home) } };
  assert.deepEqual(meta(), kept, "still listed, so the person can apply it again; the pointer is no ownership");
  assert.equal(appliedIsMarked(), false);
  assert.equal(ownsListedAppProxy(c.home), false);
  assert.equal(removeAppProxy(c.proxyUrl, c.home), false, "a second off has nothing of ours to remove");
  assert.deepEqual(meta(), kept);

  // The next apply puts our proxy back into that same entry: one "ClaudeRipple", the sign-in kept.
  const again = applyAppProxy(c.proxyUrl, c.home);
  assert.equal(again.id, r.id);
  assert.deepEqual(readJson(file), { ...signIn, egressProxyUrl: c.proxyUrl });
  assert.deepEqual(meta().entries, [{ id: def, name: "Default" }, { id: r.id, name: "ClaudeRipple" }]);
  assert.equal((meta().clauderipple as { previousAppliedId: string }).previousAppliedId, def);

  // Over no Config Library there is nothing to hand back: the entry the sign-in lives in stays
  // applied, without our proxy, so the person's sign-in keeps working.
  const fresh = scratch();
  const f = applyAppProxy(fresh.proxyUrl, fresh.home);
  fs.writeFileSync(path.join(fresh.lib, `${f.id}.json`), JSON.stringify({ egressProxyUrl: fresh.proxyUrl, ...signIn }));
  assert.equal(removeAppProxy(fresh.proxyUrl, fresh.home), true);
  assert.deepEqual(meta(), { appliedId: f.id, entries: [{ id: f.id, name: "ClaudeRipple" }], clauderipple: { keptId: f.id, installationHome: normalizeHome(fresh.home) } });
  assertDesktopEditorShape(meta());
  assert.deepEqual(readJson(path.join(fresh.lib, `${f.id}.json`)), signIn);
});

test("our kept entry the person applied again is reused; off never selects the entry it deletes", () => {
  const c = scratch();
  const def = desktopDefault(c);
  const r = applyAppProxy(c.proxyUrl, c.home);
  const file = path.join(c.lib, `${r.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ egressProxyUrl: c.proxyUrl, inferenceProvider: "anthropic" }));
  removeAppProxy(c.proxyUrl, c.home);
  desktopApplies(r.id); // the person applies the kept "ClaudeRipple" in Desktop's editor
  const again = applyAppProxy(c.proxyUrl, c.home);
  assert.deepEqual([again.id, again.replaced], [r.id, null], "reused, and not reported as the entry it replaced");
  // Keys still there: off hands that entry back, without our proxy.
  removeAppProxy(c.proxyUrl, c.home);
  assert.equal(meta().appliedId, r.id);
  assert.deepEqual(readJson(file), { inferenceProvider: "anthropic" });

  // Keys gone (removed in the editor): off removes the entry and does not select it.
  applyAppProxy(c.proxyUrl, c.home);
  fs.writeFileSync(file, JSON.stringify({ egressProxyUrl: c.proxyUrl }));
  assert.equal(removeAppProxy(c.proxyUrl, c.home), true);
  assert.equal(fs.existsSync(file), false);
  assert.ok(!(meta().entries as { id: string }[]).some((e) => e.id === r.id), "no ghost of the deleted entry");
  assertSeededDefault([{ id: def, name: "Default" }]);
});

test("a PAC URL in our entry goes when we apply: Desktop would use it instead of our proxy", () => {
  const c = scratch();
  const r = applyAppProxy(c.proxyUrl, c.home);
  const file = path.join(c.lib, `${r.id}.json`);
  for (const egressProxyUrl of ["http://127.0.0.1:19991", c.proxyUrl]) {
    fs.writeFileSync(file, JSON.stringify({ egressProxyUrl, egressProxyPacUrl: "http://pac.example/proxy.pac", inferenceProvider: "anthropic" }));
    assert.equal(applyAppProxy(c.proxyUrl, c.home).changed, true, egressProxyUrl);
    assert.deepEqual(readJson(file), { egressProxyUrl: c.proxyUrl, inferenceProvider: "anthropic" }, egressProxyUrl);
  }
});

test("off removes this installation's listed entry when Desktop applies another one, and keeps the app's choice", () => {
  const c = scratch();
  const def = desktopDefault(c);
  const r = applyAppProxy(c.proxyUrl, c.home);
  desktopApplies(def); // editor Apply, or Console sign-in's "Claude API" entry
  assert.equal(ownsListedAppProxy(c.home), true);
  assert.equal(removeAppProxy(c.proxyUrl, c.home), true);
  assert.deepEqual(meta(), { appliedId: def, entries: [{ id: def, name: "Default" }] });
  assert.equal(fs.existsSync(path.join(c.lib, `${r.id}.json`)), false, "no dead-port ClaudeRipple left to pick");
  assert.equal(ownsListedAppProxy(c.home), false);
});

test("off removes this installation's applied entry whose file is gone, and gives the app its previous one back", () => {
  const c = scratch();
  const def = desktopDefault(c);
  const r = applyAppProxy(c.proxyUrl, c.home);
  fs.rmSync(path.join(c.lib, `${r.id}.json`));
  assert.throws(() => currentAppProxy(), /could not be read/);
  assert.equal(appliedIsMarked(), true, "read from the meta alone");
  assert.equal(ownsListedAppProxy(c.home), true);
  assert.equal(removeAppProxy(c.proxyUrl, c.home), true);
  assert.deepEqual(meta(), { appliedId: def, entries: [{ id: def, name: "Default" }] });
  assert.equal(appliedIsMarked(), false);
});

test("an older version's id Desktop cannot read is never listed", () => {
  const c = scratch();
  const def = desktopDefault(c);
  fs.writeFileSync(path.join(c.lib, "_meta.json"), JSON.stringify({ ...meta(), appliedId: "legacy", clauderipple: { ourId: "legacy", previousAppliedId: def, installationHome: normalizeHome(c.home) } }));
  fs.writeFileSync(path.join(c.lib, "legacy.json"), JSON.stringify({ egressProxyUrl: "http://127.0.0.1:19991" }));
  const r = applyAppProxy(c.proxyUrl, c.home);
  assert.equal(r.id, "legacy");
  assert.deepEqual(meta().entries, [{ id: def, name: "Default" }], "nothing could find a listed 'legacy' again, and a re-apply would list a second ClaudeRipple");
  assert.equal(removeAppProxy(c.proxyUrl, c.home), true);
  assert.deepEqual(meta(), { appliedId: def, entries: [{ id: def, name: "Default" }] });
});

test("the app's applied entry whose file is gone reads as Desktop reads it: no proxy, so re-apply and off work", async () => {
  const c = scratch();
  const def = desktopDefault(c);
  fs.rmSync(path.join(c.lib, `${def}.json`));
  assert.deepEqual(currentAppProxy(), { appliedId: def, egressProxyUrl: null, ours: false });
  const state = appProxyState(c.proxyUrl, c.home);
  assert.deepEqual([state.state, state.holder], ["other", "app"]);
  await reapplyCommand(c).run();
  assert.equal(currentAppProxy().egressProxyUrl, c.proxyUrl);
  assert.equal((meta().clauderipple as { previousAppliedId: string }).previousAppliedId, def);
  assert.equal(removeAppProxy(c.proxyUrl, c.home), true);
  assert.deepEqual(meta(), { appliedId: def, entries: [{ id: def, name: "Default" }] });
});

test("applying again over an earlier version's meta adds the list once, and then writes nothing", async () => {
  const c = scratch();
  fs.mkdirSync(c.lib, { recursive: true });
  const id = crypto.randomUUID();
  fs.writeFileSync(path.join(c.lib, "_meta.json"), JSON.stringify({ appliedId: id, clauderipple: { ourId: id, previousAppliedId: null, installationHome: normalizeHome(c.home) } }));
  const entryFile = path.join(c.lib, `${id}.json`);
  fs.writeFileSync(entryFile, JSON.stringify({ egressProxyUrl: c.proxyUrl }));
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(entryFile, old, old);

  const first = applyAppProxy(c.proxyUrl, c.home);
  assert.deepEqual(first, { id, replaced: null, changed: true });
  assert.deepEqual(meta().entries, [{ id, name: "ClaudeRipple" }]);
  assert.equal(fs.statSync(entryFile).mtimeMs, old.getTime(), "an entry that already says this is not rewritten");

  const metaTime = fs.statSync(path.join(c.lib, "_meta.json")).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(applyAppProxy(c.proxyUrl, c.home), { id, replaced: null, changed: false });
  assert.equal(fs.statSync(path.join(c.lib, "_meta.json")).mtimeMs, metaTime, "an unchanged state writes nothing");
});

test("an entries value that is not a list is not ours to replace", () => {
  const c = scratch();
  fs.mkdirSync(c.lib, { recursive: true });
  fs.writeFileSync(path.join(c.lib, "_meta.json"), JSON.stringify({ entries: { broken: true } }));
  const before = snapshotLibrary();
  assert.throws(() => applyAppProxy(c.proxyUrl, c.home), /invalid entries list; left untouched/);
  assert.deepEqual(snapshotLibrary(), before);
});

// ---- what the app will read ---------------------------------------------------------------

test("appProxyState names each state without throwing", () => {
  const c = scratch();
  assert.equal(appProxyState(c.proxyUrl, c.home).state, "missing", "no Config Library at all");
  assert.match(appProxyState(c.proxyUrl, c.home).reason, /gone/);
  fs.mkdirSync(c.lib, { recursive: true });
  fs.writeFileSync(path.join(c.lib, "_meta.json"), "{}\n");
  assert.equal(appProxyState(c.proxyUrl, c.home).state, "missing", "a reset meta (macOS, 2026-10-25)");
  fs.writeFileSync(path.join(c.lib, "_meta.json"), JSON.stringify({ appliedId: "", entries: [] }));
  assert.equal(appProxyState(c.proxyUrl, c.home).state, "missing", "Desktop's own empty default");

  const r = applyAppProxy(c.proxyUrl, c.home);
  const applied = appProxyState(c.proxyUrl, c.home);
  assert.equal(applied.state, "applied");
  assert.equal(applied.appliedId, r.id);
  assert.equal(applied.egressProxyUrl, c.proxyUrl);
  assert.ok(applied.changedAt !== null && applied.changedAt > Date.now() - 60_000);
  assert.equal(appProxyState("http://127.0.0.1:19991", c.home).state, "stale", "our entry on an old port");
  // Seen from another installation: in effect when it names that installation's own URL too (one
  // router answers both), and never "stale", which repair would try to rewrite.
  assert.equal(appProxyState(c.proxyUrl, path.join(c.dir, "another-home")).state, "applied");
  const foreign = appProxyState("http://127.0.0.1:19991", path.join(c.dir, "another-home"));
  assert.deepEqual([foreign.state, foreign.holder], ["other", "installation"]);

  const m = meta();
  fs.writeFileSync(path.join(c.lib, "_meta.json"), JSON.stringify({ ...m, hybridPointer: HYBRID }));
  const hybrid = appProxyState(c.proxyUrl, c.home);
  assert.deepEqual([hybrid.state, hybrid.holder], ["other", "hybrid"], "Desktop reads a hybrid pointer instead of any entry");
  // Desktop honours only https pointers on its own hosts with no credentials (n4/Zce/t4); any other
  // is ignored and the applied entry stays in effect.
  for (const bootstrapUrl of ["https://example.invalid/bootstrap", "http://config.claude.com/bootstrap", "https://user:pw@config.claude.com/x", "not a url"]) {
    fs.writeFileSync(path.join(c.lib, "_meta.json"), JSON.stringify({ ...m, hybridPointer: { bootstrapUrl } }));
    assert.equal(appProxyState(c.proxyUrl, c.home).state, "applied", bootstrapUrl);
  }
  fs.writeFileSync(path.join(c.lib, "_meta.json"), "{not json");
  assert.equal(appProxyState(c.proxyUrl, c.home).state, "unknown");
  assert.throws(() => currentAppProxy(), "currentAppProxy keeps throwing for its existing callers");
});

// ---- repair's self-heal (defect 2) ---------------------------------------------------------

test("repair applies the entry again when the whole Claude-3p folder was deleted", async () => {
  const c = scratch();
  const r0 = applyAppProxy(c.proxyUrl, c.home);
  fs.rmSync(path.dirname(c.lib), { recursive: true, force: true });

  const before = await doctor(deps(c.home));
  assert.ok(before.problems.some((p) => p.code === "desktop-entry-missing"), JSON.stringify(before.problems));
  assert.equal(before.desktop.proxy, "none");

  const r = await repair(deps(c.home));
  const step = r.steps.find((s) => s.name === "desktop-proxy");
  assert.ok(step?.ok, JSON.stringify(r.steps));
  assert.match(step!.detail, /missing; applied it again/);
  assert.match(step!.detail, /Quit and reopen Claude Desktop/);
  const ap = currentAppProxy();
  assert.equal(ap.ours, true);
  assert.equal(ap.egressProxyUrl, c.proxyUrl);
  assert.notEqual(ap.appliedId, r0.id, "a new entry: the old one is gone with its folder");
  assertDesktopEditorShape(meta());
  assert.equal(r.doctor.desktop.proxy, "ripple");
  assert.ok(!r.doctor.problems.some((p) => p.code === "desktop-entry-missing"));

  // Idempotent: a second repair finds nothing to do on Desktop's side.
  const again = await repair(deps(c.home));
  assert.equal(again.steps.some((s) => s.name === "desktop-proxy"), false);
});

test("repair applies the entry again over a reset meta, keeping the id and what off restores", async () => {
  const c = scratch();
  fs.mkdirSync(c.lib, { recursive: true });
  const def = crypto.randomUUID();
  fs.writeFileSync(path.join(c.lib, "_meta.json"), JSON.stringify({ appliedId: def, entries: [{ id: def, name: "Default" }] }));
  fs.writeFileSync(path.join(c.lib, `${def}.json`), "{}");
  const r0 = applyAppProxy(c.proxyUrl, c.home);
  // Nothing applied any more, but the record still names this installation's entry.
  fs.writeFileSync(path.join(c.lib, "_meta.json"), JSON.stringify({ ...meta(), appliedId: "" }));

  const r = await repair(deps(c.home));
  assert.ok(r.steps.find((s) => s.name === "desktop-proxy")?.ok, JSON.stringify(r.steps));
  assert.equal(meta().appliedId, r0.id, "the recorded entry is reused, not a second ClaudeRipple in Desktop's list");
  assert.deepEqual(meta().entries, [{ id: def, name: "Default" }, { id: r0.id, name: "ClaudeRipple" }]);
  assert.equal(removeAppProxy(c.proxyUrl, c.home), true);
  assert.deepEqual(meta(), { appliedId: def, entries: [{ id: def, name: "Default" }] });
});

test("repair writes back this installation's applied entry when only its file was deleted", async () => {
  const c = scratch();
  const r0 = applyAppProxy(c.proxyUrl, c.home);
  fs.rmSync(path.join(c.lib, `${r0.id}.json`));
  assert.equal(appProxyState(c.proxyUrl, c.home).state, "missing");
  // doctor used to throw here ("could not be read"), taking repair down with it.
  const r = await repair(deps(c.home));
  assert.ok(r.steps.find((s) => s.name === "desktop-proxy")?.ok, JSON.stringify(r.steps));
  assert.equal(currentAppProxy().appliedId, r0.id);
  assert.deepEqual(readJson(path.join(c.lib, `${r0.id}.json`)), { egressProxyUrl: c.proxyUrl });
});

test("repair leaves another installation's entry untouched, applied or only recorded", async () => {
  const c = scratch();
  const other = path.join(c.dir, "other-home");
  applyAppProxy("http://127.0.0.1:19991", other);
  const applied = snapshotLibrary();
  // Another installation's proxy, not an old port of ours: repair has nothing of ours to rewrite.
  const report = await doctor(deps(c.home));
  assert.ok(report.problems.some((p) => p.code === "desktop-foreign-proxy"), JSON.stringify(report.problems));
  assert.ok(!report.problems.some((p) => p.code === "desktop-port-mismatch"), JSON.stringify(report.problems));
  const r = await repair(deps(c.home));
  assert.deepEqual(snapshotLibrary(), applied, "another installation's applied entry is never replaced");
  assert.equal(r.steps.some((s) => s.name === "desktop-proxy"), false, JSON.stringify(r.steps));

  // Nothing applied, but the record is the other installation's: filling the gap would take it over.
  fs.writeFileSync(path.join(c.lib, "_meta.json"), JSON.stringify({ ...meta(), appliedId: "" }));
  const recorded = snapshotLibrary();
  const before = await doctor(deps(c.home));
  assert.ok(!before.problems.some((p) => p.code === "desktop-entry-missing"));
  const other2 = before.problems.find((p) => p.code === "desktop-entry-other");
  assert.ok(other2, JSON.stringify(before.problems));
  assert.match(other2.message, /another ClaudeRipple installation's entry/);
  assert.doesNotMatch(other2.message, /picker reapply/, "never advise a command that refuses here");
  const r2 = await repair(deps(c.home));
  assert.equal(r2.steps.some((s) => s.name === "desktop-proxy"), false);
  assert.deepEqual(snapshotLibrary(), recorded);
});

test("repair leaves a configuration the app or the person chose: Desktop's own entry or a hybrid pointer", async () => {
  const c = scratch();
  fs.mkdirSync(c.lib, { recursive: true });
  const def = crypto.randomUUID();
  fs.writeFileSync(path.join(c.lib, "_meta.json"), JSON.stringify({ appliedId: def, entries: [{ id: def, name: "Default" }] }));
  fs.writeFileSync(path.join(c.lib, `${def}.json`), "{}");
  for (const [extra, advice] of [[{}, /picker reapply/], [{ hybridPointer: HYBRID }, /hybrid configuration.*end it in Claude Desktop/]] as const) {
    fs.writeFileSync(path.join(c.lib, "_meta.json"), JSON.stringify({ appliedId: def, entries: [{ id: def, name: "Default" }], ...extra }));
    const before = snapshotLibrary();
    const report = await doctor(deps(c.home));
    const problem = report.problems.find((p) => p.code === "desktop-entry-other");
    assert.ok(problem, JSON.stringify(report.problems));
    assert.match(problem.message, advice);
    const r = await repair(deps(c.home));
    assert.equal(r.steps.some((s) => s.name === "desktop-proxy"), false, JSON.stringify(r.steps));
    assert.deepEqual(snapshotLibrary(), before);
  }
});

test("the self-heal re-checks under the lock: a state that changed meanwhile is not replaced", () => {
  const c = scratch();
  fs.mkdirSync(c.lib, { recursive: true });
  const def = crypto.randomUUID();
  fs.writeFileSync(path.join(c.lib, "_meta.json"), JSON.stringify({ appliedId: def, entries: [{ id: def, name: "Default" }] }));
  fs.writeFileSync(path.join(c.lib, `${def}.json`), "{}");
  const before = snapshotLibrary();
  assert.equal(restoreMissingAppProxy(c.proxyUrl, c.home), null);
  assert.deepEqual(snapshotLibrary(), before);
});

test("our entry naming no proxy is written again like a missing one: picker mode, router answering, CA trusted", async () => {
  const noProxy = (opts: { picker?: boolean } = {}) => {
    const c = scratch(opts);
    const r0 = applyAppProxy(c.proxyUrl, c.home);
    fs.writeFileSync(path.join(c.lib, `${r0.id}.json`), "{}");
    return { c, file: path.join(c.lib, `${r0.id}.json`) };
  };
  // The app goes direct and works here: an untrusted CA or a router that does not answer would
  // turn that into a blank page (§5), and outside picker mode there is nothing to restore.
  const untrusted = noProxy();
  const u = await repair(deps(untrusted.c.home, answering, fakeSupervisor().ops, false));
  assert.match(u.steps.find((s) => s.name === "desktop-proxy")?.detail ?? "", /CA is not trusted/);
  assert.equal(fs.readFileSync(untrusted.file, "utf8"), "{}");
  const down = noProxy();
  const d = await repair(deps(down.c.home, silent, fakeSupervisor({}, "failed").ops));
  assert.match(d.steps.find((s) => s.name === "desktop-proxy")?.detail ?? "", /router does not answer/);
  assert.equal(fs.readFileSync(down.file, "utf8"), "{}");
  const off = noProxy({ picker: false });
  const o = await repair(deps(off.c.home));
  assert.equal(o.steps.some((s) => s.name === "desktop-proxy"), false, JSON.stringify(o.steps));
  assert.equal(fs.readFileSync(off.file, "utf8"), "{}");

  const ok = noProxy();
  assert.equal(appProxyState(ok.c.proxyUrl, ok.c.home).state, "stale");
  const before = await doctor(deps(ok.c.home));
  const problem = before.problems.find((p) => p.code === "desktop-entry-missing");
  assert.ok(problem, JSON.stringify(before.problems));
  assert.match(problem.message, /names no proxy/);
  assert.ok(!before.problems.some((p) => p.code === "desktop-port-mismatch"), "not a port to move");
  const r = await repair(deps(ok.c.home));
  assert.ok(r.steps.find((s) => s.name === "desktop-proxy")?.ok, JSON.stringify(r.steps));
  assert.deepEqual(readJson(ok.file), { egressProxyUrl: ok.c.proxyUrl });
});

test("repair does not point Claude Desktop at the router while its CA is not trusted", async () => {
  const c = scratch();
  const r = await repair(deps(c.home, answering, fakeSupervisor().ops, false));
  const step = r.steps.find((s) => s.name === "desktop-proxy");
  assert.equal(step?.ok, false, JSON.stringify(r.steps));
  assert.match(step!.detail, /CA is not trusted/);
  assert.match(step!.detail, /picker on/);
  assert.equal(fs.existsSync(c.lib), false, "nothing written: the direct app still loads claude.ai");
});

test("repair does not point Claude Desktop at a router that does not answer", async () => {
  const c = scratch();
  const { ops } = fakeSupervisor({}, "failed");
  const r = await repair(deps(c.home, silent, ops));
  const step = r.steps.find((s) => s.name === "desktop-proxy");
  assert.equal(step?.ok, false, JSON.stringify(r.steps));
  assert.match(step!.detail, /not applied again while the router does not answer/);
  assert.equal(fs.existsSync(c.lib), false, "nothing written");
});

test("no self-heal while `direct on` holds the entry, or with picker mode off", async () => {
  const direct = scratch();
  fs.writeFileSync(path.join(direct.home, "direct.json"), JSON.stringify({ at: new Date().toISOString(), cli: {}, desktop: { egressProxyUrl: direct.proxyUrl, appliedAfter: null } }));
  const d = await repair(deps(direct.home));
  assert.equal(d.steps.some((s) => s.name === "desktop-proxy"), false);
  assert.ok(!d.doctor.problems.some((p) => p.code === "desktop-entry-missing"));
  assert.equal(fs.existsSync(direct.lib), false);

  const off = scratch({ picker: false });
  const o = await repair(deps(off.home));
  assert.equal(o.steps.some((s) => s.name === "desktop-proxy"), false);
  assert.ok(!o.doctor.problems.some((p) => p.code === "desktop-entry-missing"));
  assert.equal(fs.existsSync(off.lib), false);
});

// ---- `clauderipple picker reapply` ---------------------------------------------------------

// Evaluate only the command body with injected boundaries. Never import or run the CLI entry point.
function reapplyCommand(c: ReturnType<typeof scratch>, opts: { picker?: boolean; probeOk?: boolean; trusted?: boolean } = {}) {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("async function pickerReapply(): Promise<void> {"), source.indexOf("\nfunction pickerOff(): void {"));
  assert.ok(body.length > 100, "pickerReapply moved");
  const lines: string[] = [];
  const probes: unknown[] = [];
  const run = () => vm.runInNewContext(stripTypeScriptTypes(`${body}\npickerReapply();`), {
    homeDir: () => c.home,
    configPath: () => path.join(c.home, "config.json"),
    ConfigStore: class { get() { return { listen: { host: "127.0.0.1", port: 18791 }, upstream: "api.anthropic.com", picker: { enabled: opts.picker !== false } }; } },
    certPaths: (home: string) => ({ caPem: path.join(home, "ca.pem") }),
    probe: async (p: unknown) => { probes.push(p); return opts.probeOk === false ? { ok: false, detail: "ECONNREFUSED" } : { ok: true, detail: "ok" }; },
    proxyUrlFor: (port: number) => `http://127.0.0.1:${port}`,
    caTrusted: () => opts.trusted !== false,
    applyAppProxy, fs, path,
    console: { log: (line: string) => lines.push(line) },
  }) as Promise<void>;
  return { run, lines, probes };
}

test("picker reapply applies only the entry, says to restart Desktop, and is a no-op the second time", async () => {
  const c = scratch();
  const cmd = reapplyCommand(c);
  await cmd.run();
  assert.equal(cmd.probes.length, 1, "the router is checked first, as picker on does");
  assert.equal(currentAppProxy().egressProxyUrl, c.proxyUrl);
  assertDesktopEditorShape(meta());
  assert.match(cmd.lines.join("\n"), /entry applied/);
  assert.match(cmd.lines.join("\n"), /Quit Claude Desktop completely and open it again/);
  // Whole words only: an entry id is hex, so a case-insensitive "ca" matched it about one run in ten.
  assert.doesNotMatch(cmd.lines.join("\n"), /\bCA\b|certificate|dialog|trust/, "no trust step");

  const again = reapplyCommand(c);
  const before = snapshotLibrary();
  await again.run();
  assert.match(again.lines.join("\n"), /already applied/);
  assert.deepEqual(snapshotLibrary(), before);
});

test("picker reapply refuses with picker mode off, under direct on, and with the router down", async () => {
  const off = scratch();
  await assert.rejects(reapplyCommand(off, { picker: false }).run(), /picker mode is off/);
  const direct = scratch();
  fs.writeFileSync(path.join(direct.home, "direct.json"), "{}");
  await assert.rejects(reapplyCommand(direct).run(), /direct off/);
  const down = scratch();
  await assert.rejects(reapplyCommand(down, { probeOk: false }).run(), /router is not answering/);
  const untrusted = scratch();
  await assert.rejects(reapplyCommand(untrusted, { trusted: false }).run(), /CA is not trusted.*picker on/);
  for (const c of [off, direct, down, untrusted]) assert.equal(fs.existsSync(c.lib), false, "nothing written");
});

test("re-applying after Desktop switched away reuses this installation's entry: one ClaudeRipple in the list", async () => {
  const c = scratch();
  const def = desktopDefault(c);
  const r0 = applyAppProxy(c.proxyUrl, c.home);
  desktopApplies(def);
  await reapplyCommand(c).run();
  assert.equal(meta().appliedId, r0.id);
  assert.deepEqual(meta().entries, [{ id: def, name: "Default" }, { id: r0.id, name: "ClaudeRipple" }]);
  assert.equal((meta().clauderipple as { previousAppliedId: string }).previousAppliedId, def);
  assert.equal(removeAppProxy(c.proxyUrl, c.home), true);
  assert.deepEqual(meta(), { appliedId: def, entries: [{ id: def, name: "Default" }] });
});

test("apply refuses another installation's record while its entry is still listed, applied or not", async () => {
  const c = scratch();
  const def = desktopDefault(c);
  applyAppProxy("http://127.0.0.1:19991", path.join(c.dir, "other-home"));
  desktopApplies(def);
  const before = snapshotLibrary();
  assert.equal(appProxyState(c.proxyUrl, c.home).holder, "installation");
  await assert.rejects(reapplyCommand(c).run(), /belongs to another installation/);
  assert.throws(() => applyAppProxy(c.proxyUrl, c.home), /belongs to another installation/);
  assert.equal(restoreMissingAppProxy(c.proxyUrl, c.home), null);
  assert.deepEqual(snapshotLibrary(), before, "the other installation's record and entry stay its own");
});

test("apply refuses while a hybrid configuration is in effect, which Desktop reads instead of any entry", async () => {
  const c = scratch();
  desktopDefault(c, { hybridPointer: HYBRID });
  const before = snapshotLibrary();
  await assert.rejects(reapplyCommand(c).run(), /hybrid configuration/);
  assert.deepEqual(snapshotLibrary(), before);
  // A pointer Desktop would ignore does not stand in the way.
  desktopDefault(c, { hybridPointer: { bootstrapUrl: "https://example.invalid/bootstrap" } });
  await reapplyCommand(c).run();
  assert.equal(currentAppProxy().egressProxyUrl, c.proxyUrl);
});

// ---- `picker on` and `direct off` around what apply refuses -----------------------------------

function pickerOnCommand(c: ReturnType<typeof scratch>) {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("async function pickerOn(): Promise<void> {"), source.indexOf("/** After a direct start"));
  fs.writeFileSync(path.join(c.home, "ca.key"), "test");
  const calls: string[] = [];
  const run = () => vm.runInNewContext(stripTypeScriptTypes(`${body}\npickerOn();`), {
    homeDir: () => c.home,
    configPath: () => path.join(c.home, "config.json"),
    ConfigStore: class { get() { return { listen: { host: "127.0.0.1", port: 18791 }, upstream: "api.anthropic.com" }; } },
    certPaths: (home: string) => ({ caPem: path.join(home, "ca.pem") }),
    probe: async () => ({ ok: true, detail: "ok" }),
    caTrusted: () => calls.includes("trustCa"),
    trustCa: () => { calls.push("trustCa"); },
    setPickerEnabled: () => { calls.push("setPickerEnabled"); },
    proxyUrlFor: (port: number) => `http://127.0.0.1:${port}`,
    isWindows: true, isLinux: false, nssDb: () => "",
    appProxyState, applyAppProxy, appProxyOwner, currentAppProxy, fs, path,
    console: { log: () => {} },
  }) as Promise<void>;
  return { run, calls };
}

test("picker on refuses what apply would refuse before it asks the system to trust the CA", async () => {
  for (const setup of [
    (c: ReturnType<typeof scratch>) => desktopDefault(c, { hybridPointer: HYBRID }),
    (c: ReturnType<typeof scratch>) => { applyAppProxy("http://127.0.0.1:19991", path.join(c.dir, "other-home")); },
    // Another installation on the same port: the state reads "applied", and apply refuses it too.
    (c: ReturnType<typeof scratch>) => { applyAppProxy(c.proxyUrl, path.join(c.dir, "other-home")); },
    (c: ReturnType<typeof scratch>) => { fs.mkdirSync(c.lib, { recursive: true }); fs.writeFileSync(path.join(c.lib, "_meta.json"), "{not json"); },
  ]) {
    const c = scratch({ picker: false });
    setup(c);
    const before = snapshotLibrary();
    const cmd = pickerOnCommand(c);
    await assert.rejects(cmd.run(), /CA left as it was/);
    assert.deepEqual(cmd.calls, [], "no trust dialog, and picker mode stays off");
    assert.deepEqual(snapshotLibrary(), before);
  }
  const ok = scratch({ picker: false });
  const cmd = pickerOnCommand(ok);
  await cmd.run();
  assert.deepEqual(cmd.calls, ["trustCa", "setPickerEnabled"]);
});

test("direct off still brings Claude Code back when Desktop's side is a hybrid configuration or another installation's", async (t) => {
  for (const block of ["hybrid", "installation", "same-port"] as const) {
    const c = scratch();
    isolateHome(t, c);
    const def = desktopDefault(c);
    const ca = path.join(c.home, "ca.pem");
    applyProxyEnv({ home: c.home, proxyUrl: c.proxyUrl, caPath: ca, force: true });
    applyAppProxy(c.proxyUrl, c.home);
    assert.equal(directOn(c.home).ok, true);
    if (block === "hybrid") fs.writeFileSync(path.join(c.lib, "_meta.json"), JSON.stringify({ ...meta(), hybridPointer: HYBRID }));
    else if (block === "installation") { applyAppProxy("http://127.0.0.1:19991", path.join(c.dir, "other-home")); desktopApplies(def); }
    else applyAppProxy(c.proxyUrl, path.join(c.dir, "other-home"));
    const before = snapshotLibrary();
    const r = await directOff(deps(c.home));
    assert.equal(r.ok, true, r.detail);
    assert.equal(settingsEnv().HTTPS_PROXY, c.proxyUrl, `${block}: Claude Code goes through ClaudeRipple again`);
    assert.equal(fs.existsSync(path.join(c.home, "direct.json")), false);
    assert.match(r.detail, /was not put back/);
    assert.deepEqual(snapshotLibrary(), before, `${block}: Desktop's side is left as it is`);
  }
  // Only Desktop's side was saved, and it is held: the detail says so, never "already went through".
  const c = scratch();
  isolateHome(t, c);
  desktopDefault(c);
  applyAppProxy(c.proxyUrl, c.home);
  assert.equal(directOn(c.home).ok, true);
  fs.writeFileSync(path.join(c.lib, "_meta.json"), JSON.stringify({ ...meta(), hybridPointer: HYBRID }));
  const r = await directOff(deps(c.home));
  assert.match(r.detail, /was not put back/);
  assert.doesNotMatch(r.detail, /already went through ClaudeRipple/);
});

// ---- uninstall ---------------------------------------------------------------------------

test("uninstall removes this installation's entry that Desktop lists but does not apply", (t) => {
  const c = scratch();
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME };
  Object.assign(process.env, { HOME: c.dir, USERPROFILE: c.dir, CODEX_HOME: path.join(c.dir, "codex") });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const def = desktopDefault(c);
  const r = applyAppProxy(c.proxyUrl, c.home);
  desktopApplies(def);
  removeClientIntegrations(c.home, () => "absent", { defaultHome: c.home, modDir: path.join(c.dir, "mod"), agentDir: path.join(c.dir, "agents") });
  assert.deepEqual(meta(), { appliedId: def, entries: [{ id: def, name: "Default" }] });
  assert.equal(fs.existsSync(path.join(c.lib, `${r.id}.json`)), false);
});

test("picker reapply replaces an entry the app applies instead, remembering it for off; never another installation's", async () => {
  const c = scratch();
  fs.mkdirSync(c.lib, { recursive: true });
  const def = crypto.randomUUID();
  fs.writeFileSync(path.join(c.lib, "_meta.json"), JSON.stringify({ appliedId: def, entries: [{ id: def, name: "Default" }] }));
  fs.writeFileSync(path.join(c.lib, `${def}.json`), "{}");
  await reapplyCommand(c).run();
  assert.equal((meta().clauderipple as { previousAppliedId: string }).previousAppliedId, def);

  const o = scratch();
  applyAppProxy("http://127.0.0.1:19991", path.join(o.dir, "other-home"));
  const before = snapshotLibrary();
  await assert.rejects(reapplyCommand(o).run(), /another installation/);
  assert.deepEqual(snapshotLibrary(), before);
});

// ---- `picker on` wording (defect 5) --------------------------------------------------------

test("picker on numbers all three steps and announces no dialog for a CA that is already trusted", () => {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("async function pickerOn(): Promise<void> {"), source.indexOf("/** After a direct start"));
  for (const step of ["Step 1/3", "Step 2/3", "Step 3/3"]) assert.ok(body.includes(step), step);
  const trusted = body.indexOf("if (caTrusted(caPem))");
  const dialog = body.indexOf("Windows will show a confirmation dialog");
  assert.ok(trusted > 0 && dialog > trusted, "the dialog is announced only on the untrusted branch");
  const already = body.indexOf("CA is already trusted");
  assert.ok(already > trusted && already < dialog);
});
