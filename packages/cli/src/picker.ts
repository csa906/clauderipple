// `clauderipple picker on|off` — put real model names into Claude Desktop's model picker.
//
// on:  1. trust our CA for this user: login keychain (macOS asks for the password; we never see it),
//         Cert:\CurrentUser\Root (Windows shows a confirmation dialog), or the NSS database Chromium
//         reads on Linux (~/.pki/nssdb; no prompt, no sudo)
//      2. point the app itself at the router: Config Library entry {egressProxyUrl} + _meta.json appliedId
//         (~/Library/Application Support/Claude-3p/configLibrary/ — the app keeps its managed-config
//         library under the "-3p" userData dir in BOTH deployment modes; read once at start, no MDM needed)
//      3. set picker.enabled in config.json
//      → the user restarts Claude Desktop.
// off: reverse all three.
// reapply: step 2 alone, for an entry that went missing while picker mode stayed on (a deleted
//      Claude-3p folder, 2026-11-19); `repair` does the same by itself while nothing is applied.

import { execFileSync } from "node:child_process";
import crypto, { X509Certificate } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execBounded } from "./bounded-exec.ts";
import { windowsPowerShellEnv } from "./windows-powershell.ts";
import { homeDir } from "../../router/src/config.ts";
import { withFileLock, writeJsonAtomic } from "../../router/src/locked-file.ts";
import { normalizeHome, sameHome } from "./ownership.ts";
import { readOwners } from "./owners.ts";
import { settingsPath } from "./settings.ts";
import { verifiedDesktopService, type DesktopServiceDeps } from "./desktop-service.ts";

export const CA_NAME = "ClaudeRipple local CA";

function appSupport(): string {
  // Where the app keeps its Config Library, regardless of 1P/3P mode, and never the plain "Claude"
  // dir. Read in Desktop 6.6395's index.pre.js (`F6()`, 2026-11-20): on win32 a fixed
  // %LOCALAPPDATA%\Claude-3p, not userData + "-3p" (confirmed on Windows 11 2026-09-14, where the app
  // read a configLibrary we put there); elsewhere userData + "-3p". The app's own
  // CLAUDE_USER_DATA_DIR override (userData itself, no suffix) is not followed here.
  if (process.env.CLAUDE_APP_SUPPORT) return process.env.CLAUDE_APP_SUPPORT;
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Claude-3p");
  }
  // Linux userData is $XDG_CONFIG_HOME/Claude, so the same "-3p" rule gives ~/.config/Claude-3p
  // (Claude Desktop 2.2553.13's bundle: `${app.getPath("userData")}-3p`, no Linux special case).
  if (process.platform === "linux") return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Claude-3p");
  return path.join(os.homedir(), "Library", "Application Support", "Claude-3p");
}

export function configLibraryDir(): string {
  return path.join(appSupport(), "configLibrary");
}

function loginKeychain(): string {
  return path.join(os.homedir(), "Library", "Keychains", "login.keychain-db");
}

const isWindows = process.platform === "win32";
const isLinux = process.platform === "linux";

// ---- Linux: the NSS database ------------------------------------------------------------
//
// Chromium on Linux takes locally added roots from the user's NSS database, not from /etc/ssl,
// and Claude Desktop is Chromium: a CA only in the system bundle would leave the app a blank page
// behind the router. certutil comes from libnss3-tools, which a desktop install does not always have.

/** Test-only override; production always uses the database Chromium reads. */
export function nssDb(): string {
  return process.env.CLAUDERIPPLE_NSS_DB ?? path.join(os.homedir(), ".pki", "nssdb");
}

/**
 * The fingerprint is part of the name so a CA from an earlier install is never taken for the
 * current one: trusting the old one would pass a check by name and still fail every handshake.
 */
export function nssNickname(caPem: string): string {
  return `${CA_NAME} ${new X509Certificate(fs.readFileSync(caPem)).fingerprint256.replace(/:/g, "").slice(0, 24)}`;
}

