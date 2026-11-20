// `clauderipple direct on|off` — "use Claude's default connection" and back.
//
// on:  takes Claude Code (settings.json env) and Claude Desktop (our Config Library entry) off the
//      router, removing only values that are ours, and keeps what it removed in <home>/direct.json.
//      The router, CA trust, agent files and the status mod are left alone, so `off` is instant.
// off: puts back exactly what direct.json kept. A proxy someone set in the meantime is refused
//      unless forced, and a router that is not answering is repaired first: pointing Claude at a
//      dead router is the failure this command exists to get out of.
//
// Both need Claude restarted: Desktop reads its proxy at start, Claude Code sessions at start.

import fs from "node:fs";
import path from "node:path";
import { ConfigStore, adminPort, type Config } from "../../router/src/config.ts";
import { certPaths } from "./certs.ts";
import { classifyMode, cliProxyState, desktopProxyState, fetchRouterStatus, proxyUrlFor, repair, type Mode, type RecoveryDeps } from "./doctor.ts";
import { writeJsonAtomic } from "../../router/src/locked-file.ts";
import { claimedElsewhere, claimsOf, readOwners } from "./owners.ts";
import type { DesktopServiceDeps } from "./desktop-service.ts";
import { applyAppProxy, appProxyOwner, appProxyState, currentAppProxy, migrateLegacyAppProxy, removeAppProxy } from "./picker.ts";
import { MODEL_SLOT_ENV, editSettingsEnv, isNativeClaudeModel, settingsEnv, settingsPath } from "./settings.ts";

export type DirectResult = { ok: boolean; mode: Mode; restartClaude: true; detail: string };

/** What `direct on` removed, so `direct off` can put back exactly that. */
export type DirectState = {
  at: string;
  /** settings.json env keys and the values they had. */
  cli: Record<string, string>;
  /** Our Config Library entry's proxy, and which entry was applied once ours was gone. */
  desktop: { egressProxyUrl: string; appliedAfter: string | null } | null;
};

export function directStatePath(home: string): string {
  return path.join(home, "direct.json");
}

