// The mod's shared shapes. The design and the reasons are in docs/specs/2026-10-10-ripple-mod.md.

// Engine contracts must be self-contained; i18n re-exports this language type.
export type Lang = 'ko' | 'en' | 'zh' | 'ja' | 'es' | 'pt'

export type StatusLine = string | null

export type StatusRequest = {
  at: string
  source: string
  target: string
  provider: string
  status: number | string
  ok: boolean
  ms: number
  effort?: string
  usage?: { input: number; cached: number; cacheWrite?: number; output: number }
  note?: string
  /** Not ok, but the client sent it again on its own: not a failure. */
  resent?: boolean
  session?: string
  /** Sent by the session this mod runs in. */
  mine?: boolean
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** API usage may omit counts; the engine's ModelUsage does not expose cache TTL evidence. */
export type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: {
    ephemeral_1h_input_tokens?: number
    ephemeral_5m_input_tokens?: number
  }
}

/** The bounded excerpts shared by the effort judges; attachments carry counts, not contents. */
export type JudgeInput = {
  messages: readonly { role: 'user' | 'assistant'; text: string }[]
  next: string
  attachments?: readonly { type: string }[]
  current?: { model: string; effort: Effort } | null
  contextPercent?: number
  midTurn?: boolean
}

/** Who judges: Haiku on the person's Claude login, TypeSafe's Jev, or a model through the router. */
export type JudgeKind = 'haiku' | 'jev' | 'model'
/**
 * One verdict as the log pane lists it beside the router's requests: a Jev call never reaches the
 * router, so without this nothing showed who judged, how long it took or that it fell back.
 */
export type JudgeRun = {
  at: number
  /** The effort of a prompt, or the worker for a spawn. */
  for: 'prompt' | 'worker'
  /** The judge the settings ask for, and the one that answered (Haiku when it fell back). */
  asked: JudgeKind
  by: JudgeKind
  ms: number
  effort?: Effort
  sure?: number
  /** Why the asked judge gave no verdict. */
  error?: string
}

/** Domain is the kind of work; level is its required capability, independently. */
export type Domain = 'design' | 'frontend' | 'backend' | 'infra' | 'data' | 'test' | 'docs' | 'research' | 'general'
export type Level = 'light' | 'standard' | 'deep'
/** Whether a task decides what to build (plan) or carries out what was decided (do). */
export type Kind = 'plan' | 'do'
/**
 * The worker ladder's rungs (docs/specs/2026-10-11-worker-ladder.md): the judge's level picks
 * light, standard or hard regardless of kind; only an explicit max tier selects plan.
 */
export type Rung = 'light' | 'standard' | 'hard' | 'plan'
/** One rung: what runs there and how hard it thinks. */
export type Step = { target: TierTarget; effort: Effort }
/** Historical stats include design counts from before the two-axis migration. */
export type Tier = Level | 'design'
/** How a pin stored before 2026-10-11 moved its efforts; read only to migrate it (`ladderFromPin`). */
export type Calibration = { effortOffset?: -2 | -1 | 0 | 1 | 2; floor?: Effort; ceiling?: Effort }
/**
 * The four workers' rungs, each model + effort. Loading (`normalizeSettings`) reads pins from
 * before 2026-10-11 and Auto (experimental, removed 2026-10-12) into it, and drops field rules.
 */
export type Rungs = Partial<Record<Rung, Step[]>>
export type Rule = { mode: 'ladder'; rungs: Rungs }
/** How a provider is paid for: what the Workers card tags each model with, and what presets read. */
export type Billing = 'free' | 'payg' | 'subscription'
/** A model a rung can run, as GET /api/mod-options describes it. */
export type LadderChoice = {
  target: TierTarget
  model: string
  provider: string
  billing: Billing
  /** The model's own effort ladder, in order; empty when unknown. */
  efforts: Effort[]
  /** Its cheapest measured AA cost per task, when measured. */
  cost?: number
}
/** The fill rule's wishes, by name; only `claudeGpt` is used now (the router fills empty rungs with it). */
export type PresetId = 'claude' | 'claudeGpt' | 'gpt' | 'cheap'
/** The fill as computed from the ticked models: the rungs, and the ones it had to fill otherwise. */
export type Preset = { rungs: Record<Rung, Step>; substituted: Rung[] }
export type ProviderAvailability = { usable: boolean; reason?: string; exhaustedUntil?: number }
export type LadderOptions = { until: number; choices: LadderChoice[]; providers?: Record<string, ProviderAvailability> }
export type RouterModel = { value: string; label: string; provider: string; name?: string }
export type WorkerCandidate = { target: TierTarget; model: string; provider: string }
/** A model's AA measurements (GET /api/mod-options `scores`): the fill's cost order reads them. */
export type ModelScore = { model: string; provider: string; variants: { effort: Effort | null; intelligence: number | null; costPerTask: number | null }[] }