function certutil(args: string[]): string {
  return execFileSync("certutil", ["-d", `sql:${nssDb()}`, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Every ClaudeRipple CA in the database, including ones left by an earlier install. */
function nssOurNicknames(run: (args: string[]) => string = certutil): string[] {
  const out = run(["-L"]);
  // One line per certificate: the nickname, then its trust flags ("C,,") as the last column.
  return out
    .split("\n")
    .map((line) => /^(.*\S)\s+\S*,\S*,\S*\s*$/.exec(line)?.[1])
    .filter((name): name is string => !!name && name.startsWith(CA_NAME));
}

export function nssTrusted(caPem: string): boolean {
  try {
    const name = nssNickname(caPem);
    const installed = new X509Certificate(certutil(["-L", "-n", name, "-a"]));
    if (installed.fingerprint256 !== new X509Certificate(fs.readFileSync(caPem)).fingerprint256) return false;
    // Validated as an SSL CA (-u L): that is the trust a handshake needs, not mere presence.
    certutil(["-V", "-n", name, "-u", "L"]);
    return true;
  } catch {
    return false;
  }
}

export function nssTrust(caPem: string): void {
  if (nssTrusted(caPem)) return;
  try {
    fs.mkdirSync(nssDb(), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(path.join(nssDb(), "cert9.db"))) certutil(["-N", "--empty-password"]);
    certutil(["-A", "-n", nssNickname(caPem), "-t", "C,,", "-i", caPem]);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("certutil not found. Install it (Ubuntu/Debian: `sudo apt install libnss3-tools`, Fedora: `sudo dnf install nss-tools`), then run `clauderipple picker on` again");
    }
    throw e;
  }
}

/** Removes every ClaudeRipple CA, current or left over from an earlier install, or with `caPem` only that one. */
export function nssUntrust(caPem?: string): boolean {
  const names = caPem ? nssOurNicknames().filter(name => name === nssNickname(caPem)) : nssOurNicknames();
  for (const name of names) {
    try {
      certutil(["-D", "-n", name]);
    } catch {
      /* already gone */
    }
  }
  return names.length > 0;
}

/** Single-quoted PowerShell literal; the only escape inside one is a doubled quote. */
function ps(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * `interactive` drops -NonInteractive and lets a window show. Trusting (and untrusting) a root
 * certificate is a UI operation: Windows puts up its own confirmation dialog with the fingerprint,
 * and under -NonInteractive the call fails outright with "this operation cannot use the UI"
 * (observed 2026-09-14 — the dialog never appeared and picker mode stopped there).
 */
function powershell(script: string, opts: { stdio?: "ignore" | "inherit" | "pipe"; interactive?: boolean } = {}): string {
  const stdio = opts.stdio ?? "pipe";
  const args = ["-NoProfile", ...(opts.interactive ? [] : ["-NonInteractive"]), "-Command", script];
  return execFileSync("powershell.exe", args, {
    env: windowsPowerShellEnv(),
    stdio: stdio === "pipe" ? ["ignore", "pipe", "pipe"] : stdio,
    windowsHide: !opts.interactive,
  })?.toString() ?? "";
}

/**
 * Every platform trusts the CA for the current user only — never machine-wide, which would need
 * administrator rights and would affect everyone on the box.
 *   macOS   : login keychain, and the OS asks for the account password.
 *   Windows : Cert:\CurrentUser\Root, and the OS shows a confirmation dialog with the fingerprint.
 *   Linux   : the user's NSS database (see nssDb), with no prompt at all.
 * Measured on Windows 11 (2026-09-14) as a standard user: the import succeeded with no UAC prompt,
 * only that dialog. Removal shows a second confirmation, so `picker off` prompts the user too.
 */
export function caTrusted(caPem: string, opts: { platform?: NodeJS.Platform; run?: (command: string, args: string[]) => string } = {}): boolean {
  const platform = opts.platform ?? process.platform;
  if (platform === "linux") return nssTrusted(caPem);
  const run = opts.run ?? ((command, args) => execFileSync(command, args, { env: windowsPowerShellEnv(), stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).toString());
  try {
    const fingerprint = new X509Certificate(fs.readFileSync(caPem)).fingerprint.replace(/:/g, "");
    if (platform === "win32") {
      const out = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `@(Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object { $_.Thumbprint -eq '${fingerprint}' }).Count`]);
      return Number(out.trim()) > 0;
    }
    // User trust settings are keyed by the certificate's SHA-1, not its non-unique subject.
    // Presence alone is not trust: verify the current certificate against that keychain too.
    const settings = run("security", ["trust-settings-export", "/dev/stdout"]);
    if (!settings.toUpperCase().includes(`<KEY>${fingerprint}</KEY>`)) return false;
    // Trust settings outlive their certificate, and verify-cert passes on the file and them alone:
    // on 2026-10-25 a CA removed from the keychain still read as trusted, `picker on` skipped adding
    // it, and the app refused every claude.ai page (ERR_CERT_AUTHORITY_INVALID). The app needs the
    // certificate itself in the keychain.
    const cn = /(?:^|\n)CN=([^\n]+)/.exec(new X509Certificate(fs.readFileSync(caPem)).subject)?.[1] ?? "";
    const held = run("security", ["find-certificate", "-a", "-Z", "-c", cn, loginKeychain()]);
    if (!held.toUpperCase().replace(/\s+/g, " ").includes(`SHA-1 HASH: ${fingerprint}`)) return false;
    run("security", ["verify-cert", "-c", caPem, "-p", "basic", "-k", loginKeychain()]);
    return true;
  } catch {
    return false;
  }
}

/**
 * `caTrusted` for a process that must not stop: the router's status route asks it in the background
 * (#159, a synchronous PowerShell on the router's event loop froze the proxy with it). Every child
 * runs under a deadline that ends its whole tree. Answers true or false as `caTrusted` does, and
 * null when a check ran out of time: that says nothing about the certificate, so a caller must not
 * report it as "not trusted".
 */
export async function caTrustedAsync(caPem: string, opts: { platform?: NodeJS.Platform; run?: (command: string, args: string[]) => Promise<string>; timeoutMs?: number } = {}): Promise<boolean | null> {
  const platform = opts.platform ?? process.platform;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const run = opts.run ?? ((command, args) => execBounded(command, args, { timeoutMs, env: windowsPowerShellEnv(), windowsHide: true }));
  const timedOut = (error: unknown): boolean => (error as { timedOut?: boolean } | null)?.timedOut === true;
  try {
    const cert = new X509Certificate(fs.readFileSync(caPem));
    const fingerprint = cert.fingerprint.replace(/:/g, "");
    if (platform === "linux") {
      const name = nssNickname(caPem);
      const certutilRun = (args: string[]): Promise<string> => run("certutil", ["-d", `sql:${nssDb()}`, ...args]);
      const installed = new X509Certificate(await certutilRun(["-L", "-n", name, "-a"]));
      if (installed.fingerprint256 !== cert.fingerprint256) return false;
      await certutilRun(["-V", "-n", name, "-u", "L"]);
      return true;
    }
    if (platform === "win32") {
      const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `@(Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object { $_.Thumbprint -eq '${fingerprint}' }).Count`]);
      return Number(out.trim()) > 0;
    }
    // The same three checks, in the same order, as caTrusted's macOS branch.
    const settings = await run("security", ["trust-settings-export", "/dev/stdout"]);
    if (!settings.toUpperCase().includes(`<KEY>${fingerprint}</KEY>`)) return false;
    const cn = /(?:^|\n)CN=([^\n]+)/.exec(cert.subject)?.[1] ?? "";
    const held = await run("security", ["find-certificate", "-a", "-Z", "-c", cn, loginKeychain()]);
    if (!held.toUpperCase().replace(/\s+/g, " ").includes(`SHA-1 HASH: ${fingerprint}`)) return false;
    await run("security", ["verify-cert", "-c", caPem, "-p", "basic", "-k", loginKeychain()]);
    return true;
  } catch (error) {
    return timedOut(error) ? null : false;
  }
}