function readState(home: string): DirectState | null {
  let text: string;
  try {
    text = fs.readFileSync(directStatePath(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const s = JSON.parse(text) as DirectState;
  if (!s || typeof s.at !== "string" || !s.cli || Array.isArray(s.cli) || typeof s.cli !== "object" || !Object.values(s.cli).every(v => typeof v === "string") ||
      (s.desktop !== null && (!s.desktop || typeof s.desktop.egressProxyUrl !== "string" || (s.desktop.appliedAfter !== null && typeof s.desktop.appliedAfter !== "string")))) {
    throw new Error(`invalid direct snapshot: ${directStatePath(home)}; left untouched`);
  }
  return s;
}

function config(home: string): Config {
  return new ConfigStore(path.join(home, "config.json")).get();
}

function currentMode(home: string): Mode {
  const cfg = config(home);
  const proxyUrl = proxyUrlFor(cfg.listen.port);
  const cli = cliProxyState(settingsEnv(), proxyUrl, certPaths(home).caPem);
  const desktop = desktopProxyState(currentAppProxy(), proxyUrl);
  return classifyMode(cli.proxy, desktop.proxy, cfg.picker?.enabled === true);
}

export function directOn(home: string, desktopService: DesktopServiceDeps = {}): DirectResult {
  const cfg = config(home);
  const proxyUrl = proxyUrlFor(cfg.listen.port);
  const legacy = currentAppProxy();
  if (legacy.ours && legacy.installationHome === undefined && legacy.egressProxyUrl === proxyUrl) migrateLegacyAppProxy(proxyUrl, home, desktopService);
  const caPath = certPaths(home).caPem;
  const removedCli: Record<string, string> = {};
  const notes: string[] = [];

  let blocked = false;
  let desktop: DirectState["desktop"] = null;
  const edit = editSettingsEnv((env) => {
    const previous = readState(home);
    const record = readOwners(settingsPath());
    if (record.error) throw new Error(record.error);
    const mine = claimsOf(record.store, home);
    const proxy = cliProxyState(env, proxyUrl, caPath);
    // Validate the whole transition before changing either client or the restoration snapshot.
    const app = currentAppProxy();
    // An entry ClaudeRipple did not mark (the person's own proxy, or the one picker mode replaced
    // and direct on restores) is theirs to keep; only a marked entry this home cannot prove stops it.
    if (app.egressProxyUrl && app.ours && (appProxyOwner(app, home, proxyUrl) !== "ours" || app.egressProxyUrl !== proxyUrl)) {
      notes.push("Claude Desktop 프록시의 설치 소유권을 확인하지 못해 직접 연결로 전환하지 않았습니다. 기존 프록시 설정을 확인해 주세요.");
      blocked = true;
    }
    if (env.HTTPS_PROXY && !((proxy.proxy === "ripple" || proxy.stale) && env.NODE_EXTRA_CA_CERTS === caPath)) {
      notes.push("Claude Code 프록시의 설치 소유권을 확인하지 못해 직접 연결로 전환하지 않았습니다. 기존 프록시 설정을 확인해 주세요.");
      blocked = true;
    }
    for (const [slot, name] of Object.entries(MODEL_SLOT_ENV)) {
      const value = env[name];
      if (value === undefined || isNativeClaudeModel(value)) continue;
      if (mine.slots?.[slot] !== value || claimedElsewhere(record.store, home, c => c.slots?.[slot], value)) {
        notes.push(`left ${name} (ownership unknown or shared)`);
        blocked = true;
      }
    }
    if (blocked) return false;
    if ((proxy.proxy === "ripple" || proxy.stale) && env.NODE_EXTRA_CA_CERTS === caPath) {
      removedCli.HTTPS_PROXY = env.HTTPS_PROXY!;
      delete env.HTTPS_PROXY;
    } else if (env.HTTPS_PROXY) notes.push(`left HTTPS_PROXY=${env.HTTPS_PROXY} (not ClaudeRipple's)`);
    if (env.NODE_EXTRA_CA_CERTS === caPath) {
      removedCli.NODE_EXTRA_CA_CERTS = env.NODE_EXTRA_CA_CERTS;
      delete env.NODE_EXTRA_CA_CERTS;
    }
    // A slot naming a routed model makes every request on it fail once the router is out of the
    // path (Anthropic answers 404), so those go too — but only when Claude Code is now direct.
    if (!env.HTTPS_PROXY) {
      for (const [slot, name] of Object.entries(MODEL_SLOT_ENV)) {
        const value = env[name];
        if (value === undefined || isNativeClaudeModel(value)) continue;
        const ours = mine.slots?.[slot] === value && !claimedElsewhere(record.store, home, c => c.slots?.[slot], value);
        if (!ours) {
          notes.push(`left ${name} (ownership unknown or shared)`);
          continue;
        }
        removedCli[name] = value;
        delete env[name];
      }
    }
    const ap = currentAppProxy();
    if (appProxyOwner(ap, home, proxyUrl) === "ours" && ap.egressProxyUrl === proxyUrl) {
      desktop = { egressProxyUrl: proxyUrl, appliedAfter: ap.previousAppliedId ?? null };
    } else if (ap.egressProxyUrl) notes.push("left Claude Desktop proxy (ownership unknown or another installation)");
    // Durable write-ahead snapshot: a failed save leaves both clients unchanged. If a later client
    // write fails, this snapshot remains available; repeated on never replaces its original values.
    if (Object.keys(removedCli).length > 0 || desktop) {
      for (const [key, value] of Object.entries(removedCli)) {
        if (previous?.cli[key] !== undefined && previous.cli[key] !== value) throw new Error(`direct snapshot conflicts with current ${key}; left untouched`);
      }
      const state: DirectState = { at: previous?.at ?? new Date().toISOString(), cli: { ...removedCli, ...(previous?.cli ?? {}) }, desktop: previous?.desktop ?? desktop };
      fs.mkdirSync(home, { recursive: true });
      writeJsonAtomic(directStatePath(home), state);
      if (desktop) removeAppProxy(proxyUrl, home);
    }
    return Object.keys(removedCli).length > 0;
  });

  if (blocked) return { ok: false, mode: currentMode(home), restartClaude: true, detail: notes.join(" ") };
  const changed = edit.changed || desktop !== null;
  const removed = [
    ...Object.keys(removedCli).map((k) => `settings.json env.${k}`),
    ...(desktop ? ["Claude Desktop's proxy entry"] : []),
  ];
  const detail = changed
    ? `Claude now connects directly. Removed: ${removed.join(", ")}. Saved in ${directStatePath(home)}.${edit.backup ? ` settings.json backup: ${edit.backup}.` : ""}`
    : "Claude was already on its default connection; nothing of ClaudeRipple's was in its settings.";
  const mode = currentMode(home);
  // Direct means nothing of this installation's proxy is left. A proxy the person had before
  // (restored by removeAppProxy) or set themselves is theirs, not a leftover.
  const after = currentAppProxy();
  const desktopLeft = after.egressProxyUrl === proxyUrl || (after.ours && appProxyOwner(after, home, proxyUrl) !== "other");
  const complete = mode === "direct" && settingsEnv().HTTPS_PROXY !== proxyUrl && !desktopLeft;
  return { ok: complete, mode, restartClaude: true, detail: complete ? [detail, ...notes].join(" ") : "일부 프록시 설정이 남아 직접 연결로 전환하지 못했습니다. 저장된 복구 정보와 클라이언트 설정을 확인해 주세요." };
}

export async function directOff(deps: RecoveryDeps, opts: { force?: boolean } = {}): Promise<DirectResult> {
  const home = deps.home;
  const cfg = config(home);
  const proxyUrl = proxyUrlFor(cfg.listen.port);
  const saved = readState(home);
  if (!saved) return { ok: true, mode: currentMode(home), restartClaude: true, detail: "No direct snapshot; settings left untouched." };
  const cli: Record<string, string> = { ...saved.cli, ...(saved.cli.HTTPS_PROXY ? { HTTPS_PROXY: proxyUrl } : {}) };
  const desktopUrl = saved.desktop ? proxyUrl : null;
  const fail = (detail: string): DirectResult => ({ ok: false, mode: currentMode(home), restartClaude: true, detail });

  // Something set since `direct on` is someone else's choice, and replacing it needs saying so.
  const env = settingsEnv();
  if (!opts.force && cli.HTTPS_PROXY && env.HTTPS_PROXY && env.HTTPS_PROXY !== cli.HTTPS_PROXY) {
    return fail(`settings.json now sets HTTPS_PROXY=${env.HTTPS_PROXY}, which is not ClaudeRipple's; left everything as it is. Run \`clauderipple direct off --force\` to replace it.`);
  }
  const ap = currentAppProxy();
  const desktopChanged = ap.appliedId !== (saved?.desktop?.appliedAfter ?? ap.appliedId);
  if (!opts.force && desktopUrl && ap.egressProxyUrl && ap.egressProxyUrl !== desktopUrl && (desktopChanged || !saved)) {
    return fail(`Claude Desktop now uses another proxy (${ap.egressProxyUrl}); left everything as it is. Run \`clauderipple direct off --force\` to replace it.`);
  }

  const notes: string[] = [];
  if ((await (deps.routerStatus ?? fetchRouterStatus)(`http://127.0.0.1:${adminPort(cfg)}`, 4_000)) === null) {
    const fixed = await repair(deps);
    if (!fixed.doctor.router.responding) {
      const failed = fixed.steps.filter((s) => !s.ok).map((s) => `${s.name}: ${s.detail}`).join("; ");
      return fail(`the router is not answering even after a repair (${failed || "no step failed, it just did not come up"}), so Claude stays on its default connection.`);
    }
    notes.push("The router was not answering; repaired it first.");
  }

  const restoredKeys: string[] = [];
  let desktopApplied = false;
  let desktopSkipped = false;
  const edit = editSettingsEnv((current) => {
    // Recheck after the asynchronous health/repair boundary, under the shared settings lock.
    if (JSON.stringify(readState(home)) !== JSON.stringify(saved)) throw new Error("direct snapshot changed while waiting; left untouched");
    const record = readOwners(settingsPath());
    if (record.error) throw new Error(record.error);
    for (const [k, v] of Object.entries(cli)) {
      const slot = Object.entries(MODEL_SLOT_ENV).find(([, name]) => name === k)?.[0];
      if (slot && (claimsOf(record.store, home).slots?.[slot] !== v || claimedElsewhere(record.store, home, c => c.slots?.[slot], v))) throw new Error(`cannot restore unowned or shared slot ${k}; left untouched`);
      if (current[k] !== undefined && current[k] !== v && (slot || !opts.force)) throw new Error(`${k} changed since direct on; left untouched`);
      if (current[k] !== env[k]) throw new Error(`${k} changed while waiting; left untouched`);
    }
    const now = currentAppProxy();
    if (desktopUrl && (now.appliedId !== ap.appliedId || now.egressProxyUrl !== ap.egressProxyUrl)) throw new Error("Desktop proxy changed while waiting; left untouched");
    for (const [k, v] of Object.entries(cli)) {
      if (current[k] !== v) {
        current[k] = v;
        restoredKeys.push(k);
      }
    }
    if (desktopUrl && appProxyOwner(now, home, desktopUrl) !== "ours") {
      // Desktop's side is refused while a hybrid configuration or another installation's entry holds
      // it (applyAppProxy throws, and the throw would also cancel Claude Code's restore here): Claude
      // Code goes back to ClaudeRipple, and the note says why Desktop did not.
      // Another installation's applied entry naming the same URL reads as "applied" (one router
      // answers both), and apply refuses it too.
      const entry = appProxyState(desktopUrl, home);
      const held = (entry.state === "other" && (entry.holder === "hybrid" || entry.holder === "installation")) || (now.ours && appProxyOwner(now, home, desktopUrl) === "other");
      if (held) {
        desktopSkipped = true;
        notes.push(`Claude Desktop's ClaudeRipple entry was not put back: ${entry.reason}, which is left as it is. Once that changes, \`clauderipple picker reapply\` applies it.`);
      } else {
        try {
          applyAppProxy(desktopUrl, home, now);
          desktopApplied = true;
        } catch (error) {
          // Whatever else apply refuses (an owner it cannot verify, a list it cannot read) is said,
          // not thrown: Claude Code's half of the restore does not depend on it.
          desktopSkipped = true;
          notes.push(`Claude Desktop's ClaudeRipple entry was not put back: ${(error as Error).message}. \`clauderipple doctor\` says what holds it.`);
        }
      }
    }
    return restoredKeys.length > 0;
  }, () => fs.rmSync(directStatePath(home), { force: true }));
  const restored = [...restoredKeys.map((k) => `settings.json env.${k}`), ...(desktopApplied ? ["Claude Desktop's proxy entry"] : [])];
  const detail = restored.length > 0 ? `Claude goes through ClaudeRipple again. Restored: ${restored.join(", ")}.${edit.backup ? ` settings.json backup: ${edit.backup}.` : ""}`
    : desktopSkipped ? "Nothing else was saved to restore."
    : "Claude already went through ClaudeRipple; nothing to restore.";
  return { ok: true, mode: currentMode(home), restartClaude: true, detail: [...notes, detail].join(" ") };
}