/** An agent to spawn: a dispatchable `subagentType`, and a model only for Claude's own agents. */
export type TierTarget = { agent: string; model?: string }

/**
 * An operating mode the user made (docs/specs/2026-10-12-worker-tiers.md "Operating modes").
 * Each rung is an ordered worker list, independent of the base ladder, sharing its ticked models.
 * `until` is an epoch-ms time, the named provider's next known quota reset ('chatgpt' or another
 * ChatGPT provider, or 'anthropic' for Claude), or no automatic end.
 */
export type Mode = {
  id: string
  name: string
  rungs: Rungs
  delegation: 'normal' | 'eager'
  until: 'none' | number | { reset: string }
}

export type Settings = {
  effortAuto: boolean
  judge: JudgeKind
  /** The router model id the `model` judge asks. */
  judgeModel: string
  bias: -2 | -1 | 0 | 1 | 2
  floor: Effort
  ceiling: Effort
  /** off: never; auto: spawns of ripple:auto; all: also general-purpose spawns with no model. */
  agentAuto: 'off' | 'auto' | 'all'
  jevSource: 'typesafe' | 'zen'
  /** Only the general ladder: the four workers replaced the per-field rules (2026-10-12). */
  rules: { general: Rule }
  /**
   * The models the user ticked (docs/specs/2026-10-12-worker-tiers.md): worker agent names and
   * `general-purpose:<model>` for Claude's own. Empty means every model. Rungs run, and the fill
   * picks, only among these.
   */
  allow: string[]
  /**
   * The allow-list keys of every worker that existed when `allow` was last written (what
   * `candidateKey` returns). A key absent from this non-empty list counts as ticked on; empty means
   * either every worker is ticked (`allow` empty) or all writers predate the field (#56).
   */
  allowKnown: string[]
  /** The user's operating modes; none is built in. */
  modes: Mode[]
  /** The mode that is on, by id; absent when none is. */
  activeMode?: string
  /**
   * When the active mode was turned on (epoch ms): a mode that runs until the quota resets ends at
   * the first reset after this.
   */
  activeSince?: number
  providers: Record<string, boolean>
  /**
   * What ran when a pinned tier's agent was unavailable, before the ladder (2026-10-11). Kept so a
   * stored choice survives; the ladder moves one rung up instead.
   */
  fallback: TierTarget
  keepWarm: boolean
  keepWarmHours: 1 | 2 | 4 | 8
  keepWarmMinTokens: number
  compactWith: 'haiku' | 'session'
  handoffSkill: string
  handoffAfter: 'continue' | 'confirm' | 'copy'
  handoffButton: 'advised' | 'always'
  /** Context percent at which the context reads heavy (and the swamp band shows, when on). */
  swampAt: number
  /** The heavy-context band; off unless switched on. */
  swampAlert: boolean
  layout: 'dashboard' | 'minimal'
  appearance: 'auto' | 'dark' | 'light'
  language: 'auto' | Lang
  /** Band parts switched off: 'timer' | 'reason' | 'route'. */
  hide: string[]
  /** Band chips switched on, off by default: 'context' | 'limits'. */
  extras: string[]
  setupDone: boolean
}

/** The admin API always returns a complete normalized settings object. */
export type ModSettingsSnapshot = {
  settings: Settings
  revision: number
  stored: boolean
  /** The stored settings still held field overrides or Auto, which the four workers replaced; true until the next save. */
  legacy?: boolean
}
/** Arrays and rule mode changes are atomic; other edits are rebased by field path. */
export type SettingsChange = { path: string[]; value?: unknown; remove?: boolean }
export type SettingsSync = { schemaVersion?: number; revision: number | null; pending: SettingsChange[]; migrationChecked: boolean; migration: Settings | null }

/** A judge's answer for the main chat's next prompt. */
export type Verdict = { effort: Effort; sure?: number; why: string }

/** The effort the main chat runs at now, and who set it. */
export type Pick = Verdict & { by: JudgeKind | 'manual' | 'followup'; at: number }

/** A judge's answer for a delegated task; a judge that names no kind means do. */
export type WorkerVerdict = { domain: Domain; level: Level; kind?: Kind; effort: Effort; sure?: number; why: string }

/** What a spawn of ripple:auto (or a taken-over spawn) was turned into. */
export type WorkerPick = WorkerVerdict & {
  /** The ladder rung that ran it (absent for explicit choices). */
  rung?: Rung
  /** One-based position in the selected rung; skipped entries explain ordered fallback. */
  position?: number
  skipped?: { rung: Rung; position: number; model: string; reason: string }[]
  target: TierTarget
  by: JudgeKind | 'marker' | 'default'
  ms: number
  /** Set when the tier's own agent could not run and the fallback did. */
  fallbackReason?: string
}

export type AgentState = 'running' | 'waiting' | 'done' | 'failed'