/** Adds the CA as a trusted root for the current user. The OS shows its own prompt; we never see a password. */
export function trustCa(caPem: string): void {
  if (isLinux) return nssTrust(caPem);
  if (caTrusted(caPem)) return;
  if (isWindows) {
    // stdio inherit: the confirmation dialog is the OS's, but errors should reach the user's terminal.
    powershell(`Import-Certificate -FilePath ${ps(caPem)} -CertStoreLocation Cert:\\CurrentUser\\Root -ErrorAction Stop | Out-Null`, { stdio: "inherit", interactive: true });
    return;
  }
  execFileSync("security", ["add-trusted-cert", "-r", "trustRoot", "-k", loginKeychain(), caPem], { stdio: "inherit" });
}

/**
 * What a CA removal achieved: `absent` means there was nothing trusted to remove (a purge may
 * proceed), `failed` means the store could not be read or the user declined.
 */
export type CaRemoval = "removed" | "absent" | "missing" | "failed";

/** Missing local identity is not evidence that the certificate is absent from the trust store. */
function caFingerprint(caPem: string): { fingerprint: string } | { error: "missing" | "failed" } {
  try {
    return { fingerprint: new X509Certificate(fs.readFileSync(caPem)).fingerprint.replace(/:/g, "").toUpperCase() };
  } catch (error) {
    return { error: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "failed" };
  }
}

/** Whether Windows' CurrentUser Root store holds the certificate; null when that cannot be read. */
type CaCommand = (command: string, args: string[]) => string;
const runCaCommand: CaCommand = (command, args) => execFileSync(command, args, { env: windowsPowerShellEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).toString();

function windowsHasCa(fingerprint: string | null, byName: boolean, run: CaCommand = runCaCommand): boolean | null {
  const match = byName ? `$_.Subject -eq 'CN=${CA_NAME}'` : fingerprint ? `$_.Thumbprint -eq '${fingerprint}'` : null;
  if (!match) return false;
  try {
    const out = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `@(Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object { ${match} }).Count`]);
    const count = Number(out.trim());
    return Number.isSafeInteger(count) ? count > 0 : null;
  } catch {
    return null;
  }
}

/**
 * Whether the login keychain holds the certificate (trusted or not): true, false, or null when that
 * cannot be determined. Read-only — `security find-certificate` never prompts for a password.
 */
function keychainHasCa(fingerprint: string | null, byName: boolean, run: CaCommand = runCaCommand): boolean | null {
  const args = byName
    ? ["find-certificate", "-c", CA_NAME, loginKeychain()]
    : fingerprint
      ? ["find-certificate", "-a", "-Z", loginKeychain()]
      : null;
  if (!args) return false;
  try {
    const out = run("security", args);
    return byName || out.toUpperCase().includes(`SHA-1 HASH: ${fingerprint}`);
  } catch (error) {
    // errSecItemNotFound is the only failure that means "not there"; anything else is unknown.
    return (error as { status?: number }).status === 44 ? false : null;
  }
}

/**
 * `sweep` also removes CAs an earlier install of the same home left behind, found by name. Without
 * it only this `caPem` goes, by fingerprint: a second install (a release check under its own
 * CLAUDERIPPLE_HOME) shares the user's trust store with the real one, whose CA has the same name.
 * A certificate that is not there at all is `absent`, not a failure: an install that already lost
 * its CA must still be able to purge (D3, 2026-10-25).
 */
export function untrustCa(caPem: string, opts: { sweep?: boolean; platform?: NodeJS.Platform; run?: CaCommand; missingCaTrustRemoved?: boolean } = {}): CaRemoval {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? runCaCommand;
  const identity = caFingerprint(caPem);
  if ("error" in identity) {
    // Explicit recovery only: the user has checked the store and removed this installation's CA.
    // Never bypass permission, I/O or parsing failures, and never sweep by a non-unique name.
    return identity.error === "missing" && opts.missingCaTrustRemoved === true ? "absent" : identity.error;
  }
  const { fingerprint } = identity;
  if (platform === "linux") {
    try {
      const wanted = nssNickname(caPem);
      const nssRun = (args: string[]) => run("certutil", ["-d", `sql:${nssDb()}`, ...args]);
      const ours = () => nssOurNicknames(nssRun).filter(name => name === wanted);
      const names = ours();
      if (names.length === 0) return "absent";
      for (const name of names) nssRun(["-D", "-n", name]);
      return ours().length === 0 ? "removed" : "failed";
    } catch {
      return "failed";
    }
  }
  const sweep = opts.sweep === true;
  if (platform === "win32") {
    const before = windowsHasCa(fingerprint, sweep, run);
    if (before === false) return "absent";
    if (before === null) return "failed";
    const match = sweep ? `$_.Subject -eq 'CN=${CA_NAME}'` : `$_.Thumbprint -eq '${fingerprint}'`;
    try {
      const script = `Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object { ${match} } | ForEach-Object { Remove-Item -Path $_.PSPath -Force }`;
      if (opts.run) run("powershell.exe", ["-NoProfile", "-Command", script]);
      else powershell(script, { stdio: "inherit", interactive: true });
    } catch {
      return "failed"; // The user may have declined; removal was not confirmed.
    }
    return windowsHasCa(fingerprint, sweep, run) === false ? "removed" : "failed";
  }
  // macOS: an untrusted copy can still be in the keychain, so presence and trust are asked apart.
  const present = sweep ? keychainHasCa(fingerprint, true, run) : keychainHasCa(fingerprint, false, run);
  if (present === false) return "absent";
  if (present === null) return "failed";
  try {
    const trust = run("security", ["trust-settings-export", "/dev/stdout"]);
    if (trust.toUpperCase().includes(`<KEY>${fingerprint}</KEY>`)) run("security", ["remove-trusted-cert", caPem]);
  } catch {
    return "failed";
  }
  try {
    run("security", ["delete-certificate", ...(sweep ? ["-c", CA_NAME] : ["-Z", fingerprint]), loginKeychain()]);
    return "removed";
  } catch {
    // Nothing left to delete means the removal is complete; a leftover is not confirmed.
    return (sweep ? keychainHasCa(fingerprint, true, run) : keychainHasCa(fingerprint, false, run)) === false ? "removed" : "failed";
  }
}

