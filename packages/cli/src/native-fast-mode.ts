// Native Fast is a per-request flag. Only its model support and gateway startup configuration
// belong here; never persist fastMode itself or replace a server/managed-policy decision.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Config } from "../../router/src/config.ts";
import { resolve } from "../../router/src/routing.ts";
import { isJudgeOnlyModel } from "../../router/src/model-policy.ts";

export const FAST_CAPABILITIES_ENV = "CLAUDE_CODE_MODEL_CAPABILITIES";
export const FAST_GATEWAY_ENV = "CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK";
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._/:-]*$/;
const GENERATED_CLAUSE = /^[A-Za-z0-9][A-Za-z0-9._/:-]*(?:@\*)?=fast_mode$/;

type EnvMap = Record<string, string>;
type OwnValues = { capabilities: string | null; gateway: string | null };
type CapabilityState = { before: string | null; prefix: string; applied: string };
type GatewayState = { before: string | null; applied: string };
export type FastState = { capabilities: CapabilityState; gateway: GatewayState | null } | null;
type FastPlan = { env: EnvMap; state: FastState; notes: string[]; changed: boolean };
type StateRecord = {
  version: number;
  settingsPath: string;
  state?: FastState;
  pending?: { before: OwnValues; after: OwnValues; beforeState: FastState; afterState: FastState };
};
export type NativeFastPlan = FastPlan & {
  file: string;
  stateFile: string;
  previous: FastState;
  before: OwnValues;
  after: OwnValues;
  stateChanged: boolean;
};

const baseModel = (model: string): string => model.split("@")[0]!.replace(/\[1m\]$/i, "");
const targetKey = (route: { provider: string; model: string }): string => `${route.provider}\0${route.model}`;
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const ownValues = (env: EnvMap): OwnValues => ({ capabilities: env[FAST_CAPABILITIES_ENV] ?? null, gateway: env[FAST_GATEWAY_ENV] ?? null });

/** Explicit opt-in: the operator lists models whose upstream Fast support was verified. */
export function gptFastModelsForConfig(cfg: Config): string[] {
  const selected: unknown = cfg.cli?.gptFastModels ?? [];
  if (!Array.isArray(selected) || selected.some((id) => typeof id !== "string" || !SAFE_MODEL.test(id)))
    throw new Error("cli.gptFastModels must be an array of exact model IDs (no wildcards or capability expressions)");
  if (selected.length === 0) return [];
  const targets = new Set<string>();
  for (const id of selected as string[]) {
    const route = resolve(id, {}, cfg);
    const provider = route && cfg.providers[route.provider];
    if (!route || provider?.type !== "chatgpt" || isJudgeOnlyModel(route.model) || route.fallbacks?.length || !provider.models?.some((model) => model.id === route.model))
      throw new Error(`cli.gptFastModels: ${id} must resolve unambiguously to a configured ChatGPT model without fallbacks`);
    if (provider.defaultServiceTier === "priority")
      throw new Error(`cli.gptFastModels: remove provider ${route.provider}.defaultServiceTier priority so Fast OFF can use ordinary service`);
    targets.add(targetKey(route));
  }
  const candidates = new Set<unknown>([...(selected as string[]), ...(cfg.cli.extraModels ?? []).map((entry) => entry.model), ...Object.keys(cfg.routes ?? {})]);
  const models = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const id = baseModel(candidate);
    if (!SAFE_MODEL.test(id) || isJudgeOnlyModel(id)) continue;
    const route = resolve(id, {}, cfg);
    if (route && !route.fallbacks?.length && cfg.providers[route.provider]?.type === "chatgpt" && targets.has(targetKey(route))) models.add(id);
  }
  return [...models].sort();
}

/** Exact ids plus their existing @effort variants; never a capability applying to every model. */
export function fastCapabilityClauses(models: string[]): string {
  if (!Array.isArray(models) || models.some((id) => typeof id !== "string" || !SAFE_MODEL.test(id))) throw new Error("Invalid native Fast model selector");
  return [...new Set(models)].sort().flatMap((id) => [`${id}=fast_mode`, `${id}@*=fast_mode`]).join(";");
}

function restoreCapabilityBase(env: EnvMap, state: FastState, enabled: boolean, notes: string[]): string | undefined {
  const current = env[FAST_CAPABILITIES_ENV];
  const previous = state?.capabilities;
  if (!previous) return current;
  if (current === previous.applied) return previous.before === null ? undefined : previous.before;
  // Manual clauses added/edited after our prefix remain authoritative (last matching clause wins).
  if (typeof current === "string" && current.startsWith(previous.prefix + ";")) return current.slice(previous.prefix.length + 1);
  if (enabled) throw new Error("Native Fast capability ownership changed outside Ripple; refusing to overwrite the edited environment value");
  notes.push("left externally edited native Fast capabilities unchanged");
  return current;
}

