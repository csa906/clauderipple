// Claude in Chrome: the extension's own side-panel chat, with the picker models in its model menu.
//
// What the extension does (read from its bundle, version 1.0.102, and from the feature payload it
// had cached, 2026-10-29; docs/ARCHITECTURE.md §3c):
//   - Its menu is `features.chrome_ext_models.value.options` of
//     GET https://api.anthropic.com/api/bootstrap/features/claude_in_chrome. When
//     `features.chrome_ext_backend_model_selector.value` is true, it keeps only the options that
//     GET /api/organizations/{org}/model_selector/chrome also lists in `model_selector_config[0].models`.
//   - The chosen id goes out verbatim as the `model` of POST /v1/messages?beta=true (a trailing
//     `[fast]` stripped), on the extension's own OAuth sign-in.
//   - Every fetch to the API host carries `anthropic-client-platform: claude_browser_extension`. A
//     declarativeNetRequest session rule sets it at the network layer, with no initiator condition,
//     so a web page's own fetch to the API host is tagged too. The header names a browser, not the
//     extension.
//   - Chrome sets `Origin: chrome-extension://<id>` on the extension's POSTs. No page can forge
//     that, and Claude Code sends no Origin at all (nor `sec-fetch-site`, which every Chromium
//     request has; Node's fetch adds only `sec-fetch-mode`).
//   - Its API origin is fixed and its CSP admits no other host, so the router meets it only on the
//     network path: a PAC that sends the API host, and nothing else, to the proxy (`chromePac`).
//     That PAC sends every page in the profile there as well.
//
// So a browser request is never taken for Claude Code's: it is not observed, gets no account pool,
// slot, alias or [[ripple:]] marker (the extension's messages carry whatever page it read), and
// passes through byte-for-byte. Only a turn from the extension's own origin, on its own sign-in and
// on an id this module put in the menu, is routed (proxy.ts).

import type http from "node:http";
import type { CliModel, Config } from "./config.ts";
import { chatPickerModels, narrowThinking, pickTemplate, type ModelEntry } from "./picker.ts";
import { resolve, type Resolved } from "./routing.ts";

/** Claude in Chrome's Web Store id is fixed by the `key` in its manifest. */
export const CLAUDE_IN_CHROME_ORIGIN = "chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn";
export const CHROME_FEATURES_PATH = "/api/bootstrap/features/claude_in_chrome";
const CHROME_SELECTOR_PATH = /^\/api\/organizations\/[^/]+\/model_selector\/chrome$/;
/** The effort levels the extension's menu takes (its own list); it drops any other. */
const CHROME_EFFORTS = ["low", "medium", "high"];

export type ChromeEdit = "features" | "selector";

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The header the extension's network rule sets on everything a browser sends to the API host. */
export function isChromeExtensionRequest(headers: http.IncomingHttpHeaders): boolean {
  const value = headers["anthropic-client-platform"];
  return (Array.isArray(value) ? value : [value]).some((v) => typeof v === "string" && v.trim().toLowerCase() === "claude_browser_extension");
}

/**
 * Who sent a request: Claude in Chrome itself, some other browser context (a web page, another
 * extension, a sandboxed frame), or neither — Claude Code and every other non-browser client.
 *
 * The extension is its origin plus a sign-in of its own: a page cannot set the origin, and holds no
 * Anthropic token. A request the extension's rule tagged but which carries no Origin (a GET) counts
 * as the extension only for the read-only list edit, whose result a page could not read anyway.
 */
export function requestClient(headers: http.IncomingHttpHeaders): "claude-in-chrome" | "browser" | null {
  const origin = single(headers.origin);
  const signedIn = /^Bearer\s+\S+$/i.test(single(headers.authorization) ?? "") || !!single(headers["x-api-key"]);
  if (origin === CLAUDE_IN_CHROME_ORIGIN && signedIn) return "claude-in-chrome";
  if (origin !== undefined || headers["sec-fetch-site"] !== undefined || isChromeExtensionRequest(headers)) return "browser";
  return null;
}

/** A request whose model-list response may be edited: the extension's own, or one its rule tagged with no Origin. */
export function isChromeListRequest(headers: http.IncomingHttpHeaders): boolean {
  const origin = single(headers.origin);
  const signedIn = /^Bearer\s+\S+$/i.test(single(headers.authorization) ?? "");
  return signedIn && (origin === CLAUDE_IN_CHROME_ORIGIN || (origin === undefined && isChromeExtensionRequest(headers)));
}

export function chromeExtensionEnabled(cfg: Config): boolean {
  return cfg.chromeExtension?.enabled === true;
}

/**
 * The models the extension is offered: the picker's, minus any `claude-*` id and any on an Anthropic
 * provider. The extension lists its own Claude models, and a Claude id it sends stays on its own
 * sign-in — even one the picker maps elsewhere, which would otherwise take over its own menu entry.
 */
export function chromeExtensionModels(cfg: Config): CliModel[] {
  if (!chromeExtensionEnabled(cfg)) return [];
  return chatPickerModels(cfg).filter((entry) => {
    if (entry.model.startsWith("claude-")) return false;
    const target = resolve(entry.model, {}, cfg);
    return !!target && cfg.providers[target.provider]?.type !== "anthropic";
  });
}

/**
 * Where an extension turn on `model` goes: this router's target for an id the menu offered, else
 * null (passed through). Resolved without the body, so nothing in the conversation can move the turn,
 * and without the slot's fallbacks onto an Anthropic provider, whose accounts are Claude Code's.
 */
