// `clauderipple doctor` and `clauderipple repair`: what is wrong with the chain Claude depends on,
// and the idempotent fix. Both serve the menu-bar app, which has to work when the router — and
// with it the dashboard — is down: Claude Desktop and Claude Code send everything to 127.0.0.1
// and fail with ECONNREFUSED, and nothing the router serves can explain why (2026-10-20).
//
// Everything that reaches the machine is a dependency (`RecoveryDeps`), so tests run with a fake
// supervisor and temp files and never touch launchd, the user's settings or the live router.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore, adminPort, type Config } from "../../router/src/config.ts";
import { certPaths } from "./certs.ts";
import { claudeBinary, claudeCodeLogin, claudeLoginHint, type ClaudeCodeLogin } from "./claude-auth.ts";
import { applyAppProxy, appProxyState, caTrusted, currentAppProxy, restoreMissingAppProxy, type AppProxyState } from "./picker.ts";
import { applyProxyEnv, settingsEnv } from "./settings.ts";
import type { AgentState } from "./supervisor.ts";
import type { SupervisorOps, SupervisorView } from "./registration.ts";
import { sameHome } from "./ownership.ts";

export type Mode = "ripple" | "direct" | "mixed";
export type ProxyState = "ripple" | "none" | "other";
export type Problem = { code: string; message: string };

export type DoctorReport = {
  mode: Mode;
  router: { responding: boolean; version: string | null; pid: number | null; url: string; adminUrl: string };
  supervisor: { registered: boolean; program: string | null; programExists: boolean; state: AgentState; installedHome: string | null };
  desktop: { proxy: ProxyState; url: string | null };
  cli: { proxy: ProxyState; url: string | null };
  problems: Problem[];
};

export type RepairStep = { name: string; ok: boolean; detail: string };
export type RepairReport = { ok: boolean; steps: RepairStep[]; doctor: DoctorReport };

export type RouterStatus = { version: string | null };

export type RecoveryDeps = {
  home: string;
  /** This CLI's version, to compare with the running router's. */
  version: string;
  supervisor: SupervisorOps;
  /** GET /api/status on the admin port; null when the router does not answer within `timeoutMs`. */
  routerStatus?: (adminUrl: string, timeoutMs: number) => Promise<RouterStatus | null>;
  sleep?: (ms: number) => Promise<void>;
  /** How long repair waits for the router to answer after starting it. */
  healthBudgetMs?: number;
  /** Whether the phone host's background service is installed on this machine. */
  remoteHostInstalled?: () => boolean | Promise<boolean>;
  /** Whether the Claude Code CLI itself has a login (the phone host's sessions need one). */
  claudeLogin?: () => Promise<ClaudeCodeLogin>;
  /** Whether the system trusts our CA; asked only before repair would point Claude Desktop at the router. */
  caTrusted?: (caPem: string) => boolean;
};

