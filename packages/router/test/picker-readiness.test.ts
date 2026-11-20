// Picker mode readiness names the fix that works (2026-11-19): `picker-proxy` for a Claude Desktop
// entry that is missing or not this router's (only re-applying helps), `picker-restart` for our
// entry the app has not started with yet (only a restart helps). And the dashboard's re-apply
// action runs `clauderipple picker reapply`, never the switch's `picker off`.
//
// SAFETY: the Config Library, the home and settings.json are temp dirs set before anything reads
// them; the CLI is injected, so no child process and no real Claude-3p folder is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cr-picker-ready-")));
const saved = { home: process.env.CLAUDERIPPLE_HOME, support: process.env.CLAUDE_APP_SUPPORT, settings: process.env.CLAUDE_SETTINGS_PATH };
process.env.CLAUDERIPPLE_HOME = path.join(root, "home");
process.env.CLAUDE_APP_SUPPORT = path.join(root, "Claude-3p");
process.env.CLAUDE_SETTINGS_PATH = path.join(root, "settings.json");
fs.mkdirSync(process.env.CLAUDERIPPLE_HOME, { recursive: true });
process.on("exit", () => {
  for (const [key, value] of [["CLAUDERIPPLE_HOME", saved.home], ["CLAUDE_APP_SUPPORT", saved.support], ["CLAUDE_SETTINGS_PATH", saved.settings]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const { DEFAULTS } = await import("../src/config.ts");
const { Logger } = await import("../src/log.ts");
const { RequestLog } = await import("../src/requestlog.ts");
const { desktopEntryReadiness, startAdmin } = await import("../src/admin.ts");
const { applyAppProxy, appProxyState, configLibraryDir } = await import("../../cli/src/picker.ts");
const { CertStore } = await import("../src/certs.ts");
const { UpstreamHealth } = await import("../src/health.ts");
const { Proxy } = await import("../src/proxy.ts");
type Config = import("../src/config.ts").Config;
type AppProxyState = import("../../cli/src/picker.ts").AppProxyState;

const home = process.env.CLAUDERIPPLE_HOME!;
const cfg: Config = { ...DEFAULTS, admin: { port: 0 }, picker: { enabled: true } };
const wantProxy = `http://127.0.0.1:${cfg.listen.port}`;

async function withPickerAdmin(fn: (ctx: { port: number; calls: string[][]; setSeen: (at: string | null) => void; setCli: (r: { ok: boolean; output: string }) => void }) => Promise<void>): Promise<void> {
  let seenAt: string | null = null;
  let cliResult = { ok: true, output: "✓ applied" };
  const calls: string[][] = [];
  const admin = await startAdmin({
    config: () => cfg,
    configFile: path.join(home, "config.json"),
    log: new Logger(null, 1_000_000, 1, false),
    stats: () => ({ inFlight: 0, messagesInFlight: 0, started: 0, completed: 0, failed: 0 }),
    health: () => 0,
    version: "0.0.0-test",
    requests: new RequestLog(path.join(home, "logs", "requests.jsonl")),
    claudeCodeCredentialReaders: { keychain: () => null, credentialsFile: () => null },
    picker: () => ({ enabled: true, hosts: ["claude.ai"], last: null, seenAt }),
    runCli: async (args) => { calls.push(args); return cliResult; },
  });
  try {
    await fn({ port: admin.port, calls, setSeen: (at) => (seenAt = at), setCli: (r) => (cliResult = r) });
  } finally {
    admin.close();
  }
}

type PickerEntry = { state: string; holder: string | null; reapply: boolean };
async function pickerEntry(port: number): Promise<PickerEntry | undefined> {
  const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json() as { picker: { entry?: PickerEntry } };
  return status.picker.entry;
}

async function problems(port: number): Promise<string[]> {
  const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json() as { readiness: { problems: string[] } };
  // `picker-ca` is the certificate's (no CA in this temp home), asked in the background: not this test's.
  return status.readiness.problems.filter((p) => p === "picker-proxy" || p === "picker-restart");
}

function resetLibrary(): void {
  fs.rmSync(path.join(root, "Claude-3p"), { recursive: true, force: true });
  fs.rmSync(path.join(home, "direct.json"), { force: true });
}

test("readiness: a missing entry is picker-proxy (re-apply), our new entry not yet used is picker-restart, then clear", async () => {
  resetLibrary();
  await withPickerAdmin(async ({ port, setSeen }) => {
    assert.deepEqual(await problems(port), ["picker-proxy"], "no Config Library at all: a restart cannot fix it");

    // Applied while this router runs, and no claude.ai request through it since: the app has not
    // started with it.
    applyAppProxy(wantProxy, home);
    assert.deepEqual(await problems(port), ["picker-restart"]);

    // Claude Desktop's own traffic arrives: the entry is in effect.
    setSeen(new Date(Date.now() + 1_000).toISOString());
    assert.deepEqual(await problems(port), []);

    // Deleted again while the app keeps running: re-apply, not restart.
    fs.rmSync(path.join(root, "Claude-3p"), { recursive: true, force: true });
    assert.deepEqual(await problems(port), ["picker-proxy"]);
  });
});

test("readiness: an entry on another port, or another app's choice, is picker-proxy; direct on reports neither", async () => {
  resetLibrary();
  await withPickerAdmin(async ({ port }) => {
    applyAppProxy("http://127.0.0.1:19991", home);
    assert.deepEqual(await problems(port), ["picker-proxy"], "our entry on an old port leaves the app a blank page");

    resetLibrary();
    fs.mkdirSync(configLibraryDir(), { recursive: true });
    const def = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
    fs.writeFileSync(path.join(configLibraryDir(), "_meta.json"), JSON.stringify({ appliedId: def, entries: [{ id: def, name: "Default" }] }));
    fs.writeFileSync(path.join(configLibraryDir(), `${def}.json`), "{}");
    assert.deepEqual(await problems(port), ["picker-proxy"]);

    // `direct on` took the entry off on purpose; `direct off` puts it back.
    fs.writeFileSync(path.join(home, "direct.json"), "{}");
    assert.deepEqual(await problems(port), []);
  });
});

test("desktopEntryReadiness: an entry older than this process says nothing either way", () => {
  const started = Date.parse("2026-11-20T10:00:00Z");
  const entry = (state: AppProxyState["state"], changedAt: number | null, url: string | null = wantProxy): AppProxyState => ({ state, holder: null, appliedId: "x", egressProxyUrl: url, changedAt, reason: "" });
  assert.equal(desktopEntryReadiness(entry("applied", started - 1), wantProxy, null, started, false), "ok", "a router restart forgets what it saw");
  assert.equal(desktopEntryReadiness(entry("applied", started + 5), wantProxy, null, started, false), "restart");
  assert.equal(desktopEntryReadiness(entry("applied", started + 5), wantProxy, new Date(started + 4).toISOString(), started, false), "restart", "traffic before the change does not count");
  assert.equal(desktopEntryReadiness(entry("applied", started + 5), wantProxy, new Date(started + 6).toISOString(), started, false), "ok");
  assert.equal(desktopEntryReadiness(entry("missing", null, null), wantProxy, null, started, false), "missing");
  assert.equal(desktopEntryReadiness(entry("stale", started - 1, "http://127.0.0.1:1"), wantProxy, null, started, false), "missing");
  assert.equal(desktopEntryReadiness(entry("unknown", null, null), wantProxy, null, started, false), "missing");
  assert.equal(desktopEntryReadiness(entry("other", started - 1), wantProxy, null, started, false), "ok", "another entry naming this router is in effect");
  assert.equal(desktopEntryReadiness(entry("missing", null, null), wantProxy, null, started, true), "ok", "direct on");
});

test("an unchanged `picker on` again does not make the entry look new", async () => {
  resetLibrary();
  applyAppProxy(wantProxy, home);
  const first = appProxyState(wantProxy, home).changedAt;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(applyAppProxy(wantProxy, home).changed, false);
  assert.equal(appProxyState(wantProxy, home).changedAt, first);
});

test("status names whether re-applying would help: never for another installation's entry, a hybrid configuration or direct on", async () => {
  resetLibrary();
  await withPickerAdmin(async ({ port }) => {
    assert.deepEqual(await pickerEntry(port), { state: "missing", holder: null, reapply: true });

    fs.mkdirSync(configLibraryDir(), { recursive: true });
    const def = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
    const desktop = { appliedId: def, entries: [{ id: def, name: "Default" }] };
    fs.writeFileSync(path.join(configLibraryDir(), "_meta.json"), JSON.stringify(desktop));
    fs.writeFileSync(path.join(configLibraryDir(), `${def}.json`), "{}");
    assert.deepEqual(await pickerEntry(port), { state: "other", holder: "app", reapply: true }, "the app's own choice: re-apply replaces it, and off restores it");

    fs.writeFileSync(path.join(configLibraryDir(), "_meta.json"), JSON.stringify({ ...desktop, hybridPointer: { bootstrapUrl: "https://config.claude.com/bootstrap" } }));
    assert.deepEqual(await pickerEntry(port), { state: "other", holder: "hybrid", reapply: false });
    assert.deepEqual(await problems(port), ["picker-proxy"], "still not in effect");

    resetLibrary();
    applyAppProxy("http://127.0.0.1:19991", path.join(root, "other-home"));
    assert.deepEqual(await pickerEntry(port), { state: "other", holder: "installation", reapply: false });

    resetLibrary();
    fs.writeFileSync(path.join(home, "direct.json"), "{}");
    assert.equal((await pickerEntry(port))?.reapply, false, "`direct off` is the way back");
  });
});

test("POST /api/picker/reapply runs `picker reapply` only, says why when it fails, and refuses a cross-site request", async () => {
  resetLibrary();
  await withPickerAdmin(async ({ port, calls, setCli }) => {
    const ok = await fetch(`http://127.0.0.1:${port}/api/picker/reapply`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, output: "✓ applied" });
    assert.deepEqual(calls, [["picker", "reapply"]], "never `picker off`, which would remove the CA");

    setCli({ ok: false, output: "error: picker mode is off, so there is no entry to apply again." });
    const failed = await fetch(`http://127.0.0.1:${port}/api/picker/reapply`, { method: "POST" });
    assert.equal(failed.status, 500);
    assert.match((await failed.json() as { output: string }).output, /picker mode is off/);

    const cross = await fetch(`http://127.0.0.1:${port}/api/picker/reapply`, { method: "POST", headers: { origin: "http://evil.example" } });
    assert.equal(cross.status, 403);
    assert.equal(calls.length, 2);
  });
});

test("a CONNECT to a picker host records Claude Desktop's traffic; the API host and picker mode off do not", (t) => {
  for (const [picker, host, counts] of [[true, "claude.ai", true], [true, "api.anthropic.com", false], [false, "claude.ai", false]] as const) {
    const dir = fs.mkdtempSync(path.join(root, "proxy-"));
    const proxy = new Proxy({
      config: () => ({ ...DEFAULTS, picker: { enabled: picker } }),
      log: new Logger(null, 1e6, 1, false),
      certs: new CertStore(dir),
      health: new UpstreamHealth(() => 100, () => {}),
      home: dir,
      requests: new RequestLog(path.join(dir, "requests.jsonl")),
    });
    const socket = new net.Socket();
    t.mock.method(socket, "write", () => true);
    const inner = proxy as unknown as { onConnect: (s: net.Socket) => void; terminate: () => void; tunnel: () => void };
    t.mock.method(inner, "terminate", () => {});
    t.mock.method(inner, "tunnel", () => {});
    try {
      assert.equal(proxy.lastPickerTrafficAt, null);
      const before = Date.now();
      inner.onConnect(socket);
      socket.emit("data", Buffer.from(`CONNECT ${host}:443 HTTP/1.1\r\n\r\n`));
      if (counts) assert.ok(proxy.lastPickerTrafficAt !== null && proxy.lastPickerTrafficAt >= before, `${host} picker=${picker}`);
      else assert.equal(proxy.lastPickerTrafficAt, null, `${host} picker=${picker}`);
    } finally {
      socket.destroy();
      proxy.close();
    }
  }
});