export function chromeExtensionRoute(model: unknown, cfg: Config): Resolved | null {
  if (typeof model !== "string") return null;
  if (!chromeExtensionModels(cfg).some((entry) => entry.model === model)) return null;
  const target = resolve(model, {}, cfg);
  if (!target?.fallbacks) return target;
  const fallbacks = target.fallbacks.filter((fallback) => cfg.providers[fallback.provider]?.type !== "anthropic");
  return { ...target, fallbacks };
}

/** Which of the extension's model-list responses this request asks for, if any. */
export function chromeEditFor(method: string, pathname: string): ChromeEdit | null {
  if (method !== "GET") return null;
  if (pathname === CHROME_FEATURES_PATH) return "features";
  if (CHROME_SELECTOR_PATH.test(pathname)) return "selector";
  return null;
}

/** The levels a model takes that the extension's menu can show, or undefined to keep the template's. */
function chromeEfforts(model: string, effortFor?: (model: string) => string[] | undefined): string[] | undefined {
  const levels = effortFor?.(model.split("@")[0]!);
  return levels ? CHROME_EFFORTS.filter((level) => levels.includes(level)) : undefined;
}

/**
 * Adds `models` to the extension's menu in its feature payload, in place; returns how many.
 *
 * Each entry is cloned from the payload's default option (else its first object option), so fields
 * this router does not know keep the extension's own values. What belongs to that Claude model is
 * dropped: its description and notice, its knowledge cutoff, its overflow placement, and
 * `xml_system_reminders` (false moves reminders into system turns behind an Anthropic beta, which no
 * translated provider is known to take). Ids already listed are left alone, so a repeat is a no-op.
 */
export function injectChromeFeatures(json: Record<string, unknown>, models: CliModel[], effortFor?: (model: string) => string[] | undefined): number {
  const features = json.features as Record<string, unknown> | undefined;
  const feature = features && typeof features === "object" ? features.chrome_ext_models as Record<string, unknown> | undefined : undefined;
  const value = feature && typeof feature === "object" ? feature.value as { options?: unknown; default?: unknown } | undefined : undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.options)) return 0;
  const options = value.options as unknown[];
  const objects = options.filter((option): option is Record<string, unknown> => !!option && typeof option === "object" && !Array.isArray(option));
  const template = objects.find((option) => option.model === value.default) ?? objects[0] ?? {};
  const listed = new Set(options.map((option) => typeof option === "string" ? option : (option as { model?: unknown } | null)?.model));
  let injected = 0;
  for (const model of models) {
    if (listed.has(model.model)) continue;
    const entry: Record<string, unknown> = { ...structuredClone(template), model: model.model, name: model.name };
    for (const key of ["description", "notice_text", "knowledgeCutoff", "overflow", "xml_system_reminders"]) delete entry[key];
    if (model.description) entry.description = model.description;
    const efforts = chromeEfforts(model.model, effortFor);
    if (efforts?.length) entry.effort_options = efforts;
    else if (efforts) delete entry.effort_options;
    options.push(entry);
    listed.add(model.model);
    injected++;
  }
  return injected;
}

/**
 * Adds `models` to the extension's backend model list (`model_selector_config[0]`, the only surface
 * it reads), in place; returns how many. Without them there, a backend selector the extension has
 * switched on would filter every injected option back out of the menu. Entries are cloned from an
 * enabled Claude entry the way the Desktop picker's are (picker.ts).
 */
export function injectChromeSelector(json: Record<string, unknown>, models: CliModel[], effortFor?: (model: string) => string[] | undefined): number {
  const config = json.model_selector_config;
  const surface = Array.isArray(config) ? config[0] as { models?: unknown } | undefined : undefined;
  if (!surface || typeof surface !== "object" || !Array.isArray(surface.models)) return 0;
  const list = surface.models as ModelEntry[];
  const template = pickTemplate(list);
  if (!template) return 0;
  const existing = new Set(list.map((entry) => entry.id));
  let injected = 0;
  for (const model of models) {
    if (existing.has(model.model)) continue;
    const entry: ModelEntry = { ...structuredClone(template), id: model.model, name: model.name };
    for (const key of ["description", "notice_text", "disabled", "disabled_reason", "notice", "selection_notice", "badge", "badge_tooltip", "tooltip", "minimum_tier", "is_default"]) delete entry[key];
    if (model.description) entry.description = model.description;
    entry.section = "main";
    const levels = effortFor?.(model.model.split("@")[0]!);
    if (levels) narrowThinking(entry, levels);
    list.push(entry);
    existing.add(model.model);
    injected++;
  }
  return injected;
}

/**
 * The PAC script Chrome is pointed at (GET /chrome.pac on the admin port): the API host goes to the
 * proxy, every other host goes direct, so the browser's other traffic never meets the router. When
 * the router is not answering, Chrome falls back to a direct connection: the extension keeps working
 * on its own Claude models, and a turn on a routed id gets Anthropic's own "no such model" error.
 */
export function chromePac(cfg: Config): string {
  const listen = cfg.listen.host === "0.0.0.0" || cfg.listen.host === "::" ? "127.0.0.1" : cfg.listen.host;
  const host = listen.includes(":") ? `[${listen}]` : listen;
  return [
    "// ClaudeRipple: Claude in Chrome's API calls go through the router; everything else goes direct.",
    "function FindProxyForURL(url, host) {",
    `  if (host === ${JSON.stringify(cfg.upstream)}) return ${JSON.stringify(`PROXY ${host}:${cfg.listen.port}; DIRECT`)};`,
    '  return "DIRECT";',
    "}",
    "",
  ].join("\n");
}