// `keptId`: an entry of ours the app also wrote into, left listed by `off` without our proxy; no
// `ourId`, so it is no record of ownership (nothing removes it, and it blocks no other installation),
// only where the next apply on this home finds it again.
type Meta = { appliedId?: string; entries?: unknown; hybridPointer?: unknown; clauderipple?: { ourId?: string; keptId?: string; previousAppliedId?: string | null; installationHome?: string } } & Record<string, unknown>;

/**
 * The name Claude Desktop's own Config Library editor lists our entry under. Desktop 6.6395 keeps
 * `{ appliedId, entries: [{ id, name }] }` and its editor calls `entries.map`, `.some` and `.push`
 * on whatever _meta.json it finds (read in its bundle, 2026-11-20), so a meta without the array
 * breaks it; ours is listed there beside the app's own.
 */
const ENTRY_NAME = "ClaudeRipple";
/** The only applied ids Desktop reads (`/^[a-f0-9-]{36}$/` in its bundle); `crypto.randomUUID()` gives one. */
const ENTRY_ID = /^[a-f0-9-]{36}$/;

function entryIdOf(entry: unknown): unknown {
  return entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined;
}

/** Desktop's list with ours in it, every other item as it was. A list that is not an array is not ours to replace. */
function listedWith(meta: Meta, id: string): unknown[] {
  if (meta.entries !== undefined && !Array.isArray(meta.entries)) throw new Error("Desktop proxy metadata has an invalid entries list; left untouched");
  const entries = (meta.entries ?? []) as unknown[];
  return entries.some((entry) => entryIdOf(entry) === id) ? entries : [...entries, { id, name: ENTRY_NAME }];
}

/** Desktop's list without ours. Always an array: a meta without one breaks Desktop's editor. */
function listedWithout(meta: Meta, id: string): unknown[] {
  if (meta.entries !== undefined && !Array.isArray(meta.entries)) throw new Error("Desktop proxy metadata has an invalid entries list; left untouched");
  return ((meta.entries ?? []) as unknown[]).filter((entry) => entryIdOf(entry) !== id);
}

/** Writes _meta.json only when it changes, so an unchanged state never looks like a new one. */
function writeMeta(dir: string, before: Meta, next: Meta): boolean {
  if (fs.existsSync(path.join(dir, "_meta.json")) && JSON.stringify(before) === JSON.stringify(next)) return false;
  writeJsonAtomic(path.join(dir, "_meta.json"), next);
  return true;
}