/** Pure merge/restore. Ownership covers only values/fragments Ripple actually introduced. */
export function planFastEnvironment(original: EnvMap, models: string[], state: FastState = null): FastPlan {
  for (const key of [FAST_CAPABILITIES_ENV, FAST_GATEWAY_ENV]) {
    if (original[key] !== undefined && typeof original[key] !== "string") throw new Error(`env.${key} must be a string; settings were not changed`);
  }
  const env: EnvMap = { ...original };
  const notes: string[] = [];
  const prefix = fastCapabilityClauses(models);
  const enabled = prefix.length > 0;
  const base = restoreCapabilityBase(env, state, enabled, notes);
  const next: { capabilities: CapabilityState | null; gateway: GatewayState | null } = { capabilities: null, gateway: null };
  if (enabled) {
    // Manual entries follow our generated prefix so explicit user exclusions still win.
    const applied = prefix + (base ? `;${base}` : "");
    env[FAST_CAPABILITIES_ENV] = applied;
    next.capabilities = { before: base ?? null, prefix, applied };
  } else if (base === undefined) {
    delete env[FAST_CAPABILITIES_ENV];
  } else {
    env[FAST_CAPABILITIES_ENV] = base;
  }
  const gateway = env[FAST_GATEWAY_ENV];
  if (state?.gateway && gateway !== state.gateway.applied) {
    if (enabled) throw new Error("Native Fast gateway option was edited outside Ripple; refusing to overwrite it");
    notes.push("left externally edited Fast gateway option unchanged");
  } else if (enabled) {
    if (gateway !== undefined && gateway !== "1") throw new Error("A user-defined Fast gateway option conflicts with Ripple; it was not changed");
    env[FAST_GATEWAY_ENV] = "1";
    // An already enabled, user-owned value must survive disable/uninstall.
    next.gateway = state?.gateway ?? (gateway === undefined ? { before: null, applied: "1" } : null);
  } else if (state?.gateway) {
    if (state.gateway.before === null) delete env[FAST_GATEWAY_ENV];
    else env[FAST_GATEWAY_ENV] = state.gateway.before;
  }
  return { env, state: enabled ? (next as FastState) : null, notes, changed: !equal(original, env) };
}

export function atomicJsonWrite(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.ripple-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function validState(state: unknown): state is FastState {
  if (state === null) return true;
  if (!state || typeof state !== "object" || !(state as { capabilities?: unknown }).capabilities) return false;
  const { capabilities: c, gateway: g } = state as { capabilities: CapabilityState; gateway: GatewayState | null | undefined };
  return (
    (c.before === null || typeof c.before === "string") &&
    typeof c.prefix === "string" &&
    c.prefix.length > 0 &&
    c.prefix.split(";").every((clause) => GENERATED_CLAUSE.test(clause)) &&
    typeof c.applied === "string" &&
    c.applied === c.prefix + (c.before ? `;${c.before}` : "") &&
    (g === null || (!!g && (g.before === null || typeof g.before === "string") && g.applied === "1"))
  );
}

/** A sidecar avoids adding private ownership metadata to Claude's settings schema. */
export function prepareNativeFastMode(file: string, env: EnvMap, models: string[] | undefined): NativeFastPlan | null {
  if (models === undefined) return null;
  const stateFile = `${file}.clauderipple-native-fast.json`;
  let record: StateRecord | null = null;
  if (fs.existsSync(stateFile)) {
    record = JSON.parse(fs.readFileSync(stateFile, "utf8")) as StateRecord | null;
    if (!record || record.version !== 1 || record.settingsPath !== path.resolve(file)) throw new Error("Unrecognized native Fast ownership file; settings were not changed");
  }
  let previous: FastState = record?.state ?? null;
  if (record?.pending) {
    const pending = record.pending;
    if (!validState(pending.beforeState) || !validState(pending.afterState)) throw new Error("Invalid pending native Fast ownership record");
    if (equal(ownValues(env), pending.after)) previous = pending.afterState;
    else if (equal(ownValues(env), pending.before)) previous = pending.beforeState;
    else throw new Error("An interrupted native Fast update conflicts with edited settings; refusing to guess ownership");
  }
  if (!validState(previous)) throw new Error("Invalid native Fast ownership record; settings were not changed");
  const plan = planFastEnvironment(env, models, previous);
  return { ...plan, file, stateFile, previous, before: ownValues(env), after: ownValues(plan.env), stateChanged: !!record?.pending || !equal(previous, plan.state) };
}

/** Journal first, atomically replace settings, then commit ownership; either crash point is recoverable. */
export function commitNativeFastMode(plan: NativeFastPlan | null, saveSettings: () => void): void {
  if (!plan || (!plan.changed && !plan.stateChanged)) {
    saveSettings();
    return;
  }
  const header = { version: 1, settingsPath: path.resolve(plan.file) };
  atomicJsonWrite(plan.stateFile, { ...header, pending: { before: plan.before, after: plan.after, beforeState: plan.previous, afterState: plan.state } });
  saveSettings();
  if (plan.state === null) fs.unlinkSync(plan.stateFile);
  else atomicJsonWrite(plan.stateFile, { ...header, state: plan.state });
}