export type AgentRec = {
  id: string
  description: string
  /** The agent type that ran. */
  type: string
  model?: string
  pick?: WorkerPick
  state: AgentState
  /** The tool it is in now, in a few words. */
  now?: string
  toolSince?: number
  startedAt: number
  endedAt?: number
  /** Weighted tokens (spec §5 stats weights). */
  cost: number
}

/** The main chat's prompt cache as far as its responses show it. */
export type CacheMemo = {
  ttlMs: number
  lastReplyAt: number
  expiresAt: number
}

/** Keep-warm bookkeeping for this chat. */
export type WarmState = {
  pings: number
  /** Weighted tokens the pings cost. */
  cost: number
  /** Set when keep-warm stopped by itself, with why. */
  stopped?: string
  lastPingAt?: number
}

/** The hottest plan window at or above the alert line. */
export type Hot = { kind: string; percent: number; resetsAt?: string }

export type Stats = {
  prompts: number
  requests: number
  input: number
  write: number
  read: number
  out: number
  byEffort: Partial<Record<Effort, { prompts: number; cost: number }>>
  judge: { haiku: number; jev: number; model: number; ms: number; tokens: number }
  workers: Partial<Record<Tier, number>>
  warm: { pings: number; cost: number }
}

export type HandoffKind = 'quick' | 'full'
/** `ready`: written, waiting on Confirm first's card; `opened`: a new session was opened with it. */
export type HandoffStage = 'writing' | 'clearing' | 'done' | 'ready' | 'opened' | 'copied' | 'failed'
export type SetupStep = 1 | 2 | 3 | 4
export type ResultStage = 'handingOff' | 'handoffReady' | 'handoffDone' | 'compacting' | 'compacted' | 'failed'
export type JevState = {
  source: 'env' | 'file' | 'pasted' | 'zen' | null
  test: { state: 'idle' | 'testing' | 'ok' | 'fail'; message?: string }
}

/**
 * GPT Fast for all sessions, as the router last acknowledged it (GET/PUT /api/fast).
 * `unknown`: not read yet; `unavailable`: the router did not answer or is too old (nothing is
 * assumed); `ready`: `value` is the router's: null inherits, true is priority, false forces standard.
 */
export type GptFast = {
  status: 'unknown' | 'ready' | 'unavailable'
  scope: 'global' | null
  value: boolean | null
  revision: number
  /** A write is out: a second press is ignored until it is answered. */
  writing: boolean
}

declare module 'claude-code' {
  interface PluginState {
    ripple: {
      line: StatusLine
      last: StatusRequest | null
      requests: StatusRequest[]
      logOpen: boolean
      onlySession: boolean
      bandHidden: boolean
      settings: Settings | null
      settingsSync: SettingsSync
      settingsBase: Settings | null
      lang: Lang
      pick: Pick | null
      deciding: boolean
      paused: boolean
      agents: AgentRec[]
      cache: CacheMemo | null
      warm: WarmState
      /** Keep-warm for this chat alone, set by the band's flame; null follows Settings. */
      warmHere: boolean | null
      context: { percent: number; tokens: number; window: number } | null
      hot: Hot | null
      hotHidden: number | null
      saveUntil: number | null
      swampHidden: number | null
      coldHidden: boolean
      kept: { pings: number; tokens: number } | null
      judgeDown: string | null
      advice: string | null
      handoff: { stage: HandoffStage; kind: HandoffKind; text?: string } | null
      panel: 'settings' | 'setup' | 'compact' | 'clear' | 'handoff' | null
      busy: boolean
      decidingSince: number | null
      heldPick: Pick | null
      appEffort: Effort | number | null
      modelIs: string | null
      lastRequest: { model: string; appEffort?: string | number; sentEffort?: string | number } | null
      lastSpawn: WorkerPick | null
      lastRealReplyAt: number | null
      stats: Stats
      promptCount: number
      adviceQueue: string | null
      handoffQueued: boolean
      handoffWaiting: boolean
      handoffChoiceKind: HandoffKind
      handoffChoiceAfter: 'continue' | 'confirm' | 'copy'
      result: { stage: ResultStage; detail?: string } | null
      settingsDraft: Settings | null
      setupStep: SetupStep
      compactNote: string
      effortMenuOpen: boolean
      agentsOpen: boolean
      agentsShowDone: boolean
      jev: JevState
      routerModels: RouterModel[]
      /** The router's rung choices and presets (GET /api/mod-options), for the quick settings. */
      ladderOptions: LadderOptions | null
      /** The active mode the eager note was last sent for (`modes.ts modeKey`); cleared on compaction. */
      modeNoted: string | null
      judgeDownHidden: string | null
      /** Judge failure reasons already said this session. */
      judgeSeen: string[]
      judgeRuns: JudgeRun[]
      judgeDownNetwork: boolean
      limit: Hot | null
      /** This session's GPT Fast: the router's last acknowledgement, never a stored wish. */
      gptFast: GptFast
      demo: 'cold' | 'swamp' | 'hot' | 'down' | 'kept' | null
    }
  }
}