/** Our entry file as an object, or null when it is absent, unreadable or not an object. */
function readEntry(file: string): Record<string, unknown> | null {
  try {
    const current = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return current && typeof current === "object" && !Array.isArray(current) ? current as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Writes our entry unless it already names this proxy: its time is how the router tells a new entry
 * (`appProxyState`). Listed in Desktop's editor, the entry is the app's too: its API-key sign-in
 * writes its provider keys into the applied entry (`signInWithAnthropicApiKey`, 6.6395), and those
 * stay. A PAC URL does not: Desktop's launch pin takes `egressProxyPacUrl` over `egressProxyUrl`
 * (`mme`/`Vwt`), so with one our proxy would never be used.
 */
function writeEntry(file: string, proxyUrl: string): boolean {
  const current = readEntry(file) ?? {};
  if (current.egressProxyUrl === proxyUrl && !("egressProxyPacUrl" in current)) return false;
  const rest = Object.fromEntries(Object.entries(current).filter(([key]) => key !== "egressProxyPacUrl"));
  writeJsonAtomic(file, { ...rest, egressProxyUrl: proxyUrl });
  return true;
}

/** Whether our entry file holds anything besides our proxy: something the app or the person wrote. */
function holdsOthersKeys(file: string): boolean {
  return Object.keys(readEntry(file) ?? {}).some((key) => key !== "egressProxyUrl");
}

/**
 * Takes our proxy out of an entry the app also wrote into (an API-key sign-in), which stays, listed,
 * so nothing the person set up is lost. An entry holding only our proxy is removed instead.
 */
function retireEntry(file: string): void {
  const rest = Object.fromEntries(Object.entries(readEntry(file) ?? {}).filter(([key]) => key !== "egressProxyUrl"));
  writeJsonAtomic(file, rest);
}

/** The hosts Desktop 6.6395 accepts for a hybrid pointer in a packaged build (`Wce`, `Yce` in index.pre.js). */
const HYBRID_HOSTS = new Set(["api.anthropic.com", "api-staging.anthropic.com", "api.claude.ai", "config.claude.com"]);

/**
 * Desktop reads `hybridPointer.bootstrapUrl` instead of the applied entry whenever it accepts one
 * (`Tpe()`/`n4()`/`t4()` in index.pre.js, 6.6395: https, one of its own hosts, no credentials in the
 * URL): then no entry, ours included, is in effect. One it would not accept changes nothing.
 */
function hybridPointer(meta: Meta): boolean {
  const pointer = meta.hybridPointer as { bootstrapUrl?: unknown } | null | undefined;
  if (!pointer || typeof pointer !== "object" || typeof pointer.bootstrapUrl !== "string") return false;
  try {
    const url = new URL(pointer.bootstrapUrl);
    return url.protocol === "https:" && url.username === "" && url.password === "" && HYBRID_HOSTS.has(url.host);
  } catch {
    return false;
  }
}

/** Whether an entry id is in Desktop's list or on disk: an entry Desktop can still show or apply. */
function entryPresent(meta: Meta, id: string): boolean {
  if (Array.isArray(meta.entries) && meta.entries.some((entry) => entryIdOf(entry) === id)) return true;
  return fs.existsSync(path.join(configLibraryDir(), `${id}.json`));
}

/**
 * Another installation's record whose entry Desktop still lists or has on disk. The meta holds one
 * record, so applying ours over it would orphan that entry and leave the other installation's
 * `picker off` unable to find it (B02). A record whose entry is gone is not kept for anyone.
 */
function foreignRecord(meta: Meta, installationHome: string): boolean {
  const record = meta.clauderipple;
  if (!record || typeof record.installationHome !== "string" || sameHome(record.installationHome, installationHome)) return false;
  return typeof record.ourId === "string" && record.ourId !== "" && entryPresent(meta, record.ourId);
}

/** This installation's record, with a valid id Desktop could read: ours to reuse or remove. */
function ownRecordId(meta: Meta, installationHome: string): string | null {
  const record = meta.clauderipple;
  if (!record || typeof record.installationHome !== "string" || !sameHome(record.installationHome, installationHome)) return null;
  return typeof record.ourId === "string" && ENTRY_ID.test(record.ourId) ? record.ourId : null;
}

/** The entry `off` left listed for this home because the app wrote into it, while it is still there. */
function keptEntryId(meta: Meta, installationHome: string): string | null {
  const record = meta.clauderipple;
  if (!record || record.ourId !== undefined || typeof record.installationHome !== "string" || !sameHome(record.installationHome, installationHome)) return null;
  return typeof record.keptId === "string" && ENTRY_ID.test(record.keptId) && entryPresent(meta, record.keptId) ? record.keptId : null;
}

/**
 * This installation's own applied entry whose file is gone (meta still names it, the record says it
 * is this home's): the one case of an applied id that is ours to write back under the same id.
 */
function lostOwnEntry(meta: Meta, installationHome: string): string | null {
  const id = typeof meta.appliedId === "string" ? meta.appliedId : "";
  const record = meta.clauderipple;
  if (!id || record?.ourId !== id || typeof record.installationHome !== "string" || !sameHome(record.installationHome, installationHome)) return null;
  try {
    fs.statSync(path.join(configLibraryDir(), `${id}.json`));
    return null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? id : null;
  }
}

/**
 * What Claude Desktop will do with its Config Library, seen from this installation:
 *   applied  our entry is applied and names `proxyUrl`
 *   missing  nothing is applied (no Config Library, an empty or reset _meta.json), or this
 *            installation's own applied entry file is gone: the only state repair fills by itself
 *   stale    our entry is applied but names another URL (an old port)
 *   other    the app applies a configuration another app, the person or another ClaudeRipple
 *            installation chose, or a hybrid pointer stands in for every entry: never replaced
 *            without being asked. `holder` says whose: "app" (the app's own entries, which
 *            `picker reapply` may replace on request), "installation" or "hybrid" (which it refuses)
 *   unknown  the files cannot be read; nothing is concluded and nothing is written
 * Never throws: readiness and doctor ask on every poll. `changedAt` (ms) is the newest of the
 * applied entry's and _meta.json's times, for telling whether the app has started since.
 */
export type AppProxyState = { state: "applied" | "missing" | "stale" | "other" | "unknown"; holder: "app" | "installation" | "hybrid" | null; appliedId: string | null; egressProxyUrl: string | null; changedAt: number | null; reason: string };

/** Whether `picker reapply` (applyAppProxy) would act on this state rather than refuse or change nothing. */
export function reapplyCanFix(entry: AppProxyState): boolean {
  return entry.state === "missing" || entry.state === "stale" || (entry.state === "other" && entry.holder === "app");
}

export function appProxyState(proxyUrl: string, installationHome = homeDir()): AppProxyState {
  const dir = configLibraryDir();
  const none = (state: AppProxyState["state"], reason: string, appliedId: string | null = null, holder: AppProxyState["holder"] = null): AppProxyState => ({ state, holder, appliedId, egressProxyUrl: null, changedAt: null, reason });
  let meta: Meta;
  try {
    meta = readMeta();
  } catch (error) {
    return none("unknown", `its _meta.json cannot be read: ${(error as Error).message}`);
  }
  if (hybridPointer(meta)) return none("other", "the app applies a hybrid configuration, which it reads instead of any entry", null, "hybrid");
  const record = meta.clauderipple;
  const otherInstallation = typeof record?.installationHome === "string" && !sameHome(record.installationHome, installationHome);
  const otherRecord = foreignRecord(meta, installationHome);
  const id = typeof meta.appliedId === "string" && meta.appliedId !== "" ? meta.appliedId : null;
  if (!id) {
    // Another installation's entry is still there: filling the gap would take over its record.
    if (otherRecord) return none("other", "another ClaudeRipple installation's entry is in the Config Library", null, "installation");
    return none("missing", fs.existsSync(path.join(dir, "_meta.json")) ? "no entry is applied" : "the Config Library is gone");
  }
  if (lostOwnEntry(meta, installationHome)) return none("missing", `the applied entry ${id} is gone`, id);
  const ours = record?.ourId === id;
  let entry: unknown;
  let changedAt: number;
  try {
    const file = path.join(dir, `${id}.json`);
    entry = JSON.parse(fs.readFileSync(file, "utf8"));
    changedAt = Math.max(fs.statSync(file).mtimeMs, fs.statSync(path.join(dir, "_meta.json")).mtimeMs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && (!ours || otherInstallation)) {
      return ours || otherRecord
        ? none("other", "the applied entry belongs to another ClaudeRipple installation", id, "installation")
        : none("other", `the applied entry ${id} is not ClaudeRipple's`, id, "app");
    }
    return none("unknown", `the applied entry ${id} cannot be read: ${(error as Error).message}`, id);
  }
  const egressProxyUrl = entry && typeof entry === "object" && typeof (entry as { egressProxyUrl?: unknown }).egressProxyUrl === "string" ? (entry as { egressProxyUrl: string }).egressProxyUrl : null;
  const seen = (state: AppProxyState["state"], reason: string, holder: AppProxyState["holder"] = null): AppProxyState => ({ state, holder, appliedId: id, egressProxyUrl, changedAt, reason });
  // The app's own entry, unless another installation's entry is still listed beside it (applying
  // ours would take over that installation's record).
  if (!ours) return otherRecord ? seen("other", "another ClaudeRipple installation's entry is in the Config Library", "installation") : seen("other", `the applied entry ${id} is not ClaudeRipple's`, "app");
  if (otherInstallation) return seen(egressProxyUrl === proxyUrl ? "applied" : "other", "the applied entry belongs to another ClaudeRipple installation", egressProxyUrl === proxyUrl ? null : "installation");
  return egressProxyUrl === proxyUrl ? seen("applied", "ClaudeRipple's entry is applied") : seen("stale", `ClaudeRipple's entry names ${egressProxyUrl ?? "no proxy"}`);
}

function readMeta(): Meta {
  let text: string;
  try {
    text = fs.readFileSync(path.join(configLibraryDir(), "_meta.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Desktop proxy metadata is invalid; left untouched");
  return parsed as Meta;
}

const ENTRY_MARK = "clauderipple";

export function currentAppProxy(): { appliedId: string | null; egressProxyUrl: string | null; ours: boolean; installationHome?: string | undefined; previousAppliedId?: string | null | undefined } {
  const meta = readMeta();
  const id = typeof meta.appliedId === "string" ? meta.appliedId : null;
  if (!id) return { appliedId: null, egressProxyUrl: null, ours: false };
  try {
    const entry = JSON.parse(fs.readFileSync(path.join(configLibraryDir(), `${id}.json`), "utf8")) as Record<string, unknown>;
    return { appliedId: id, egressProxyUrl: typeof entry.egressProxyUrl === "string" ? entry.egressProxyUrl : null, ours: meta[ENTRY_MARK]?.ourId === id, installationHome: meta.clauderipple?.installationHome, previousAppliedId: meta.clauderipple?.previousAppliedId };
  } catch (error) {
    // The app's own entry whose file is gone: Desktop reads it as an empty entry (6.6395 `QIi`
    // returns {} on ENOENT) and goes direct. A file a record names stays an error: whose it is, and
    // what `off` restores, are that record's.
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && meta[ENTRY_MARK]?.ourId !== id) return { appliedId: id, egressProxyUrl: null, ours: false };
    throw new Error(`Desktop proxy entry ${id} could not be read; left untouched`, { cause: error });
  }
}

/**
 * Whose applied Config Library entry this is. A URL and a product marker identify neither the
 * installation that wrote it nor its home: two installations can use the same port. Legacy entries
 * without a home remain unknown, including on apply, rather than silently acquiring a new owner.
 */
export function appProxyOwner(current: ReturnType<typeof currentAppProxy>, home: string, proxyUrl?: string): "ours" | "other" | "unknown" {
  if (!current.ours) return "other";
  if (current.installationHome !== undefined) return sameHome(current.installationHome, home) ? "ours" : "other";
  return "unknown";
}

/** A legacy entry needs both a verified service and an unambiguous single-installation history. */
export function migrateLegacyAppProxy(proxyUrl: string, installationHome: string, deps: DesktopServiceDeps = {}): boolean {
  return withFileLock(path.join(configLibraryDir(), "_meta.json"), () => migrateLegacyAppProxyLocked(proxyUrl, installationHome, deps));
}

function migrateLegacyAppProxyLocked(proxyUrl: string, installationHome: string, deps: DesktopServiceDeps): boolean {
  const cur = currentAppProxy();
  if (!cur.ours || cur.installationHome !== undefined || cur.egressProxyUrl !== proxyUrl) return false;
  // A live service proves who uses the port now, not who wrote this historical entry. Every
  // recorded home counts, even when absent from disk; default/configured homes count when present.
  const owners = readOwners(settingsPath());
  const homes = [...Object.keys(owners.store.homes), ...[path.join(os.homedir(), ".clauderipple"), homeDir()].filter(home => fs.existsSync(home))];
  if (owners.error || homes.some(home => !sameHome(home, installationHome))) {
    throw new Error("구형 Claude Desktop 프록시를 어느 설치에서 설정했는지 확인할 수 없어 보존했습니다. 다른 ClaudeRipple 설치와 설치 소유권 기록을 확인한 뒤 프록시 설정을 직접 해제해 주세요.");
  }
  if (!verifiedDesktopService(installationHome, proxyUrl, deps)) return false;
  const meta = readMeta();
  writeJsonAtomic(path.join(configLibraryDir(), "_meta.json"), { ...meta, clauderipple: { ...meta.clauderipple, installationHome: normalizeHome(installationHome) } });
  return true;
}

/**
 * Writes our Config Library entry and applies it. Remembers what was applied before so `off` can
 * restore it. `changed` is false when everything already said this: nothing was written.
 */
export function applyAppProxy(proxyUrl: string, installationHome = homeDir(), expected?: ReturnType<typeof currentAppProxy>, deps: DesktopServiceDeps = {}): { id: string; replaced: string | null; changed: boolean } {
  return withFileLock(path.join(configLibraryDir(), "_meta.json"), () => applyAppProxyLocked(proxyUrl, installationHome, expected, deps));
}

/**
 * Repair's self-heal: applies our entry only while the app still reads nothing of ours (checked
 * again under the lock): `missing`, or our own entry naming no proxy, which leaves the app direct
 * just the same. Whatever another app, the person or another installation applied in the meantime is
 * never replaced. Null when that changed.
 */
export function restoreMissingAppProxy(proxyUrl: string, installationHome = homeDir()): { id: string; changed: boolean } | null {
  return withFileLock(path.join(configLibraryDir(), "_meta.json"), () => {
    const now = appProxyState(proxyUrl, installationHome);
    if (now.state !== "missing" && !(now.state === "stale" && now.egressProxyUrl === null)) return null;
    const r = applyAppProxyLocked(proxyUrl, installationHome, undefined, {});
    return { id: r.id, changed: r.changed };
  });
}

function applyAppProxyLocked(proxyUrl: string, installationHome: string, expected: ReturnType<typeof currentAppProxy> | undefined, deps: DesktopServiceDeps): { id: string; replaced: string | null; changed: boolean } {
  const dir = configLibraryDir();
  fs.mkdirSync(dir, { recursive: true });
  const meta = readMeta();
  // Desktop reads a hybrid pointer instead of any entry, so an entry written under one would never
  // take effect while we reported it applied. Ending it is the app's (its own apply does), not ours.
  if (hybridPointer(meta)) throw new Error("Claude Desktop applies a hybrid configuration, which it reads instead of any Config Library entry, so ClaudeRipple's could not take effect; end it in Claude Desktop first. Left untouched");
  // Our own applied entry whose file was deleted: written back under the same id, so the record
  // and what `off` restores stay as they were.
  const lost = lostOwnEntry(meta, installationHome);
  if (lost) {
    if (expected) throw new Error("Desktop proxy changed before restoration; left untouched");
    const entries = ENTRY_ID.test(lost) ? listedWith(meta, lost) : listedWithout(meta, lost);
    writeJsonAtomic(path.join(dir, `${lost}.json`), { egressProxyUrl: proxyUrl });
    writeMeta(dir, meta, { ...meta, entries });
    return { id: lost, replaced: null, changed: true };
  }
  const cur = currentAppProxy();
  if (expected && JSON.stringify(cur) !== JSON.stringify(expected)) throw new Error("Desktop proxy changed before restoration; left untouched");
  if (cur.ours && cur.appliedId) {
    let owner = appProxyOwner(cur, installationHome, proxyUrl);
    if (owner === "unknown" && migrateLegacyAppProxyLocked(proxyUrl, installationHome, deps)) owner = "ours";
    if (owner === "other") throw new Error("Desktop proxy ownership is unknown or belongs to another installation; left untouched");
    if (owner === "unknown") throw new Error("Desktop proxy ownership is unknown; left untouched");
    const current = readMeta();
    // Desktop reads only UUID-shaped ids: an older version's other id is never listed, where nothing
    // could find it again (ownRecordId) and a re-apply would list a second "ClaudeRipple".
    const entries = ENTRY_ID.test(cur.appliedId) ? listedWith(current, cur.appliedId) : listedWithout(current, cur.appliedId);
    const wrote = writeEntry(path.join(dir, `${cur.appliedId}.json`), proxyUrl);
    // Take over an entry an older version applied without recording a home: from here on its
    // ownership is evidenced like any other (D3). An older meta also gets Desktop's entries list.
    const home = current.clauderipple?.installationHome;
    const next: Meta = home === undefined || !sameHome(home, installationHome)
      ? { ...current, entries, clauderipple: { ...current.clauderipple, ourId: cur.appliedId, installationHome: normalizeHome(installationHome) } }
      : { ...current, entries };
    const metaChanged = writeMeta(dir, current, next);
    return { id: cur.appliedId, replaced: null, changed: wrote || metaChanged };
  }
  // The meta holds one record: another installation's whose entry is still listed or on disk is not
  // ours to replace, applied or not (its `picker off` would find nothing to remove).
  if (foreignRecord(meta, installationHome)) throw new Error("Desktop proxy ownership belongs to another installation, whose entry is still in Claude Desktop's list; left untouched");
  const record = meta.clauderipple;
  const previous = typeof meta.appliedId === "string" && meta.appliedId !== "" ? meta.appliedId : null;
  // This home's record still names its entry (a meta the app reset, or the app applying another of
  // its entries): reuse that id rather than leave a second "ClaudeRipple" in the app's list. What
  // `off` restores is what is applied now, or, with nothing applied, what the record remembered.
  // So is the entry `off` left listed because the app wrote into it: the proxy goes back in beside
  // what the app wrote.
  const ownId = ownRecordId(meta, installationHome);
  const reuseId = ownId ?? keptEntryId(meta, installationHome);
  const id = reuseId ?? crypto.randomUUID();
  const entries = listedWith(meta, id);
  // Only recognized keys in the entry: the app warns about and ignores unknown ones. Ownership lives
  // in _meta. Keys the app wrote into a reused entry stay (writeEntry).
  writeEntry(path.join(dir, `${id}.json`), proxyUrl);
  const restore = previous ?? (ownId ? record!.previousAppliedId || null : null);
  const next: Meta = { ...meta, appliedId: id, entries, clauderipple: { ourId: id, previousAppliedId: restore, installationHome: normalizeHome(installationHome) } };
  writeJsonAtomic(path.join(dir, "_meta.json"), next);
  // Our kept entry the person applied in Desktop is reused, not replaced.
  return { id, replaced: previous === id ? null : previous, changed: true };
}

/**
 * The selection `off` hands back: the remembered one while it still exists (listed, or its file is
 * there: a meta older than the list, listed again under Desktop's first name). With nothing to hand
 * back, `kept` (our entry the app wrote into, now without our proxy: what the person was using), else
 * what Desktop seeds for itself, a new empty "Default" (6.6395 `RU()`): it holds no proxy, so the app
 * goes direct, and the app's flows that need an applied id still find one (its API-key sign-in
 * refuses "" in `JIi`; its editor's `listConfigs` needs a string, `VNt`). Never another listed entry:
 * one the person created or duplicated (a copy of ours names the router this very `off` may be
 * stopping) but never applied would take effect. Nothing listed at all: no selection, and
 * writeRemoval removes the meta. Called under the meta lock; it may write that "Default" entry.
 */
function restoredSelection(entries: unknown[], previous: string | null, kept: string | null): { appliedId: string | null; entries: unknown[] } {
  if (previous && entries.some((entry) => entryIdOf(entry) === previous)) return { appliedId: previous, entries };
  if (previous && fs.existsSync(path.join(configLibraryDir(), `${previous}.json`))) return { appliedId: previous, entries: [...entries, { id: previous, name: "Default" }] };
  if (kept) return { appliedId: kept, entries };
  if (entries.length === 0) return { appliedId: null, entries };
  const seeded = crypto.randomUUID();
  writeJsonAtomic(path.join(configLibraryDir(), `${seeded}.json`), {});
  return { appliedId: seeded, entries: [...entries, { id: seeded, name: "Default" }] };
}

/**
 * Writes what `off` leaves. Nothing left at all (no entry, no selection, no other key) removes
 * _meta.json: Desktop seeds its own "Default" for a missing one, while it keeps an empty meta as
 * it is and its sign-in flows then fail on the missing `appliedId` (6.6395 `RU()`).
 */
function writeRemoval(dir: string, next: Meta): void {
  const empty = (key: string): boolean => (key === "entries" && Array.isArray(next.entries) && next.entries.length === 0) || (key === "appliedId" && next.appliedId === "");
  const keys = Object.keys(next).filter((key) => !empty(key));
  if (keys.length === 0) fs.rmSync(path.join(dir, "_meta.json"), { force: true });
  else writeJsonAtomic(path.join(dir, "_meta.json"), next);
}

/**
 * With `proxyUrl`, only an applied entry pointing there goes: another install's entry is not ours to
 * remove. This home's own entry also goes when the app applies another one (or its applied file is
 * gone): listed in Desktop's editor it would otherwise stay selectable, pointing at a router that
 * may no longer run. The record proves it is this home's, so no URL is asked of it.
 */
export function removeAppProxy(proxyUrl?: string, installationHome = homeDir()): boolean {
  return withFileLock(path.join(configLibraryDir(), "_meta.json"), () => removeAppProxyLocked(proxyUrl, installationHome));
}

/**
 * Whether this home's record names an entry Desktop still lists, has on disk or applies with its
 * file gone: something of ours that `removeAppProxy(undefined, home)` removes by the record alone,
 * even where `currentAppProxy` says nothing of ours is applied, or cannot read the applied file.
 */
export function ownsListedAppProxy(installationHome = homeDir()): boolean {
  try {
    const meta = readMeta();
    const id = ownRecordId(meta, installationHome);
    return id !== null && (entryPresent(meta, id) || lostOwnEntry(meta, installationHome) !== null);
  } catch {
    return false;
  }
}

/**
 * Whether the applied id is the one a ClaudeRipple record names, without reading its entry file:
 * `currentAppProxy().ours` throws when that file is gone. Throws only on an unreadable meta.
 */
export function appliedIsMarked(): boolean {
  const meta = readMeta();
  const id = typeof meta.appliedId === "string" ? meta.appliedId : "";
  return id !== "" && meta[ENTRY_MARK]?.ourId === id;
}

function removeAppProxyLocked(proxyUrl: string | undefined, installationHome: string): boolean {
  const dir = configLibraryDir();
  const meta = readMeta();
  const own = ownRecordId(meta, installationHome);
  const applied = typeof meta.appliedId === "string" && meta.appliedId !== "" ? meta.appliedId : null;
  // This home's entry, listed but not applied (the app applies another one): it and the record go,
  // and the app's selection stays exactly as the app chose it.
  if (own && applied !== own) {
    if (!entryPresent(meta, own)) return false;
    const keep = holdsOthersKeys(path.join(dir, `${own}.json`));
    const next: Meta = { ...meta, entries: keep ? listedWith(meta, own) : listedWithout(meta, own) };
    if (keep) next.clauderipple = { keptId: own, installationHome: normalizeHome(installationHome) };
    else delete next.clauderipple;
    writeRemoval(dir, next);
    if (keep) retireEntry(path.join(dir, `${own}.json`));
    else fs.rmSync(path.join(dir, `${own}.json`), { force: true });
    return true;
  }
  const lost = lostOwnEntry(meta, installationHome);
  if (!lost) {
    const cur = currentAppProxy();
    if (!cur.appliedId || appProxyOwner(cur, installationHome, proxyUrl) !== "ours") return false;
    if (proxyUrl !== undefined && cur.egressProxyUrl !== proxyUrl) return false;
  }
  const id = lost ?? applied!;
  // Every other entry in Desktop's list stays, and the selection goes back to what it was. Ours
  // stays listed, without its proxy, when the app wrote into it (retireEntry).
  const keep = ENTRY_ID.test(id) && holdsOthersKeys(path.join(dir, `${id}.json`));
  // The remembered entry can be this very one (the person applied our kept entry in Desktop, and the
  // next apply reused it): handed back only while it stays, never selected and then deleted.
  const previous = meta.clauderipple?.previousAppliedId || null;
  const selection = restoredSelection(keep ? listedWith(meta, id) : listedWithout(meta, id), keep || previous !== id ? previous : null, keep ? id : null);
  const next: Meta = { ...meta, entries: selection.entries, appliedId: selection.appliedId ?? "" };
  if (keep) next.clauderipple = { keptId: id, installationHome: normalizeHome(installationHome) };
  else delete next.clauderipple;
  writeRemoval(dir, next);
  if (keep) retireEntry(path.join(dir, `${id}.json`));
  else fs.rmSync(path.join(dir, `${id}.json`), { force: true });
  return true;
}