export async function fetchRouterStatus(adminUrl: string, timeoutMs: number): Promise<RouterStatus | null> {
  try {
    const res = await fetch(`${adminUrl}/api/status`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return { version: typeof body.version === "string" ? body.version : null };
  } catch {
    return null;
  }
}

const sleepDefault = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const LOOPBACK_PROXY = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/?$/;

export function proxyUrlFor(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * Claude Code's proxy, from settings.json env. `stale` is a proxy that is ours — our CA beside a
 * loopback URL — on a port the config no longer listens on: the one case repair may rewrite.
 */
export function cliProxyState(env: Record<string, string>, proxyUrl: string, caPath: string): { proxy: ProxyState; url: string | null; stale: boolean } {
  const url = env.HTTPS_PROXY || null;
  if (!url) return { proxy: "none", url: null, stale: false };
  if (url === proxyUrl) return { proxy: "ripple", url, stale: false };
  return { proxy: "other", url, stale: env.NODE_EXTRA_CA_CERTS === caPath && LOOPBACK_PROXY.test(url) };
}

/** Claude Desktop's proxy, from the applied Config Library entry. An entry with no proxy is "none". */
export function desktopProxyState(ap: ReturnType<typeof currentAppProxy>, proxyUrl: string): { proxy: ProxyState; url: string | null; stale: boolean } {
  const url = ap.egressProxyUrl;
  if (!url) return { proxy: "none", url: null, stale: false };
  if (url === proxyUrl) return { proxy: "ripple", url, stale: false };
  return { proxy: "other", url, stale: ap.ours };
}

/**
 * Claude Code always goes through the router in Ripple mode; Claude Desktop itself only when picker
 * mode is on (the Code tab's sessions read settings.json either way). Nothing through us is
 * "direct"; anything in between is "mixed".
 */
export function classifyMode(cli: ProxyState, desktop: ProxyState, pickerEnabled: boolean): Mode {
  const cliRipple = cli === "ripple";
  const desktopRipple = desktop === "ripple";
  if (cliRipple && (desktopRipple || !pickerEnabled)) return "ripple";
  if (!cliRipple && !desktopRipple) return "direct";
  return "mixed";
}

type Snapshot = {
  report: DoctorReport;
  installed: boolean;
  cfg: Config;
  view: SupervisorView;
  caPath: string;
  cliStale: boolean;
  desktopStale: boolean;
  /** Picker mode is on, `direct on` is not, and Claude Desktop has nothing of ours applied (appProxyState "missing"). */
  desktopMissing: boolean;
};

/**
 * The Desktop side of a doctor report, from what the app will read. Desktop reads nothing when
 * nothing is applied, when a hybrid pointer stands in for the entry, or when _meta.json or the
 * applied entry cannot be read (Desktop 6.6395, `_5()`/`wpe()` in index.pre.js return nothing on a
 * read error), so those are "none": it goes direct; an unreadable file used to make doctor and
 * repair throw. `stale` (repair rewrites it) is this installation's own entry only: another
 * installation's on another port is that installation's proxy, which repair could never rewrite.
 */
function desktopSide(entry: AppProxyState, proxyUrl: string): { proxy: ProxyState; url: string | null; stale: boolean } {
  const url = entry.egressProxyUrl;
  if (entry.state === "applied") return { proxy: "ripple", url, stale: false };
  if (entry.state === "stale") return { proxy: url ? "other" : "none", url, stale: true };
  if (entry.state === "other" && url) return { proxy: url === proxyUrl ? "ripple" : "other", url, stale: false };
  return { proxy: "none", url: null, stale: false };
}

function configFile(home: string): string {
  return path.join(home, "config.json");
}

/**
 * Whether the phone host's own background service is installed here (a launchd agent, a scheduled
 * task, a systemd user unit). The host package owns that path, so it is asked for it; a host that
 * is not installed cannot need a CLI login of its own.
 */
async function remoteHostInstalled(): Promise<boolean> {
  try {
    const { servicePaths } = await import("../../remote/src/host-service.ts");
    return fs.existsSync(servicePaths(process.platform, os.homedir()).definition);
  } catch {
    // A host package that cannot be read is a host that is not installed here.
    return false;
  }
}

async function snapshot(deps: RecoveryDeps): Promise<Snapshot> {
  const installed = fs.existsSync(configFile(deps.home));
  const cfg = new ConfigStore(configFile(deps.home)).get();
  const proxyUrl = proxyUrlFor(cfg.listen.port);
  const adminUrl = `http://127.0.0.1:${adminPort(cfg)}`;
  const caPath = certPaths(deps.home).caPem;
  const status = await (deps.routerStatus ?? fetchRouterStatus)(adminUrl, 4_000);
  const view = deps.supervisor.inspect();
  const cli = cliProxyState(settingsEnv(), proxyUrl, caPath);
  const entry = appProxyState(proxyUrl, deps.home);
  const desktop = desktopSide(entry, proxyUrl);
  const pickerEnabled = cfg.picker?.enabled === true;
  // `direct on` takes our entry off on purpose and keeps it in direct.json for `direct off`.
  const directOn = fs.existsSync(path.join(deps.home, "direct.json"));
  const mode = classifyMode(cli.proxy, desktop.proxy, pickerEnabled);

  const problems: Problem[] = [];
  const add = (code: string, message: string): void => void problems.push({ code, message });
  if (!installed) add("not-installed", `ClaudeRipple is not installed here (no ${configFile(deps.home)}). Run: clauderipple install`);
  // A service manager that cannot be asked says nothing about whether the service is there: say
  // only what failed, and never offer "repair" as if the entry were missing (D7, 2026-10-25).
  if (view.lookupError) add("supervisor-state-unknown", `The router's startup service could not be inspected (${view.lookupError}). It was not started, stopped or replaced.`);
  else if (!view.registered) add("supervisor-missing", "The router is not registered to start at login, so nothing starts it. Repair registers it again.");
  else if (view.installedHome !== null && !sameHome(view.installedHome, deps.home)) add("supervisor-other-install", `The router's startup entry belongs to another ClaudeRipple installation (${view.installedHome}). This installation cannot start, stop or repair it.`);
  else if (!view.programExists) add("supervisor-program-missing", `The router's startup entry points at a program that no longer exists (${view.program ?? "none"}). Repair points it at this installation.`);
  else if (!view.current) {
    if (view.installedHome === null) add("supervisor-other-install", `The router's startup entry does not record which installation it belongs to (${view.program}).`);
    else if (sameHome(view.installedHome, deps.home)) add("supervisor-outdated", `The router's startup entry is out of date for this installation (${view.program}). Repair points it at the current files.`);
    else add("supervisor-other-install", `The router's startup entry belongs to another ClaudeRipple installation (${view.program}).`);
  }
  if (!status) {
    add("router-down", `The router is not answering on ${adminUrl}. ${mode === "direct" ? "Claude is on its default connection, so it is not affected." : "Claude Desktop and Claude Code cannot connect while it is down."}`);
    if (view.registered && view.state !== "running" && view.state !== "unknown") add("supervisor-not-running", "The router's background service is not running.");
  } else if (status.version && status.version !== deps.version) {
    add("router-version-mismatch", `The running router is ${status.version}; this ClaudeRipple is ${deps.version}.`);
  }
  if (cli.stale) add("cli-port-mismatch", `Claude Code is set to a ClaudeRipple port that is no longer used (${cli.url}; the router listens on ${proxyUrl}).`);
  else if (cli.proxy === "other") add("cli-foreign-proxy", `Claude Code goes through another proxy (${cli.url}), not ClaudeRipple.`);
  // Our entry on an old port leaves the app on a dead or wrong router, so repair rewrites it. Our
  // entry naming no proxy leaves the app direct and working, as a missing one does: it is not a
  // port to move but an entry to apply again, under the same guards (picker mode, router, CA).
  const desktopNoProxy = desktop.stale && desktop.url === null;
  const desktopStale = desktop.stale && !desktopNoProxy;
  if (desktopStale) add("desktop-port-mismatch", `Claude Desktop is set to a ClaudeRipple port that is no longer used (${desktop.url}; the router listens on ${proxyUrl}).`);
  else if (desktop.proxy === "other") add("desktop-foreign-proxy", `Claude Desktop goes through another proxy (${desktop.url}), not ClaudeRipple.`);
  // Picker mode on and nothing of ours applied: Desktop goes direct and its picker lists no routed
  // model, and restarting it changes nothing (2026-11-19, a deleted Claude-3p folder).
  const desktopMissing = pickerEnabled && !directOn && (entry.state === "missing" || desktopNoProxy);
  if (desktopMissing) {
    add("desktop-entry-missing", `Picker mode is on, but Claude Desktop ${desktopNoProxy ? "has a ClaudeRipple entry that names no proxy" : `has no ClaudeRipple entry to read (${entry.reason})`}, so it goes direct and its picker shows no routed models. Repair applies it again once the router answers and the ClaudeRipple CA is trusted (\`clauderipple picker on\` trusts it); then quit and reopen Claude Desktop.`);
  } else if (pickerEnabled && !directOn && entry.state === "other" && desktop.proxy === "none") {
    // Advise only what works: `picker reapply` replaces the app's own choice, and refuses the others.
    add("desktop-entry-other",
      entry.holder === "hybrid" ? `Picker mode is on, but Claude Desktop applies a hybrid configuration, which it reads instead of any entry, so ClaudeRipple's cannot take effect. It is left as it is: end it in Claude Desktop, or turn picker mode off.`
      : entry.holder === "installation" ? `Picker mode is on, but Claude Desktop's Config Library holds another ClaudeRipple installation's entry (${entry.reason}). It is left as it is: turn picker mode off in that installation, or remove its entry in Claude Desktop.`
      : `Picker mode is on, but Claude Desktop applies another configuration (${entry.reason}). Repair leaves it as it is; \`clauderipple picker reapply\` applies ClaudeRipple's instead (\`picker off\` restores the current one).`);
  } else if (pickerEnabled && !directOn && entry.state === "unknown") {
    add("desktop-entry-unreadable", `Picker mode is on, but Claude Desktop's Config Library cannot be read (${entry.reason}). It was left untouched.`);
  }
  if (mode === "mixed") add("mixed-mode", `Claude Code ${cli.proxy === "ripple" ? "goes" : "does not go"} through ClaudeRipple, Claude Desktop ${desktop.proxy === "ripple" ? "does" : "does not"}.`);
  // The phone host starts Claude Code through the Agent SDK and passes no credential of its own, so
  // without a login of the CLI's own every turn fails at once (issue #71).
  if (await (deps.remoteHostInstalled ?? remoteHostInstalled)()) {
    const login = await (deps.claudeLogin ?? (() => claudeCodeLogin()))();
    if (!login.ok) add("cli-not-logged-in", `Claude Code has no login on this computer, so the phone host's sessions fail at once. ${claudeLoginHint(claudeBinary())}`);
  }

  return {
    report: {
      mode,
      router: { responding: status !== null, version: status?.version ?? null, pid: view.pid, url: proxyUrl, adminUrl },
      supervisor: { registered: view.registered, program: view.program, programExists: view.programExists, state: view.state, installedHome: view.installedHome },
      desktop: { proxy: desktop.proxy, url: desktop.url },
      cli: { proxy: cli.proxy, url: cli.url },
      problems,
    },
    installed,
    cfg,
    view,
    caPath,
    cliStale: cli.stale,
    desktopStale,
    desktopMissing,
  };
}

export async function doctor(deps: RecoveryDeps): Promise<DoctorReport> {
  return (await snapshot(deps)).report;
}

/**
 * Fixes what doctor finds, in order, and is safe to run again: re-register the supervisor for this
 * installation, start it, wait for it to answer, correct a Claude proxy setting that is ours but
 * names an old port, and, in picker mode with a router that answers, apply Claude Desktop's entry
 * again when nothing is applied at all. It never switches between Ripple and direct mode (that is
 * `direct on|off`) and never touches a proxy setting or Config Library entry that is not ours.
 */
export async function repair(deps: RecoveryDeps): Promise<RepairReport> {
  const sleep = deps.sleep ?? sleepDefault;
  const status = deps.routerStatus ?? fetchRouterStatus;
  const steps: RepairStep[] = [];
  const before = await snapshot(deps);
  if (!before.installed) {
    steps.push({ name: "config", ok: false, detail: `no ${configFile(deps.home)}; run \`clauderipple install\` first` });
    return { ok: false, steps, doctor: before.report };
  }
  const responding = before.report.router.responding;
  const view = before.view;

  // A working router is never cut off for a definition that merely differs: re-registering unloads
  // the running job, which drains it and drops every Claude connection (ARCHITECTURE §5).
  // A definition that records another installation (or none) is not this one's to replace (B01).
  // `current` already means byte-for-byte this installation's, so only a differing definition needs
  // its owner read; an injected supervisor that reports `current` is accepted as this one's.
  const foreign = view.registered && !view.current && view.installedHome !== null && !sameHome(view.installedHome, deps.home);
  const unidentified = view.registered && !view.current && view.installedHome === null;
  // A lookup that failed is not evidence of absence: registering now could overwrite a definition
  // this installation could not read. Leave it and say what failed.
  const uninspectable = !!view.lookupError;
  const mustRegister = !uninspectable && !foreign && !unidentified && (!view.registered || !view.programExists || (!view.current && !responding));
  if (uninspectable) {
    steps.push({ name: "supervisor", ok: false, detail: `left as it is: the startup service could not be inspected (${view.lookupError})` });
  } else if (foreign || unidentified) {
    steps.push({
      name: "supervisor",
      ok: responding,
      detail: foreign
        ? `left as it is: the startup entry belongs to another ClaudeRipple installation (${view.installedHome}), so this one cannot stop or replace it`
        : "left as it is: the startup entry does not record an installation, so its owner cannot be identified",
    });
  } else if (mustRegister) {
    try {
      const where = deps.supervisor.register();
      steps.push({ name: "supervisor", ok: true, detail: `registered for this installation: ${where}` });
    } catch (e) {
      steps.push({ name: "supervisor", ok: false, detail: (e as Error).message });
    }
  } else {
    steps.push({
      name: "supervisor",
      ok: true,
      detail: view.current ? "already registered for this installation" : `left as it is: the router answers, and its entry names another installation (${view.program}); run \`clauderipple install\` to move it`,
    });
  }

  if (responding) {
    steps.push({ name: "start", ok: true, detail: "the router is already answering" });
  } else if (uninspectable) {
    steps.push({ name: "start", ok: false, detail: "not started: the startup service could not be inspected" });
  } else if (foreign || unidentified) {
    steps.push({ name: "start", ok: false, detail: "not started: the startup entry belongs to another installation" });
  } else {
    let started: ReturnType<SupervisorOps["start"]> | null = null;
    let startError: string | null = null;
    try {
      started = deps.supervisor.start();
    } catch (e) {
      startError = (e as Error).message;
    }
    steps.push({
      name: "start",
      ok: startError === null && started !== "failed" && started !== "other-installation" && started !== "ownership-unknown",
      detail:
        startError !== null ? `the supervisor could not start the router: ${startError}`
        : started === "failed" ? "the supervisor could not start the router"
        : started === "other-installation" ? "not started: the startup entry belongs to another installation"
        : started === "ownership-unknown" ? "not started: the startup entry does not record an installation"
        : started === "already-running" ? "the supervisor reports it running"
        : "started",
    });
    if (startError === null) {
      const adminUrl = before.report.router.adminUrl;
      const budget = deps.healthBudgetMs ?? 20_000;
      const t0 = Date.now();
      let up = false;
      while (!up) {
        up = (await status(adminUrl, 3_000)) !== null;
        if (up || Date.now() - t0 >= budget) break;
        await sleep(1_000);
      }
      steps.push({ name: "health", ok: up, detail: up ? `answering on ${adminUrl} after ${Math.round((Date.now() - t0) / 100) / 10}s` : `still not answering on ${adminUrl} after ${Math.round(budget / 1000)}s; see ${path.join(deps.home, "logs", "router.log")}` });
    }
  }

  const proxyUrl = proxyUrlFor(before.cfg.listen.port);
  if (before.cliStale) {
    try {
      // Ours by our CA beside a loopback URL (cliProxyState), so replacing it is not overriding anyone.
      const edit = applyProxyEnv({ proxyUrl, caPath: before.caPath, force: true, home: deps.home });
      steps.push({ name: "cli-proxy", ok: true, detail: `Claude Code now points at ${proxyUrl}${edit.backup ? ` (backup: ${edit.backup})` : ""}` });
    } catch (e) {
      steps.push({ name: "cli-proxy", ok: false, detail: (e as Error).message });
    }
  }
  if (before.desktopStale) {
    try {
      applyAppProxy(proxyUrl, deps.home);
      steps.push({ name: "desktop-proxy", ok: true, detail: `Claude Desktop now points at ${proxyUrl} (quit and reopen it to apply)` });
    } catch (e) {
      steps.push({ name: "desktop-proxy", ok: false, detail: (e as Error).message });
    }
  } else if (before.desktopMissing) {
    // In picker mode every byte the app sends goes through the router (ARCHITECTURE §5): an entry
    // pointing at one that does not answer would turn a working, direct Desktop into a blank page.
    const routerUp = responding || steps.some((s) => s.name === "health" && s.ok);
    if (!routerUp) {
      steps.push({ name: "desktop-proxy", ok: false, detail: "Claude Desktop's ClaudeRipple entry is missing; not applied again while the router does not answer, since the app could not connect through it" });
    } else if (!(deps.caTrusted ?? caTrusted)(before.caPath)) {
      // Picker mode terminates claude.ai with a leaf from our CA: over an untrusted CA every page
      // fails ERR_CERT_AUTHORITY_INVALID (ARCHITECTURE §5, new Mac 2026-10-06). Desktop going direct
      // is the working state, so it stays; `picker on` asks the system to trust the CA first.
      steps.push({ name: "desktop-proxy", ok: false, detail: "Claude Desktop's ClaudeRipple entry is missing; not applied again because the ClaudeRipple CA is not trusted, and the app could not load claude.ai through it. Run `clauderipple picker on`, which asks the system to trust it" });
    } else {
      try {
        // Only while it is still missing: whatever was applied in the meantime is not replaced.
        const restored = restoreMissingAppProxy(proxyUrl, deps.home);
        steps.push(restored
          ? { name: "desktop-proxy", ok: true, detail: `Claude Desktop's ClaudeRipple entry was missing; applied it again (${restored.id}, ${proxyUrl}). Quit and reopen Claude Desktop to use it` }
          : { name: "desktop-proxy", ok: true, detail: "left as it is: Claude Desktop's Config Library changed while repairing, and what it applies now is not replaced" });
      } catch (e) {
        steps.push({ name: "desktop-proxy", ok: false, detail: (e as Error).message });
      }
    }
  }

  const after = await doctor(deps);
  return { ok: steps.every((s) => s.ok) && after.router.responding, steps, doctor: after };
}
