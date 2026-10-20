// Engine wiring lives here: imported logic and drawings never receive the engine interface.
// Timers own background work; hooks only admit/rewrite a request and record its result.
import { atom, read, update } from 'claude-code'
import type { AgentSpawnInput, EngineInterface, ModelCompleteResult, ModelForkResult, Register, RenderElement, RenderInput, SessionRateLimit, ToolCallInput, TurnStepInput, TurnUsage } from 'claude-code'
import type { AgentRec, Effort, GptFast, JudgeInput, JudgeKind, JudgeRun, ModSettingsSnapshot, Pick, Settings, StatusRequest, TierTarget, Verdict, WorkerCandidate, WorkerPick, WorkerVerdict } from '../types'
import { MOD_SETTINGS_SCHEMA_VERSION, applySettingsChanges, normalizeSettings, settingsChanges } from './settings'
import { debugText, langFrom, t } from './i18n'
import type { Lang } from './i18n'
import { EFFORT_JUDGE_SYSTEM, finalEffort, isCacheSafeModel, isShortFollowUp, jevEffortRequest, jevFailure, jevUsage, jevWorkerRequest, judgeContext, parseEffortVerdict, parseJevEffort, parseJevKey, parseJevWorker, shouldJudge } from './judge'
import { AUTO_DESCRIPTION, WORKER_JUDGE_SYSTEM, agentProvider, candidateUsable, chatgptUsable, claudeCandidates, ladderOptionsFrom, ladderPick, parseWorkerVerdict, readMarker, routerModelOptions, spawnModel, spawnTitle, takesOver, workerJudgeInput, zenJev } from './workers'
import { MARKER, agentModel, fixSpawn } from './worker'
import { activeModeOf, claudeWindow, eagerNote, modeKey, modeOver, quotaWindows, resetProvider, routingSettings } from './modes'
import type { QuotaWindow } from './modes'
import type { Spawn, WorkerFix } from './worker'
import { afterPing, nextMemo, restoreFromResume, shouldPing } from './cache'
import { bandPriority, claudeLimitsFrom, coldAlert, hotAlert, hottest, keptAlert, saveUntil as limitSaveUntil, swampAlert, swamped } from './session'
import { COMPACT_SYSTEM, compactResult, serializeTranscript } from './compact'
import { ADVICE_SYSTEM, FULL_PROMPT, QUICK_PROMPT, adviceDue, adviceInput, parseAdvice, wrapForNewChat } from './handoff'
import { addJudge, addPrompt, addRequest, addWarm, addWorker, emptyStats, formatStats, weighted } from './stats'
import { besideBand, renderBand, renderFooter } from './ui/band'
import { renderAlert } from './ui/alerts'
import { renderSettings } from './ui/settings'
import { renderSetup } from './ui/setup'
import { renderAgents } from './ui/agents'
import { renderLog } from './ui/log'
import { EFFORTS, modelName, nextMinuteChange, routeOf, targetLabel } from './ui/view'
import type { AlertActions, AlertView, BandActions, DashboardView, FastState, Frame, SettingsActions, SettingsView, SetupActions } from './ui/view'

const line = atom({ plugin: 'ripple', key: 'line' } as const, null)
const last = atom({ plugin: 'ripple', key: 'last' } as const, null)
const requests = atom({ plugin: 'ripple', key: 'requests' } as const, [])
const logOpen = atom({ plugin: 'ripple', key: 'logOpen' } as const, false)
const onlySession = atom({ plugin: 'ripple', key: 'onlySession' } as const, false)
const bandHidden = atom({ plugin: 'ripple', key: 'bandHidden' } as const, false)
const settings = atom({ plugin: 'ripple', key: 'settings' } as const, null)
const settingsSync = atom({ plugin: 'ripple', key: 'settingsSync' } as const, { schemaVersion: MOD_SETTINGS_SCHEMA_VERSION, revision: null, pending: [], migrationChecked: false, migration: null })
const settingsBase = atom({ plugin: 'ripple', key: 'settingsBase' } as const, null)
const lang = atom({ plugin: 'ripple', key: 'lang' } as const, 'en')
const pick = atom({ plugin: 'ripple', key: 'pick' } as const, null)
const deciding = atom({ plugin: 'ripple', key: 'deciding' } as const, false)
const decidingSince = atom({ plugin: 'ripple', key: 'decidingSince' } as const, null)
const paused = atom({ plugin: 'ripple', key: 'paused' } as const, false)
const heldPick = atom({ plugin: 'ripple', key: 'heldPick' } as const, null)
const appEffort = atom({ plugin: 'ripple', key: 'appEffort' } as const, null)
const modelIs = atom({ plugin: 'ripple', key: 'modelIs' } as const, null)
const lastRequest = atom({ plugin: 'ripple', key: 'lastRequest' } as const, null)
const lastSpawn = atom({ plugin: 'ripple', key: 'lastSpawn' } as const, null)
const agents = atom({ plugin: 'ripple', key: 'agents' } as const, [])
const cache = atom({ plugin: 'ripple', key: 'cache' } as const, null)
const warm = atom({ plugin: 'ripple', key: 'warm' } as const, { pings: 0, cost: 0 })
const warmHere = atom({ plugin: 'ripple', key: 'warmHere' } as const, null)
const lastRealReplyAt = atom({ plugin: 'ripple', key: 'lastRealReplyAt' } as const, null)
const context = atom({ plugin: 'ripple', key: 'context' } as const, null)
const hot = atom({ plugin: 'ripple', key: 'hot' } as const, null)
const limit = atom({ plugin: 'ripple', key: 'limit' } as const, null)
const hotHidden = atom({ plugin: 'ripple', key: 'hotHidden' } as const, null)
const saveUntil = atom({ plugin: 'ripple', key: 'saveUntil' } as const, null)
const swampHidden = atom({ plugin: 'ripple', key: 'swampHidden' } as const, null)
const coldHidden = atom({ plugin: 'ripple', key: 'coldHidden' } as const, false)
const kept = atom({ plugin: 'ripple', key: 'kept' } as const, null)
const judgeDown = atom({ plugin: 'ripple', key: 'judgeDown' } as const, null)
const judgeDownHidden = atom({ plugin: 'ripple', key: 'judgeDownHidden' } as const, null)
const judgeSeen = atom({ plugin: 'ripple', key: 'judgeSeen' } as const, [])
const judgeRuns = atom({ plugin: 'ripple', key: 'judgeRuns' } as const, [])
// The standing judge failure was a dropped connection or a timeout: the card blames the network, not the judge.
const judgeDownNetwork = atom({ plugin: 'ripple', key: 'judgeDownNetwork' } as const, false)
const advice = atom({ plugin: 'ripple', key: 'advice' } as const, null)
const adviceQueue = atom({ plugin: 'ripple', key: 'adviceQueue' } as const, null)
const promptCount = atom({ plugin: 'ripple', key: 'promptCount' } as const, 0)
const handoff = atom({ plugin: 'ripple', key: 'handoff' } as const, null)
const handoffQueued = atom({ plugin: 'ripple', key: 'handoffQueued' } as const, false)
const handoffWaiting = atom({ plugin: 'ripple', key: 'handoffWaiting' } as const, false)
const handoffChoiceKind = atom({ plugin: 'ripple', key: 'handoffChoiceKind' } as const, 'quick')
const handoffChoiceAfter = atom({ plugin: 'ripple', key: 'handoffChoiceAfter' } as const, 'continue')
const resultCard = atom({ plugin: 'ripple', key: 'result' } as const, null)
const panel = atom({ plugin: 'ripple', key: 'panel' } as const, null)
const busy = atom({ plugin: 'ripple', key: 'busy' } as const, false)
const stats = atom({ plugin: 'ripple', key: 'stats' } as const, emptyStats())
const settingsDraft = atom({ plugin: 'ripple', key: 'settingsDraft' } as const, null)
const setupStep = atom({ plugin: 'ripple', key: 'setupStep' } as const, 1)
const compactNote = atom({ plugin: 'ripple', key: 'compactNote' } as const, '')
const effortMenuOpen = atom({ plugin: 'ripple', key: 'effortMenuOpen' } as const, false)
const agentsOpen = atom({ plugin: 'ripple', key: 'agentsOpen' } as const, false)
const agentsShowDone = atom({ plugin: 'ripple', key: 'agentsShowDone' } as const, false)
const jev = atom({ plugin: 'ripple', key: 'jev' } as const, { source: null, test: { state: 'idle' } })
const routerModels = atom({ plugin: 'ripple', key: 'routerModels' } as const, [])
const ladderOptions = atom({ plugin: 'ripple', key: 'ladderOptions' } as const, null)
const modeNoted = atom({ plugin: 'ripple', key: 'modeNoted' } as const, null)
const demo = atom({ plugin: 'ripple', key: 'demo' } as const, null)
// Shared GPT Fast: only what the router last acknowledged, never a preference kept here.
const gptFast = atom({ plugin: 'ripple', key: 'gptFast' } as const, { status: 'unknown', scope: null, value: null, revision: 0, writing: false } as GptFast)

/**
 * Whether a state write would change anything. A write redraws each reader, and a redraw that
 * hands the host new pictures reads as a blink (2026-10-10: the band flashed on polls and steps),
 * so the writes on every step and poll are skipped when they would store what is there. The
 * engine's scan wants each atom named at its read and update, hence a test rather than a wrapper.
 */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

const LOG_PANE = 'ripple-log'
const AGENTS_PANE = 'ripple-agents'
const HAIKU = 'claude-haiku-5-5'
const EXECUTOR = 'Do the assigned task yourself. Inspect the relevant files, implement what was asked, and verify the result. Report the outcome concisely, citing evidence and marking uncertainty. Never delegate to another agent. Do not create unrequested files or commit unless explicitly asked.'
let timersStarted = false
let polling = false
let ticking = false
let forking = false
let forkUsage: TurnUsage | null = null
let countdownTimer: { at: number; cancel: () => void } | null = null
let judgeSequence = 0
/** Jev's network blips and timeouts in a row. */
let jevBlips = 0
let generation = 0
let carriedPick = false
// Serialize settings reads and writes so a slow poll cannot overwrite a queued edit.
let settingsWork: Promise<void> = Promise.resolve()
function settingsTask<T>(work: () => Promise<T>): Promise<T> {
  const result = settingsWork.then(work)
  settingsWork = result.then(() => undefined, () => undefined)
  return result
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}
function effortOf(value: unknown): Effort | undefined {
  return typeof value === 'string' && EFFORTS.includes(value as Effort) ? value as Effort : undefined
}
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
async function report($: EngineInterface, where: string, error: unknown): Promise<void> {
  await $.ui.log(t(await read($, lang), 'commands.debugLog', { where, reason: reason(error) }), { to: 'debug' })
}
async function userHome($: EngineInterface): Promise<string> {
  return (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '~'
}
async function rippleHome($: EngineInterface): Promise<string> {
  return (await $.env.get('CLAUDERIPPLE_HOME')) ?? `${await userHome($)}/.clauderipple`
}
// The fs API has no append: serialize read/write pairs so concurrent picks in this mod survive.
let workerLogWork: Promise<void> = Promise.resolve()
async function persistWorkerPick($: EngineInterface, entry: Record<string, unknown>): Promise<void> {
  const work = workerLogWork.then(async () => {
    try {
      const path = `${await rippleHome($)}/logs/worker-picks.jsonl`
      const old = await $.fs.exists(path) ? await $.fs.read(path) : ''
      const lines = old.split('\n').filter(line => line.trim()).slice(-299)
      await $.fs.write(path, [...lines, JSON.stringify(entry)].join('\n') + '\n')
    } catch (error) { await report($, 'worker pick log', error) }
  })
  // A reporting failure must not poison the queue or undo the selected spawn either.
  workerLogWork = work.catch(() => undefined)
  await workerLogWork
}
async function claudeHome($: EngineInterface): Promise<string> {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await userHome($)}/.claude`
}
async function optionalFile($: EngineInterface, path: string): Promise<string | undefined> {
  try { return await $.fs.read(path) }
  catch (error) { await report($, 'optional file', error); return undefined }
}
async function adminUrl($: EngineInterface): Promise<string> {
  const text = await optionalFile($, `${await rippleHome($)}/config.json`)
  if (!text) return 'http://127.0.0.1:8792'
  const config = object(JSON.parse(text))
  const admin = object(config.admin).port
  const listen = object(config.listen).port
  const port = typeof admin === 'number' ? admin : (typeof listen === 'number' ? listen : 8791) + 1
  return `http://127.0.0.1:${port}`
}
/** Opens a URL with the system's opener (a browser page, or a claude:// link the desktop app takes); throws when it cannot. */
async function openUrl($: EngineInterface, url: string): Promise<void> {
  let argv: string[]
  // cmd reads & as a command separator: escaped, a link's query reaches start whole.
  if (await $.env.get('OS') === 'Windows_NT') argv = ['cmd', '/c', 'start', '', url.replace(/&/g, '^&')]
  else {
    const platform = await $.process.run(['uname', '-s'], { timeoutMs: 2000 })
    if (platform.exitCode !== 0) throw new Error(platform.stderr || 'uname failed')
    argv = [platform.stdout.trim() === 'Darwin' ? 'open' : 'xdg-open', url]
  }
  const result = await $.process.run(argv, { timeoutMs: 2000 })
  if (result.exitCode !== 0) throw new Error(result.stderr || `opener exited ${result.exitCode}`)
}
async function openAllSettings($: EngineInterface): Promise<void> {
  const url = `${await adminUrl($)}/#mod`
  try {
    await openUrl($, url)
  } catch (error) {
    await report($, 'open mod settings', error)
    await $.ui.toast(url)
  }
}
async function currentSettings($: EngineInterface): Promise<Settings> {
  return normalizeSettings(await read($, settings))
}
async function resolveLanguage($: EngineInterface, s: Settings): Promise<Lang> {
  if (s.language !== 'auto') return s.language
  try {
    const value = (await $.settings.read()).language
    const host = langFrom(typeof value === 'string' ? value : undefined)
    if (host) return host
  } catch (error) { await report($, 'language settings', error) }
  // On a Mac the system language comes before LANG: a session the desktop app starts can carry
  // LANG=en_US on a Korean Mac (seen 2026-10-10: Korean headless, English in the Code tab).
  // The engine exposes no platform noun. Avoid running macOS defaults elsewhere.
  if (await $.env.get('OS') !== 'Windows_NT') {
    try {
      const platform = await $.process.run(['uname', '-s'], { timeoutMs: 2000 })
      if (platform.exitCode === 0 && platform.stdout.trim() === 'Darwin') {
        const apple = await $.process.run(['defaults', 'read', '-g', 'AppleLocale'], { timeoutMs: 2000 })
        const mac = apple.exitCode === 0 ? langFrom(apple.stdout) : undefined
        if (mac) return mac
        if (apple.exitCode !== 0) await report($, 'language locale', apple.stderr)
      }
    } catch (error) { await report($, 'language locale', error) }
  }
  return langFrom(await $.env.get('LANG')) ?? langFrom(await $.env.get('LC_ALL')) ?? 'en'
}
async function registerAuto($: EngineInterface, s: Settings): Promise<void> {
  if (s.agentAuto === 'off') return
  await $.agent.register({ name: 'auto', description: AUTO_DESCRIPTION, prompt: EXECUTOR, disallowedTools: ['Agent'] })
}
async function installSettings($: EngineInterface, s: Settings): Promise<void> {
  const previous = await currentSettings($)
  await update($, settings, () => s)
  const resolved = await resolveLanguage($, s)
  await update($, lang, () => resolved)
  // A router poll can land before the session binds, when register rejects; session.start
  // registers again, so a rejection here must not cut the rest of the install short.
  try { await registerAuto($, s) } catch (error) { await report($, 'agent register', error) }
  if (!s.effortAuto) await update($, heldPick, () => null)
  if (s.keepWarm && !previous.keepWarm) await update($, warm, value => ({ ...value, stopped: undefined }))
  // Settings caught up with this chat's own choice: it follows Settings again.
  if (await read($, warmHere) === s.keepWarm) await update($, warmHere, () => null)
}
function settingsSnapshot(text: string): ModSettingsSnapshot {
  const value = object(JSON.parse(text))
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || typeof value.stored !== 'boolean' || !value.settings || typeof value.settings !== 'object' || Array.isArray(value.settings)) throw new Error('invalid router settings snapshot')
  return { settings: normalizeSettings(value.settings), revision: Number(value.revision), stored: value.stored }
}
async function routerSettingsDown($: EngineInterface, error: unknown): Promise<void> {
  const notice = t(await read($, lang), 'band.routerDown')
  if (await read($, line) !== notice) await update($, line, () => notice)
  await report($, 'router settings', error)
}
async function acceptSettings($: EngineInterface, snapshot: ModSettingsSnapshot, sent = 0): Promise<void> {
  const sync = await update($, settingsSync, value => ({ ...value, revision: snapshot.revision, pending: value.pending.slice(sent), migration: snapshot.stored ? null : value.migration }))
  const base = snapshot.stored ? snapshot.settings : sync.migration ?? snapshot.settings
  await installSettings($, applySettingsChanges(base, sync.pending))
  await rebaseDraft($)
}
async function putSettings($: EngineInterface, admin: string, base: Settings): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const sync = await read($, settingsSync)
    // A migration that lost a CAS race is not a user edit: never retry it as a full save.
    if (!sync.pending.length && !sync.migration) return
    const count = sync.pending.length
    const response = await $.http.fetch(`${admin}/api/mod-settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: MOD_SETTINGS_SCHEMA_VERSION, settings: applySettingsChanges(base, sync.pending), revision: sync.revision }) })
    if (!response.ok && response.status !== 409) throw new Error(t(await read($, lang), 'commands.routerHttp', { status: response.status }))
    const snapshot = settingsSnapshot(response.text)
    await acceptSettings($, snapshot, response.ok ? count : 0)
    if (response.ok) return
    base = snapshot.settings
    if (attempt === 1) throw new Error(t(await read($, lang), 'commands.routerHttp', { status: 409 }))
  }
}
async function syncSettings($: EngineInterface, admin: string): Promise<void> {
  const response = await $.http.fetch(`${admin}/api/mod-settings`)
  if (!response.ok) throw new Error(t(await read($, lang), 'commands.routerHttp', { status: response.status }))
  const snapshot = settingsSnapshot(response.text)
  let sync = await read($, settingsSync)
  // Session atoms survive reloads. Old pending paths/drafts cannot prove user intent
  // under this format; discard them rather than granting an old overwrite a new version.
  if (sync.schemaVersion !== MOD_SETTINGS_SCHEMA_VERSION) {
    sync = await update($, settingsSync, () => ({ schemaVersion: MOD_SETTINGS_SCHEMA_VERSION, revision: null, pending: [], migrationChecked: false, migration: null }))
    await update($, settingsBase, () => null)
  }
  if (snapshot.stored && sync.migration) sync = await update($, settingsSync, value => ({ ...value, migration: null }))
  if (!sync.migrationChecked) {
    let migration: Settings | null = null
    if (!snapshot.stored) {
      const legacy = await $.store.get('settings')
      const setupDone = await $.store.get('setupDone')
      if (legacy !== undefined && legacy !== null || setupDone === true) {
        migration = normalizeSettings(legacy)
        if (setupDone === true) migration.setupDone = true
      }
    }
    sync = await update($, settingsSync, value => ({ ...value, migrationChecked: true, migration }))
  }
  if (sync.revision !== snapshot.revision || await read($, settings) === null) await acceptSettings($, snapshot)
  sync = await read($, settingsSync)
  if (sync.pending.length || sync.migration) await putSettings($, admin, snapshot.stored ? snapshot.settings : sync.migration ?? snapshot.settings)
}
async function loadSettings($: EngineInterface): Promise<void> {
  try { await settingsTask(async () => { await syncSettings($, await adminUrl($)) }) }
  catch (error) { await installSettings($, await currentSettings($)); await routerSettingsDown($, error) }
  const hidden = (await $.store.get('bandHidden')) === true
  await update($, bandHidden, () => hidden)
  if (!(await read($, pick))) {
    const carried = object(await $.store.get('pick'))
    const level = effortOf(carried.effort)
    if (level && ['haiku', 'jev', 'model', 'manual', 'followup'].includes(String(carried.by))) {
      carriedPick = true
      await update($, pick, () => ({ effort: level, why: typeof carried.why === 'string' ? carried.why : '', by: carried.by as Pick['by'], at: typeof carried.at === 'number' ? carried.at : 0 }))
    }
  }
}
async function saveSettings($: EngineInterface, s: Settings, baseline?: Settings): Promise<boolean> {
  // Both sides use the same format: normalization alone is never an edit.
  const changes = settingsChanges(normalizeSettings(baseline ?? await currentSettings($)), normalizeSettings(s))
  try {
    await settingsTask(async () => {
      await update($, settingsSync, value => ({ ...value, pending: [...value.pending, ...changes] }))
      await installSettings($, applySettingsChanges(await currentSettings($), changes))
      const admin = await adminUrl($)
      // Always rebase on the router, never PUT the normalized local atom wholesale.
      await syncSettings($, admin)
    })
    return true
  } catch (error) { await routerSettingsDown($, error); return false }
}
async function installPick($: EngineInterface, value: Pick): Promise<void> {
  carriedPick = false
  await update($, pick, () => value)
  await $.store.set('pick', value)
}

// The engine's pane list is authoritative: a reload can close panes without sending ui.close.
async function isLogUp($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(p => p.id === LOG_PANE)
}
async function syncPanes($: EngineInterface): Promise<void> {
  const panes = await $.ui.panes()
  const log = panes.some(p => p.id === LOG_PANE)
  const agent = panes.some(p => p.id === AGENTS_PANE)
  if (log !== await read($, logOpen)) await update($, logOpen, () => log)
  if (agent !== await read($, agentsOpen)) await update($, agentsOpen, () => agent)
}
async function toggleLog($: EngineInterface): Promise<boolean> {
  const language = await read($, lang)
  const open = await isLogUp($)
  if (open) await $.ui.close({ id: LOG_PANE })
  else await $.ui.open({ id: LOG_PANE, title: t(language, 'commands.logTitle') })
  await syncPanes($)
  if (!open) await refreshRouter($)
  return !open
}
async function toggleAgents($: EngineInterface): Promise<void> {
  const language = await read($, lang)
  const open = (await $.ui.panes()).some(p => p.id === AGENTS_PANE)
  if (open) await $.ui.close({ id: AGENTS_PANE })
  else await $.ui.open({ id: AGENTS_PANE, title: t(language, 'commands.agentsTitle') })
  await syncPanes($)
}
async function toggleBar($: EngineInterface): Promise<boolean> {
  const hidden = !await read($, bandHidden)
  await $.store.set('bandHidden', hidden)
  await update($, bandHidden, () => hidden)
  return !hidden
}
async function refreshRouter($: EngineInterface): Promise<void> {
  const language = await read($, lang)
  if (polling) return
  polling = true
  try {
    await syncPanes($)
    const admin = await adminUrl($)
    await settingsTask(() => syncSettings($, admin))
    await endModeIfOver($)
    const open = await isLogUp($)
    if (!open && await read($, bandHidden)) { await update($, line, () => null); return }
    const session = await $.session.id()
    const own = await $.http.fetch(`${admin}/api/requests?kind=messages&n=${open ? 60 : 1}&session=${encodeURIComponent(session)}`)
    if (!own.ok) throw new Error(t(language, 'commands.routerHttp', { status: own.status }))
    const mine = (object(JSON.parse(own.text)).requests ?? []) as StatusRequest[]
    const newest = mine[0] ?? null
    const notice = newest && newest.session === undefined ? t(language, 'band.routerRestart') : null
    if (notice !== await read($, line)) await update($, line, () => notice)
    // Do not show a route belonging to another chat from a router without session support.
    const route = notice ? null : newest
    if (JSON.stringify(route) !== JSON.stringify(await read($, last))) await update($, last, () => route)
    if (!open) return
    let shown = mine
    if (!await read($, onlySession)) {
      const all = await $.http.fetch(`${admin}/api/requests?kind=messages&n=60`)
      if (!all.ok) throw new Error(t(language, 'commands.routerHttp', { status: all.status }))
      shown = (object(JSON.parse(all.text)).requests ?? []) as StatusRequest[]
    }
    const rows = shown.map(record => ({ ...record, mine: record.session === session }))
    if (JSON.stringify(rows) !== JSON.stringify(await read($, requests))) await update($, requests, () => rows)
  } catch (error) {
    if (await read($, line) !== t(language, 'band.routerDown')) await update($, line, () => t(language, 'band.routerDown'))
    await report($, 'router poll', error)
  } finally { polling = false }
}

// Files and availability are sampled at spawn, not cached across quota/account changes.
async function workerFiles($: EngineInterface): Promise<Map<string, string>> {
  const text = await optionalFile($, `${await rippleHome($)}/generated-agents.json`)
  const names = text ? strings(object(JSON.parse(text)).agents) : []
  const files = new Map<string, string>()
  for (const name of names) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) continue
    const file = await optionalFile($, `${await claudeHome($)}/agents/${name}.md`)
    if (file && agentModel(file)) files.set(name, file)
  }
  return files
}
async function workerFix($: EngineInterface, spawn: Spawn): Promise<WorkerFix | null> {
  const text = await optionalFile($, `${await rippleHome($)}/generated-agents.json`)
  if (!text || !strings(object(JSON.parse(text)).agents).includes(spawn.subagentType)) return null
  if (!/^[A-Za-z0-9_.-]+$/.test(spawn.subagentType)) return null
  const file = await optionalFile($, `${await claudeHome($)}/agents/${spawn.subagentType}.md`)
  const model = file ? agentModel(file) : undefined
  return model ? fixSpawn(spawn, model) : null
}
async function availability($: EngineInterface): Promise<boolean> {
  try {
    const status = await $.http.fetch(`${await adminUrl($)}/api/status`)
    return status.ok ? chatgptUsable(JSON.parse(status.text)) : true
  } catch (error) { await report($, 'availability unknown', error); return true }
}
async function refreshModels($: EngineInterface): Promise<void> {
  const response = await $.http.fetch(`${await adminUrl($)}/api/config`)
  if (!response.ok) throw new Error(t(await read($, lang), 'commands.routerHttp', { status: response.status }))
  await update($, routerModels, () => routerModelOptions(JSON.parse(response.text)))
}
/** How long the rung choices are kept: ten minutes. */
const KEEP_MS = 600000

/**
 * The quick settings' rung choices, read again each time the panel opens: a model ticked on the
 * dashboard shows in every Select without a restart. A failure keeps what was there.
 */
async function refreshLadder($: EngineInterface): Promise<void> {
  try {
    const response = await $.http.fetch(`${await adminUrl($)}/api/mod-options`)
    if (!response.ok) throw new Error(t(await read($, lang), 'commands.routerHttp', { status: response.status }))
    const fresh = ladderOptionsFrom(JSON.parse(response.text), await $.clock.now() + KEEP_MS, (await currentSettings($)).allow, (await currentSettings($)).allowKnown)
    if (!same(await read($, ladderOptions), fresh)) await update($, ladderOptions, () => fresh)
  } catch (error) { await report($, 'ladder options', error) }
}
/** Turns a mode on (stamping when, for a mode that runs until the quota resets), or off with ''. */
async function setMode($: EngineInterface, id: string): Promise<void> {
  const change: Partial<Settings> = id ? { activeMode: id, activeSince: await $.clock.now() } : { activeMode: undefined, activeSince: undefined }
  await settingsActions($).patch(change)
}
/** Keep observed reset deadlines while a mode is on, even if the next snapshot rolls forward. */
let modeQuotaAt = 0
let modeQuotaKey: string | null = null
let modeQuotaWindows: QuotaWindow[] = []
let endingMode = false
/** The chosen provider's windows: Claude uses the band's binding limit; ChatGPT its account quota API. */
async function modeWindows($: EngineInterface, provider: string): Promise<QuotaWindow[]> {
  if (provider === 'anthropic') return claudeWindow(await read($, limit))
  const response = await $.http.fetch(`${await adminUrl($)}/api/chatgpt-accounts?provider=${encodeURIComponent(provider)}`)
  if (!response.ok) return []
  const body: unknown = JSON.parse(response.text)
  // The router answers for its first ChatGPT provider when the name is not one: not this provider.
  return object(body).provider === provider ? quotaWindows(body) : []
}
/** A mode whose time is up turns itself off and says so (on each poll and prompt). */
async function endModeIfOver($: EngineInterface): Promise<void> {
  if (endingMode) return
  endingMode = true
  try {
    const s = await currentSettings($)
    const mode = activeModeOf(s)
    const key = modeKey(s) + JSON.stringify([mode?.rungs, mode?.until])
    if (modeQuotaKey !== key) { modeQuotaKey = key; modeQuotaAt = 0; modeQuotaWindows = [] }
    if (!mode || mode.until === 'none') return
    const now = await $.clock.now()
    let windows = modeQuotaWindows
    const provider = resetProvider(mode)
    if (provider) {
      // Claude's limit arrives with the session; read it on every check, not once a minute.
      if (provider === 'anthropic') windows = [...windows, ...claudeWindow(await read($, limit))]
      if (!modeOver(mode, s.activeSince, now, windows) && now - modeQuotaAt >= 60_000) {
        const fresh = await modeWindows($, provider)
        modeQuotaAt = now
        // Keep only the earliest observed deadline after activation, plus current snapshots.
        const first = [...windows, ...fresh].filter(w => w.at > (s.activeSince ?? now)).sort((a, b) => a.at - b.at)[0]
        modeQuotaWindows = [...(first ? [first] : []), ...fresh]
        windows = modeQuotaWindows
      }
    }
    if (!modeOver(mode, s.activeSince, now, windows)) return
    await saveSettings($, { ...s, activeMode: undefined, activeSince: undefined }, s)
    await $.ui.toast(t(await read($, lang), 'toasts.modeEnded', { name: mode.name }))
  } catch (error) { await report($, 'mode end', error) }
  finally { endingMode = false }
}
async function jevKey($: EngineInterface, jevSource?: Settings['jevSource']): Promise<string | undefined> {
  const selected = jevSource ?? normalizeSettings(await read($, settingsDraft) ?? await read($, settings)).jevSource
  if (selected === 'zen') {
    const file = await optionalFile($, `${await rippleHome($)}/config.json`)
    const key = file ? zenJev(JSON.parse(file)).authorization : undefined
    await update($, jev, value => ({ ...value, source: key ? 'zen' as const : null }))
    return key
  }
  const env = (await $.env.get('TYPESAFE_API_KEY'))?.trim()
  if (env) {
    if ((await read($, jev)).source !== 'env') await update($, jev, value => ({ ...value, source: 'env' as const }))
    return env
  }
  const file = await optionalFile($, `${await userHome($)}/.config/jev/.env`)
  const key = file ? parseJevKey(file) : undefined
  const source: 'pasted' | 'file' | null = key ? ((await read($, jev)).source === 'pasted' ? 'pasted' : 'file') : null
  if ((await read($, jev)).source !== source) await update($, jev, value => ({ ...value, source }))
  return key
}
/** OpenCode Zen's key from the router's config, when Zen lists a Jev model there; else none. */
async function zenJevKey($: EngineInterface): Promise<string | undefined> {
  const file = await optionalFile($, `${await rippleHome($)}/config.json`)
  if (!file) return undefined
  const config: unknown = JSON.parse(file)
  const models = object(object(object(config).providers)['opencode-zen']).models
  const listed = Array.isArray(models) && models.some(m => { const id = object(m).id; return typeof id === 'string' && id.toLowerCase().includes('jev') })
  return listed ? zenJev(config).authorization : undefined
}
async function saveJevKey($: EngineInterface, input: string): Promise<void> {
  const language = await read($, lang)
  const key = parseJevKey(input) ?? input.trim()
  if (!key || /[\r\n]/.test(key)) throw new Error(t(language, 'toasts.keySingle'))
  const path = `${await userHome($)}/.config/jev/.env`
  const old = await optionalFile($, path) ?? ''
  const entry = `TYPESAFE_API_KEY=${key}`
  const text = /^[ \t]*TYPESAFE_API_KEY[ \t]*=/m.test(old)
    ? old.replace(/^[ \t]*TYPESAFE_API_KEY[ \t]*=[^\r\n]*/gm, () => entry)
    : old + (old && !old.endsWith('\n') ? '\n' : '') + entry + '\n'
  await $.fs.write(path, text)
  const mode = await $.process.run(['chmod', '600', path])
  if (mode.exitCode !== 0) throw new Error(t(language, 'toasts.keyPrivateFailed'))
  await update($, jev, () => ({ source: 'pasted' as const, test: { state: 'idle' as const } }))
  await update($, judgeDown, () => null)
  await $.ui.toast(t(language, 'toasts.keySaved'))
}
/**
 * A judge failure is said once per reason in a session (a toast and the band); the same reason
 * again stays quiet, so a judge that keeps failing does not speak on every message.
 */
async function down($: EngineInterface, message: string, network = false): Promise<void> {
  if ((await read($, judgeSeen)).includes(message)) return
  await update($, judgeSeen, value => [...value, message].slice(-20))
  await update($, judgeDownNetwork, () => network)
  await update($, judgeDown, () => message)
  await $.ui.toast(t(await read($, lang), 'toasts.judgeDown', { reason: message }))
}

type Judged = { verdict: Verdict | WorkerVerdict | undefined; by: JudgeKind; ms: number; error?: string }
function judgeFailure(answer: ModelCompleteResult): string | undefined {
  if (answer.isAnswered) return undefined
  return answer.reason === 'api-error' ? `${answer.reason}: ${answer.error} (${answer.status ?? 'no response'})` : answer.reason
}
async function completeJudge($: EngineInterface, model: string, system: string, prompt: string): Promise<ModelCompleteResult> {
  return $.model.complete({ model, system, prompt, maxTokens: 160, timeoutMs: 6000, effort: 'low' })
}
async function judge($: EngineInterface, s: Settings, input: JudgeInput | { description: string; prompt: string }, worker: boolean, testing = false): Promise<Judged> {
  const language = await read($, lang)
  const started = await $.clock.now()
  const system = worker ? WORKER_JUDGE_SYSTEM : EFFORT_JUDGE_SYSTEM
  const prompt = 'description' in input ? workerJudgeInput(input) : judgeContext(input)
  let failure: string | undefined
  let by: JudgeKind = s.judge
  let verdict: Verdict | WorkerVerdict | undefined
  let blip = false
  if (s.judge === 'jev') {
    try {
      let source = s.jevSource
      let key = await jevKey($, source)
      // No TypeSafe key, but the router's OpenCode Zen offers Jev: ask Jev there.
      if (!key && source === 'typesafe') {
        key = await zenJevKey($)
        if (key) source = 'zen'
      }
      if (!key) throw new Error(t(language, source === 'zen' ? 'jev.zenMissing' : 'toasts.keyMissing'))
      const body = 'description' in input ? jevWorkerRequest(input) : jevEffortRequest(input)
      let model = 'jev-latest'
      if (source === 'zen') {
        const file = await optionalFile($, `${await rippleHome($)}/config.json`)
        model = file ? zenJev(JSON.parse(file)).model : model
      }
      const response = await Promise.race([
        $.http.fetch(source === 'zen' ? 'https://opencode.ai/zen/v1/systemone' : 'https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: { 'content-type': 'application/json', authorization: source === 'zen' ? key : `Bearer ${key}` }, body: JSON.stringify({ ...body, model }) })
          .catch(() => 'network' as const),
        $.clock.sleep(3000).then(() => null),
      ])
      // A dropped connection or a slow answer is often one bad moment, not a broken judge.
      if (!response || response === 'network') {
        blip = true
        throw new Error(jevFailure(response ? 'network' : 'timeout', language))
      }
      if (!response.ok) throw new Error(jevFailure(response.status, language))
      const json: unknown = JSON.parse(response.text)
      // An unsure Jev still answered: its odds settle it here and the bias setting tips it later. Haiku is only for a Jev that failed.
      verdict = worker ? parseJevWorker(json) : parseJevEffort(json, 'current' in input ? input.current : null, language)
      await update($, stats, value => addJudge(value, 'jev', 0, jevUsage(json)))
      if (!verdict) throw new Error(t(language, 'toasts.jevNoVerdict'))
    } catch (error) { failure = reason(error); verdict = undefined }
  }
  if (s.judge === 'model') {
    try {
      const answer = await completeJudge($, s.judgeModel, system, prompt)
      await update($, stats, value => addJudge(value, 'model', 0, answer.usage.input_tokens + answer.usage.output_tokens))
      verdict = answer.isAnswered ? (worker ? parseWorkerVerdict(answer.text) : parseEffortVerdict(answer.text)) : undefined
      if (!verdict) failure = judgeFailure(answer) ?? t(language, 'toasts.routerNoVerdict')
    } catch (error) { failure = reason(error) }
  }
  if (!verdict) {
    by = 'haiku'
    try {
      let answer = await completeJudge($, HAIKU, system, prompt)
      await update($, stats, value => addJudge(value, 'haiku', 0, answer.usage.input_tokens + answer.usage.output_tokens))
      if (!answer.isAnswered) {
        failure ??= judgeFailure(answer)
        answer = await completeJudge($, 'haiku', system, prompt)
        await update($, stats, value => addJudge(value, 'haiku', 0, answer.usage.input_tokens + answer.usage.output_tokens))
      }
      verdict = answer.isAnswered ? (worker ? parseWorkerVerdict(answer.text) : parseEffortVerdict(answer.text)) : undefined
      if (!verdict) failure ??= t(language, 'toasts.haikuNoVerdict')
    } catch (error) { failure ??= reason(error) }
  }
  const ms = Math.max(0, await $.clock.now() - started)
  await update($, stats, value => ({ ...value, judge: { ...value.judge, ms: value.judge.ms + ms } }))
  if (!testing) {
    // The log pane lists it: a Jev call never reaches the router, so nothing else would show it.
    const run: JudgeRun = { at: started, for: worker ? 'worker' : 'prompt', asked: s.judge, by, ms, ...(verdict?.effort ? { effort: verdict.effort } : {}), ...(verdict?.sure !== undefined ? { sure: verdict.sure } : {}), ...(failure ? { error: failure } : {}) }
    await update($, judgeRuns, value => [...value, run].slice(-40))
    // A network blip or timeout is said only when it happens twice running; Haiku covers the one prompt.
    jevBlips = blip ? jevBlips + 1 : 0
    if (failure && !(blip && jevBlips < 2)) await down($, failure, blip)
    else if (await read($, judgeDown)) await update($, judgeDown, () => null)
  }
  return { verdict, by, ms, ...(failure ? { error: failure } : {}) }
}
async function testJudge($: EngineInterface): Promise<void> {
  const language = await read($, lang)
  await update($, jev, value => ({ ...value, test: { state: 'testing' as const } }))
  try {
    const s = normalizeSettings(await read($, settingsDraft) ?? await read($, settings))
    const judged = await judge($, s, { messages: [], next: 'Rename a local variable in one function and verify the result.' }, false, true)
    const ok = !!judged.verdict && !judged.error
    await update($, jev, value => ({ ...value, test: { state: ok ? 'ok' as const : 'fail' as const, message: `${judged.ms} ms · ${judged.verdict?.effort ? t(language, 'band.' + judged.verdict.effort).toLowerCase() : t(language, 'toasts.noVerdict')} · ${judged.error ?? judged.by}` } }))
  } catch (error) {
    await update($, jev, value => ({ ...value, test: { state: 'fail' as const, message: reason(error) } }))
  }
}

async function requestPick($: EngineInterface, e: AgentSpawnInput, s: Settings): Promise<{ input: AgentSpawnInput; pick: WorkerPick } | { deny: string }> {
  const language = await read($, lang)
  const files = await workerFiles($)
  try { await refreshModels($) } catch (error) { await report($, 'worker catalogue', error) }
  // Claude's own models are candidates as well: general-purpose on the model, effort by turn.step.
  const pinnedCandidates = [...[...files].flatMap(([agent, file]) => { const model = agentModel(file)?.replace(/@[^@]*$/, ''); const provider = agentProvider(file); return model && provider ? [{ target: { agent }, model, provider }] : [] }), ...claudeCandidates()]
  const usable = await availability($)
  const marker = readMarker(e.prompt)
  const explicit = marker && !['auto', 'ripple'].includes(marker.name) ? marker : null
  let verdict: WorkerVerdict = { domain: 'general', level: 'standard', effort: 'high', why: t(language, 'toasts.judgeUnavailable') }
  let by: WorkerPick['by'] = 'default'
  let ms = 0
  let rawVerdict: WorkerVerdict | null = null
  let judgeError: string | undefined
  let target: TierTarget | undefined
  if (explicit) {
    // Agent names and their file-model ids are both valid explicit routing notes.
    const name = files.has(explicit.name) ? explicit.name : [...files].find(([, f]) => agentModel(f)?.replace(/@[^@]*$/, '').toLowerCase() === explicit.name)?.[0]
    target = name ? { agent: name } : { agent: 'general-purpose', model: explicit.name }
    verdict = { domain: 'general', level: 'standard', effort: effortOf(explicit.level) ?? 'high', why: t(language, 'toasts.explicitMarker') }
    by = 'marker'
  } else {
    const judged = await judge($, s, { description: e.description, prompt: e.prompt }, true)
    if (judged.verdict && 'domain' in judged.verdict) { rawVerdict = judged.verdict; verdict = judged.verdict; by = judged.by }
    ms = judged.ms
    judgeError = judged.error
  }
  // Availability is request-time state, not the ten-minute panel catalogue. Refresh after the
  // judge (which may itself take a while), before every pick, even when no mode is active.
  await refreshLadder($)
  const now = await $.clock.now()
  const options = await read($, ladderOptions)
  const providers = options && options.until > now ? Object.fromEntries(Object.entries(options.providers ?? {}).filter(([, p]) => p.exhaustedUntil === undefined || p.exhaustedUntil > now)) : {}
  const explicitCandidate = target ? pinnedCandidates.find(c => c.target.agent === target!.agent) ?? (target.agent === 'general-purpose' ? { target, model: target.model ?? 'sonnet', provider: (await read($, routerModels)).find(m => m.value.toLowerCase() === target!.model)?.provider ?? 'anthropic' } : undefined) : undefined
  if (explicitCandidate && s.providers[explicitCandidate.provider] === false) return { deny: t(language, 'workers.disabled', { provider: explicitCandidate.provider }) }
  // An active mode moves the tiers; an explicit marker still names its own model.
  const mode = activeModeOf(s)
  const routing = routingSettings(s)
  const resolved = explicitCandidate && candidateUsable(explicitCandidate, s, usable, providers)
    ? { target: target!, effort: verdict.effort }
    : ladderPick(verdict, routing.rules.general, routing, pinnedCandidates, usable, language, routing.allow, providers, routing.allowKnown)
  const selected = resolved.target
  if (!selected) return { deny: t(language, 'workers.none') }
  const fallbackReason = resolved.fallbackReason
  verdict = { ...verdict, effort: resolved.effort }
  const model = spawnModel(selected, verdict.effort, files.has(selected.agent) ? agentModel(files.get(selected.agent)!) : undefined)
  let prompt = e.prompt
  if (marker) prompt = prompt.replace(MARKER, '').replace(/^\s*\n/, '')
  const value: WorkerPick = { ...verdict, ...resolved, target: selected, by, ms, ...(fallbackReason ? { fallbackReason } : {}) }
  // The verdict behind a pick is otherwise only in the agents panel; one debug line per pick keeps
  // it checkable: what the judge said, the rung it landed on and what ran.
  const entry = { task: e.description.slice(0, 200), domain: value.domain, level: value.level, kind: value.kind ?? 'do', sure: value.sure, rung: value.rung, position: value.position, skipped: value.skipped, target: value.target, model: model ?? null, effort: value.effort, by, ...(mode ? { mode: mode.name } : {}), ...(fallbackReason ? { fallbackReason } : {}) }
  await $.ui.log('ClaudeRipple worker pick: ' + JSON.stringify(entry), { to: 'debug' })
  await persistWorkerPick($, { ...entry, at: new Date(now).toISOString(), verdict: rawVerdict, by: by === 'marker' || by === 'default' ? by : 'judge', judge: by === 'marker' || by === 'default' ? null : by, ms, ...(judgeError ? { error: judgeError } : {}) })
  if (fallbackReason) await $.ui.toast(t(language, 'toasts.workerFallback', { reason: fallbackReason, name: targetLabel(selected, language) }))
  await update($, lastSpawn, () => value)
  await update($, stats, current => addWorker(current, verdict.level))
  return { input: { ...e, subagentType: selected.agent, model, prompt }, pick: value }
}

async function toggleAuto($: EngineInterface): Promise<void> {
  const s = await currentSettings($)
  await saveSettings($, { ...s, effortAuto: !s.effortAuto })
}
/** The band's flame turns keep-warm on or off for this chat only; Settings is what a new chat starts with. */
async function keepWarmOn($: EngineInterface, s: Settings): Promise<boolean> {
  return await read($, warmHere) ?? s.keepWarm
}
async function toggleWarm($: EngineInterface): Promise<void> {
  const s = await currentSettings($)
  const on = !await keepWarmOn($, s)
  await update($, warmHere, () => on === s.keepWarm ? null : on)
  if (on) await update($, warm, value => ({ ...value, stopped: undefined }))
}
// ---- GPT Fast (all sessions) -------------------------------------------------------------------
// One router-owned value (GET/PUT /api/fast) is shared by every bar and the dashboard. A change
// applies to the next request in every session; nothing already in flight is touched.
let fastWriting = false
let fastPolling = false
let fastEpoch = 0
function fastReply(text: string): { fast: boolean | null; revision: number } {
  const body = object(JSON.parse(text))
  const fast = body.fast
  const revision = body.revision
  if (body.scope !== 'global' || (fast !== null && typeof fast !== 'boolean') || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) throw new Error('invalid global fast snapshot')
  return { fast, revision }
}
/** Takes a validated snapshot unless the one held is newer. Old per-session atoms are not global acknowledgements. */
async function acceptFast($: EngineInterface, reply: { fast: boolean | null; revision: number }, epoch = fastEpoch): Promise<void> {
  const apply = (held: GptFast): GptFast => {
    if (epoch !== fastEpoch || (held.scope === 'global' && reply.revision < held.revision)) return held
    const next: GptFast = { status: 'ready', scope: 'global', value: reply.fast, revision: reply.revision, writing: held.writing }
    return same(held, next) ? held : next
  }
  const held = await read($, gptFast)
  // update retries on an atom-version conflict; recheck the revision inside that retry too.
  if (apply(held) !== held) await update($, gptFast, apply)
}
/** The router could not say (down, too old, or an answer that does not validate): nothing is assumed. */
async function fastDown($: EngineInterface, epoch = fastEpoch): Promise<void> {
  const held = await read($, gptFast)
  if (epoch !== fastEpoch || held.status === 'unavailable') return
  // A read failure may have waited behind a successful write, including during an atom retry.
  await update($, gptFast, value => epoch === fastEpoch ? { ...value, status: 'unavailable' } : value)
}
async function refreshFast($: EngineInterface): Promise<void> {
  if (fastPolling || fastWriting) return
  fastPolling = true
  const epoch = fastEpoch
  try {
    const response = await $.http.fetch(`${await adminUrl($)}/api/fast`)
    if (!response.ok) throw new Error(t(await read($, lang), 'commands.routerHttp', { status: response.status }))
    if (epoch === fastEpoch) await acceptFast($, fastReply(response.text), epoch)
  } catch (error) {
    if (epoch === fastEpoch) { await fastDown($, epoch); await report($, 'global fast poll', error) }
  } finally { fastPolling = false }
}
/** Sets GPT Fast globally; the shown value changes only on the router's own answer. */
async function writeFast($: EngineInterface, target: boolean | null): Promise<{ ok: true } | { ok: false; reason: string; busy?: true }> {
  const language = await read($, lang)
  if (fastWriting) return { ok: false, reason: t(language, 'fast.saving'), busy: true }
  fastWriting = true
  ++fastEpoch
  try {
    await update($, gptFast, value => ({ ...value, writing: true }))
    const response = await $.http.fetch(`${await adminUrl($)}/api/fast`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fast: target }) })
    if (!response.ok) throw new Error(t(language, 'commands.routerHttp', { status: response.status }))
    const reply = fastReply(response.text)
    if (reply.fast !== target) throw new Error('router answered another value')
    const held = await read($, gptFast)
    if (held.scope === 'global' && reply.revision < held.revision) throw new Error('router answered an older revision')
    await acceptFast($, reply)
    return { ok: true }
  } catch (error) {
    // The router may have saved the value before the acknowledgement was lost. A later GET
    // reconciles it; do not keep presenting the previous value as confirmed or retry the PUT.
    await fastDown($)
    await report($, 'global fast write', error)
    return { ok: false, reason: reason(error) }
  } finally {
    fastWriting = false
    await update($, gptFast, value => ({ ...value, writing: false }))
  }
}
/** The band's lightning changes the shared value: Auto/OFF -> ON, ON -> OFF. */
async function toggleFast($: EngineInterface): Promise<void> {
  const language = await read($, lang)
  if (fastWriting) return
  const held = await read($, gptFast)
  if (fastState(held) === 'unavailable') {
    await refreshFast($)
    if (fastState(await read($, gptFast)) === 'unavailable') await $.ui.toast(t(language, 'toasts.fastUnavailable'))
    return
  }
  const done = await writeFast($, held.value !== true)
  if (!done.ok && !done.busy) await $.ui.toast(t(language, 'toasts.fastFailed', { reason: done.reason }))
}
function fastState(held: GptFast): FastState {
  if (held.status !== 'ready' || held.scope !== 'global') return 'unavailable'
  return held.value === null ? 'auto' : held.value ? 'on' : 'off'
}
async function toggleSave($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const active = (await read($, saveUntil) ?? 0) > now
  const until = active ? null : limitSaveUntil(await read($, hot), now)
  await update($, saveUntil, () => until)
}
async function manualPick($: EngineInterface, effort: Effort): Promise<void> {
  const language = await read($, lang)
  await saveSettings($, { ...await currentSettings($), effortAuto: false })
  await installPick($, { effort, by: 'manual', why: t(language, 'toasts.yourPick'), at: await $.clock.now() })
  const draft = await $.prompt.read()
  if (!draft.text.trim() || /^\/effort\s+\w+\s*$/.test(draft.text)) {
    await $.prompt.fill({ text: `/effort ${effort}`, mode: 'replace' })
    await $.ui.toast(t(language, 'toasts.effortEnter'))
  }
}
// Only first-run setup has a draft; quick settings read the saved state directly.
async function startPanel($: EngineInterface, which: 'settings' | 'setup'): Promise<void> {
  try { await settingsTask(async () => { await syncSettings($, await adminUrl($)) }) }
  catch (error) { await report($, 'panel settings', error) }
  const s = await currentSettings($)
  await update($, settingsDraft, () => which === 'setup' ? normalizeSettings(s) : null)
  await update($, settingsBase, () => which === 'setup' ? normalizeSettings(s) : null)
  if (which === 'setup') await update($, setupStep, () => 1)
  await update($, panel, () => which)
  await jevKey($)
  if (which === 'settings') await refreshLadder($)
}
/**
 * An open panel's draft follows changes saved elsewhere (another session, the web page): the
 * person's own edits (draft against base) are replayed on the settings now held, and the base
 * moves to them. Without a base (a draft from an older mod) the draft starts over from them.
 */
async function rebaseDraft($: EngineInterface): Promise<void> {
  if (await read($, panel) !== 'setup') return
  const draft = await read($, settingsDraft)
  if (!draft) return
  const fresh = await currentSettings($)
  const base = await read($, settingsBase)
  const next = base ? applySettingsChanges(fresh, settingsChanges(normalizeSettings(base), normalizeSettings(draft))) : normalizeSettings(fresh)
  if (base && JSON.stringify(normalizeSettings(base)) === JSON.stringify(fresh)) return
  await update($, settingsBase, () => normalizeSettings(fresh))
  if (JSON.stringify(next) !== JSON.stringify(normalizeSettings(draft))) await update($, settingsDraft, () => next)
}
async function patchDraft($: EngineInterface, change: Partial<Settings>): Promise<void> {
  const current = normalizeSettings(await read($, settingsDraft) ?? await read($, settings))
  await update($, settingsDraft, () => normalizeSettings({ ...current, ...change }))
  if (change.jevSource) { await update($, jev, value => ({ ...value, test: { state: 'idle' as const } })); await jevKey($, change.jevSource) }
}
async function finishSetup($: EngineInterface, skip = false): Promise<void> {
  // A field whose rule picks as the main choice does is stored as no exception.
  const draft = normalizeSettings(skip ? await read($, settings) : await read($, settingsDraft))
  const saved = await saveSettings($, { ...draft, setupDone: true }, skip ? undefined : normalizeSettings(await read($, settingsBase) ?? await currentSettings($)))
  await update($, panel, () => null)
  await update($, settingsDraft, () => null)
  await update($, settingsBase, () => null)
  await $.ui.toast(t(await read($, lang), saved ? 'toasts.settingsSaved' : 'band.routerDown'))
}
async function openHandoff($: EngineInterface): Promise<void> {
  const active = await read($, handoff)
  if (active && ['writing', 'clearing'].includes(active.stage)) return
  const choice = object(await $.store.get('handoffChoice'))
  await update($, handoffChoiceKind, () => choice.kind === 'full' ? 'full' : 'quick')
  const after = ['continue', 'confirm', 'copy'].includes(String(choice.after)) ? choice.after as Settings['handoffAfter'] : (await currentSettings($)).handoffAfter
  await update($, handoffChoiceAfter, () => after)
  await update($, panel, value => value === 'handoff' ? null : 'handoff')
}
async function queueHandoff($: EngineInterface, kind?: 'quick' | 'full'): Promise<void> {
  const active = await read($, handoff)
  if (active && ['writing', 'clearing'].includes(active.stage)) return
  const selected = kind ?? await read($, handoffChoiceKind)
  const after = kind ? (await currentSettings($)).handoffAfter : await read($, handoffChoiceAfter)
  await update($, handoffChoiceKind, () => selected)
  await update($, handoffChoiceAfter, () => after)
  await $.store.set('handoffChoice', { kind: selected, after })
  await update($, handoff, () => ({ stage: 'writing', kind: selected }))
  await update($, panel, () => null)
  await update($, advice, () => null)
  await update($, handoffQueued, () => true)
}
async function copyHandoff($: EngineInterface): Promise<void> {
  const language = await read($, lang)
  const value = await read($, handoff)
  if (!value?.text) return
  const text = wrapForNewChat(value.text, 'continue', value.kind, !!(await currentSettings($)).handoffSkill)
  try {
    const copied = await $.ui.copy({ text })
    if (!copied.isCopied) throw new Error(copied.reason)
  } catch (error) {
    await $.prompt.fill({ text, mode: 'replace' })
    await $.ui.toast(t(language, 'toasts.clipboardFallback'))
    await report($, 'copy fallback', error)
  }
  await update($, handoff, () => ({ ...value, stage: 'copied' }))
}
/**
 * The summary is written: Copy only copies it; Confirm first stops on a card that asks before
 * moving; Continue moves to a new session at once. This chat is never cleared (2026-10-13: the
 * owner read "Confirm first" as asking before the clear, and lost the chat to it).
 */
async function finishHandoff($: EngineInterface): Promise<void> {
  const value = await read($, handoff)
  if (!value?.text || value.stage !== 'writing') return
  const after = await read($, handoffChoiceAfter)
  if (after === 'copy') { await copyHandoff($); return }
  if (after === 'confirm') { await update($, handoff, () => ({ ...value, stage: 'ready' })); return }
  await moveToNewSession($)
}
/** A summary longer than this goes to a file the new session reads; the app takes ~14k characters in a link. */
const LINK_TEXT = 12_000
/**
 * Opens a new Code session in this session's folder with the handoff in its prompt box
 * (claude://code/new?folder=…&q=…, the desktop app's own link: it fills the box and waits for
 * Enter, never sends by itself). A long summary is saved under ~/.clauderipple/handoffs and the box
 * says to read it. Where no link can be opened, the text is copied instead.
 */
async function moveToNewSession($: EngineInterface): Promise<void> {
  const value = await read($, handoff)
  if (!value?.text) return
  const language = await read($, lang)
  let text = wrapForNewChat(value.text, 'continue', value.kind, !!(await currentSettings($)).handoffSkill)
  try {
    if (text.length > LINK_TEXT) {
      const path = `${await rippleHome($)}/handoffs/handoff-${await $.clock.now()}.md`
      await $.fs.write(path, text + '\n')
      text = t(language, 'alerts.readHandoffFile', { path })
    }
    const folder = await $.session.cwd()
    const url = 'claude://code/new?' + new URLSearchParams({ ...(folder ? { folder } : {}), q: text, source: 'services' }).toString()
    await openUrl($, url)
    await update($, handoff, () => ({ ...value, stage: 'opened' }))
  } catch (error) {
    await report($, 'open new session', error)
    await copyHandoff($)
    await $.ui.toast(t(language, 'toasts.newSessionFallback'))
  }
}
async function fork($: EngineInterface, prompt: string): Promise<ModelForkResult | null> {
  const epoch = generation
  forking = true
  forkUsage = null
  try {
    const answer = await $.model.fork({ prompt })
    // Real forks dispatch turn.step; test stubs and older engines can provide only the result.
    const usage = answer && 'usage' in answer ? answer.usage : forkUsage
    if (usage && epoch === generation) {
      await update($, stats, value => addWarm(value, usage))
      if ((usage.cache_read_input_tokens ?? 0) > 0) {
        const memo = nextMemo(await read($, cache), usage, await $.clock.now())
        await update($, cache, () => memo)
      }
    }
    return answer
  } finally { forking = false; forkUsage = null }
}
async function driveHandoff($: EngineInterface): Promise<void> {
  const language = await read($, lang)
  const value = await read($, handoff)
  if (!value || value.stage !== 'writing' || await read($, busy)) return
  if (!value.text && !await read($, handoffQueued)) return
  try {
    if (value.text) { await finishHandoff($); return }
    await update($, handoffQueued, () => false)
    if (value.kind === 'quick') {
      let answer: ModelForkResult | null = null
      try { answer = await fork($, QUICK_PROMPT) }
      catch (error) { await report($, 'quick fork fallback', error) }
      if (answer?.isAnswered && answer.text.trim()) {
        await update($, handoff, () => ({ ...value, text: answer.text }))
        await finishHandoff($)
        return
      }
    }
    await update($, handoffWaiting, () => true)
    const s = await currentSettings($)
    if (value.kind === 'full' && s.handoffSkill) {
      const [command, ...args] = s.handoffSkill.split(/\s+/)
      await $.command.run({ command: command!, args: args.join(' ') })
    } else await $.prompt.submit({ text: value.kind === 'full' ? FULL_PROMPT : QUICK_PROMPT })
  } catch (error) {
    await update($, handoff, () => ({ ...value, stage: 'failed' }))
    await update($, handoffWaiting, () => false)
    await $.ui.toast(t(language, 'toasts.handoffFailed'))
    await report($, 'handoff', error)
  }
}
async function runCompact($: EngineInterface, note = ''): Promise<void> {
  const language = await read($, lang)
  await update($, panel, () => null)
  await update($, advice, () => null)
  await update($, resultCard, () => ({ stage: 'compacting' }))
  try {
    await $.command.run({ command: 'compact', args: note })
    await update($, resultCard, () => ({ stage: 'compacted' }))
  } catch (error) {
    await update($, resultCard, () => ({ stage: 'failed' as const, detail: t(language, 'alerts.compactFailed') }))
    await $.ui.toast(t(language, 'toasts.compactFailed'))
    await report($, 'compact command', error)
  }
}
async function openCompact($: EngineInterface, surface: Frame['surface']): Promise<void> {
  if (surface === 'terminal') { await runCompact($); return }
  await update($, compactNote, () => '')
  await update($, panel, () => 'compact')
}
async function openClear($: EngineInterface): Promise<void> {
  await update($, panel, () => 'clear')
}
/** The router's figure for this login's plan windows; nothing when the router cannot say. */
async function routerClaudeLimits($: EngineInterface): Promise<SessionRateLimit[]> {
  try {
    const status = await $.http.fetch(`${await adminUrl($)}/api/status`)
    return status.ok ? claudeLimitsFrom(JSON.parse(status.text), await $.clock.now()) : []
  } catch (error) { await report($, 'claude limits', error); return [] }
}
async function refreshUsage($: EngineInterface): Promise<void> {
  const usage = await $.session.usage()
  const c = usage.context
  const percent = c.percent ?? (c.tokens !== undefined && c.window > 0 ? c.tokens / c.window * 100 : undefined)
  const ctx = c.tokens !== undefined && percent !== undefined ? { tokens: c.tokens, percent, window: c.window } : null
  if (JSON.stringify(ctx) !== JSON.stringify(await read($, context))) await update($, context, () => ctx)
  // Below the line again (a compact, a clear), the next crossing shows the heavy-context band once.
  const putOff = await read($, swampHidden)
  if (putOff !== null && (putOff > 100 || !ctx || ctx.percent < (await currentSettings($)).swampAt)) await update($, swampHidden, () => null)
  // The host can leave the plan windows out though the replies carried them; on a Claude chat the
  // router's figure for the same login stands in.
  const own = usage.rateLimits.some(l => ['five_hour', 'seven_day'].includes(l.kind))
  const rateLimits = own || !/^claude-/.test(await $.session.model()) ? usage.rateLimits : [...usage.rateLimits, ...await routerClaudeLimits($)]
  const h = hottest(rateLimits)
  const previous = await read($, hot)
  if (previous && (!h || previous.kind !== h.kind || previous.resetsAt !== h.resetsAt)) await update($, hotHidden, () => null)
  if (JSON.stringify(h) !== JSON.stringify(previous)) await update($, hot, () => h)
  const top = rateLimits.filter(l => ['five_hour', 'seven_day'].includes(l.kind)).sort((a, b) => b.percentUsed - a.percentUsed)[0]
  const l = top ? { kind: top.kind, percent: top.percentUsed, ...(top.resetsAt ? { resetsAt: top.resetsAt } : {}) } : null
  // Check the previous binding deadline before a rolled-forward snapshot replaces it.
  await endModeIfOver($)
  if (JSON.stringify(l) !== JSON.stringify(await read($, limit))) await update($, limit, () => l)
  await endModeIfOver($)
  const until = await read($, saveUntil)
  if (until !== null && until <= await $.clock.now()) await update($, saveUntil, () => null)
}
/**
 * Redraws when the countdown's shown minute changes and at expiry (the cold alert), at no other
 * time: the desktop draws each answer afresh (see ui/band.tsx), so a redraw that shows nothing new
 * is wasted at best. With the timer not on show, only the expiry. The 15-second tick re-aims it
 * after a reply moved the expiry.
 */
async function scheduleCountdown($: EngineInterface): Promise<void> {
  const memo = await read($, cache)
  const now = await $.clock.now()
  const shown = !(await currentSettings($)).hide.includes('timer') && !await read($, bandHidden)
  const at = !memo || memo.expiresAt <= now ? null : shown ? nextMinuteChange(memo.expiresAt, now) : memo.expiresAt
  if (countdownTimer?.at === at) return
  countdownTimer?.cancel()
  countdownTimer = null
  if (at === null) return
  const timer = $.clock.after(Math.max(1, at - now), () => {
    countdownTimer = null
    void (async () => {
      await $.ui.invalidate('ui.render')
      await scheduleCountdown($)
    })().catch(error => report($, 'countdown', error))
  })
  countdownTimer = { at, cancel: () => timer.cancel() }
}
async function tick($: EngineInterface): Promise<void> {
  const language = await read($, lang)
  if (ticking) return
  ticking = true
  try {
    await refreshUsage($)
    const now = await $.clock.now()
    const list = await read($, agents)
    if (list.some(a => a.state === 'running' && a.toolSince !== undefined && now - a.toolSince >= 8000)) {
      await update($, agents, value => value.map(a => a.state === 'running' && a.toolSince !== undefined && now - a.toolSince >= 8000 ? { ...a, state: 'waiting' } : a))
    }
    await scheduleCountdown($)
    if (await read($, handoff)) await driveHandoff($)
    const queued = await read($, adviceQueue)
    if (queued && !await read($, busy)) {
      await update($, adviceQueue, () => null)
      const answer = await $.model.complete({ model: HAIKU, system: ADVICE_SYSTEM, prompt: queued, effort: 'low', maxTokens: 60, timeoutMs: 8000 })
      if (answer.isAnswered) await update($, advice, () => parseAdvice(answer.text))
    }
    const s = { ...await currentSettings($) }
    s.keepWarm = await keepWarmOn($, s)
    const decision = shouldPing({ settings: s, memo: await read($, cache), warm: await read($, warm), now: await $.clock.now(), idle: !await read($, busy) && !await read($, deciding) && !forking,
      contextTokens: (await read($, context))?.tokens ?? 0, lastRealReplyAt: await read($, lastRealReplyAt) })
    if (decision.ping) {
      let answer: ModelForkResult | null = null
      try { answer = await fork($, 'Reply with just: ok') }
      catch (error) { await report($, 'warm fork', error) }
      const before = await read($, warm)
      const after = afterPing(before, answer, await $.clock.now(), language)
      await update($, warm, () => after)
      if (after.stopped && !before.stopped) await $.ui.toast(t(language, 'toasts.warmStopped', { reason: after.stopped }))
      // A ping read cache tokens: the cache held while the person was away. One card counts them all
      // (a real reply or the expiry clears it; register.tsx kept), until then each ping adds up.
      const usage = answer && 'usage' in answer ? answer.usage : null
      if ((usage?.cache_read_input_tokens ?? 0) > 0) {
        await update($, kept, prev => ({
          pings: (prev?.pings ?? 0) + 1,
          tokens: usage!.cache_read_input_tokens,
        }))
      }
    } else if (s.keepWarm && !await read($, busy) && decision.reason === 'keep warm time bound reached' && !(await read($, warm)).stopped) {
      await update($, warm, value => ({ ...value, stopped: t(language, 'toasts.warmBoundReason') }))
      await $.ui.toast(t(language, 'toasts.warmBound'))
    }
  } catch (error) { await report($, 'session tick', error) }
  finally { ticking = false }
}
function startTimers($: EngineInterface): void {
  if (timersStarted) return
  timersStarted = true
  $.clock.after(1, async () => { await refreshRouter($); await refreshFast($); await tick($) })
  $.clock.every(3000, async () => { await refreshRouter($); await refreshFast($) })
  $.clock.every(15000, async () => { await tick($) })
}

async function dashboard($: EngineInterface, working: boolean): Promise<DashboardView> {
  const s = await currentSettings($)
  const p = await read($, pick)
  const list = await read($, agents)
  const record = await read($, last)
  const saving = (await read($, saveUntil) ?? 0) > await $.clock.now()
  const l = await read($, limit)
  const w = await read($, warm)
  return {
    effort: { level: p?.effort ?? effortOf(await read($, appEffort)) ?? null,
      mode: await read($, deciding) ? 'deciding' : await read($, paused) ? 'paused' : p?.by === 'manual' ? 'manual' : s.effortAuto ? 'auto' : 'off',
      ...(p?.why ? { why: p.why, by: p.by } : {}), ...(await read($, decidingSince) !== null ? { since: (await read($, decidingSince))! } : {}) },
    model: await read($, modelIs) ? modelName((await read($, modelIs))!) : null,
    context: await read($, context), cache: await read($, cache), warm: { ...w, on: await keepWarmOn($, s), ...(await read($, warmHere) !== null ? { here: true } : {}) },
    limit: l ? { ...l, save: saving } : null, route: record ? routeOf(record) : null, notice: await read($, line),
    auto: s.effortAuto, handoff: await read($, advice) ? 'advised' : s.handoffButton === 'always' ? 'always' : 'off',
    agents: { live: list.filter(a => ['running', 'waiting'].includes(a.state)).length, total: list.length },
    logOpen: await read($, logOpen), agentsOpen: await read($, agentsOpen), effortMenu: await read($, effortMenuOpen),
    swampAt: s.swampAt, hide: s.hide, extras: s.extras, isWorking: working,
    fast: { state: fastState(await read($, gptFast)), busy: (await read($, gptFast)).writing },
    ...(activeModeOf(s) ? { mode: activeModeOf(s)!.name } : {}),
  }
}
async function settingsView($: EngineInterface): Promise<SettingsView> {
  return { settings: await currentSettings($), jev: await read($, jev), ladder: await read($, ladderOptions) }
}
async function frameOf($: EngineInterface, e: RenderInput): Promise<Frame> {
  const s = await currentSettings($)
  const columns = 'bodyColumns' in e.props ? e.props.bodyColumns : e.viewport?.columns ?? 100
  const maxRows = 'maxRows' in e.props ? e.props.maxRows : 'scroll' in e.props ? e.props.scroll.bodyRows : 1
  return { surface: e.surface, columns, maxRows, now: await $.clock.now(), appearance: s.appearance, lang: await read($, lang) }
}
async function alertView($: EngineInterface, now: number): Promise<AlertView | null> {
  const language = await read($, lang)
  const s = await currentSettings($)
  const c = await read($, context)
  const m = await read($, cache)
  const h = await read($, hot)
  const writing = await read($, handoff)
  const result = await read($, resultCard)
  const downReason = await read($, judgeDown)
  const d = await read($, demo)
  const which = bandPriority({ panel: await read($, panel), judgeDown: d === 'down' || (!!downReason && downReason !== await read($, judgeDownHidden)),
    hot: d === 'hot' || hotAlert(h, await read($, hotHidden)), result: !!writing || !!result,
    cold: d === 'cold' || coldAlert(m, c?.tokens ?? 0, now, await read($, coldHidden)),
    kept: d === 'kept' || keptAlert(await read($, kept), m, now),
    swamp: d === 'swamp' || (s.swampAlert && !await read($, busy) && swampAlert(swamped(c, s.swampAt), await read($, swampHidden))) })
  if (which === 'compact') return { kind: 'compactNote', draft: await read($, compactNote) }
  if (which === 'clear') return { kind: 'clear' }
  if (which === 'handoff') return { kind: 'handoffChoice', handoffKind: await read($, handoffChoiceKind), after: await read($, handoffChoiceAfter) }
  if (which === 'judgeDown') return { kind: 'judgeDown', judge: s.judge, reason: d === 'down' ? t(language, 'alerts.demoDown') : downReason!, network: d !== 'down' && await read($, judgeDownNetwork) }
  if (which === 'hot') return { kind: 'hot', limitKind: h?.kind ?? 'five_hour', percent: d === 'hot' ? 86 : h!.percent, resetsAt: h?.resetsAt, save: (await read($, saveUntil) ?? 0) > now }
  if (which === 'result') {
    if (!writing) return { kind: 'result', ...result! }
    const stage = ['writing', 'clearing'].includes(writing.stage) ? 'handingOff' : writing.stage === 'failed' ? 'failed' : writing.stage === 'ready' ? 'handoffReady' : 'handoffDone'
    const detail = writing.stage === 'copied' ? t(language, 'alerts.copied') : writing.stage === 'opened' ? t(language, 'alerts.openedBody') : undefined
    return { kind: 'result', stage, handoffKind: writing.kind, ...(detail ? { detail } : {}) }
  }
  if (which === 'cold') return { kind: 'cold', tokens: d === 'cold' ? 180000 : c!.tokens, idleMinutes: m ? Math.round((now - m.lastReplyAt) / 60000) : 61 }
  if (which === 'kept') {
    const k = d === 'kept' ? { pings: 2, tokens: 312000 } : (await read($, kept)) ?? { pings: 0, tokens: 0 }
    return { kind: 'kept', pings: k.pings, tokens: k.tokens, minutesLeft: Math.ceil(((d === 'kept' ? now + 47 * 60000 : m!.expiresAt) - now) / 60000) }
  }
  if (which === 'swamp') return { kind: 'swamp', percent: d === 'swamp' ? 65 : c!.percent, tokens: d === 'swamp' ? 160000 : c!.tokens }
  return null
}
/**
 * A prompt sent while the cold, kept, heavy or hot band shows counts as having seen it: it comes
 * back only on its own next occasion (the next expiry, one more ping, 15 more points of context,
 * 10 more of the plan window), never after every message.
 */
async function markSeen($: EngineInterface): Promise<void> {
  const view = await alertView($, await $.clock.now())
  if (view && (view.kind === 'cold' || view.kind === 'kept' || view.kind === 'swamp' || view.kind === 'hot')) await dismiss($, view)
}
async function dismiss($: EngineInterface, view: AlertView): Promise<void> {
  await update($, demo, () => null)
  if (view.kind === 'hot') await update($, hotHidden, () => view.percent)
  else if (view.kind === 'cold') await update($, coldHidden, () => true)
  else if (view.kind === 'kept') await update($, kept, () => null)
  else if (view.kind === 'swamp') await update($, swampHidden, () => view.percent)
  else if (view.kind === 'judgeDown') await update($, judgeDownHidden, () => view.reason)
  else if (view.kind === 'result') { await update($, resultCard, () => null); await update($, handoff, () => null) }
  else await update($, panel, () => null)
}
function bandActions($: EngineInterface, surface: Frame['surface']): BandActions {
  return { toggleAuto: () => toggleAuto($), toggleWarm: () => toggleWarm($), compact: () => openCompact($, surface), clear: () => openClear($), handoff: () => openHandoff($), toggleLog: () => toggleLog($), toggleAgents: () => toggleAgents($), openSettings: () => startPanel($, 'settings'),
    toggleEffortMenu: () => update($, effortMenuOpen, value => !value), pickEffort: effort => manualPick($, effort), toggleFast: () => toggleFast($) }
}
function settingsActions($: EngineInterface): SettingsActions {
  return { patch: async change => {
      const s = await currentSettings($)
      const saved = await saveSettings($, { ...s, ...change }, s)
      if (change.judge || change.jevSource) await jevKey($)
      if (!saved) await $.ui.toast(t(await read($, lang), 'band.routerDown'))
    },
    jevKey: async key => { try { await saveJevKey($, key) } catch (error) { await $.ui.toast(t(await read($, lang), 'toasts.error', { reason: reason(error) })) } }, testJev: () => testJudge($),
    setMode: id => setMode($, id),
    openAllSettings: () => openAllSettings($), close: async () => { await update($, panel, () => null); await update($, settingsDraft, () => null); await update($, settingsBase, () => null) } }
}
function setupActions($: EngineInterface): SetupActions {
  const a = settingsActions($)
  return { patch: change => patchDraft($, change), jevKey: a.jevKey, testJev: a.testJev, openAllSettings: a.openAllSettings,
    back: () => update($, setupStep, step => Math.max(1, step - 1) as 1 | 2 | 3 | 4), next: () => update($, setupStep, step => Math.min(4, step + 1) as 1 | 2 | 3 | 4), finish: () => finishSetup($), skip: () => finishSetup($, true) }
}
function alertActions($: EngineInterface, view: AlertView): AlertActions {
  return { compact: note => runCompact($, note), clear: async () => { await update($, panel, () => null); await $.command.run({ command: 'clear', args: '' }) }, handoff: () => openHandoff($), dismiss: () => dismiss($, view), toggleSave: () => toggleSave($), openSettings: () => startPanel($, 'settings'),
    noteInput: text => update($, compactNote, () => text), setHandoffKind: kind => update($, handoffChoiceKind, () => kind), setHandoffAfter: after => update($, handoffChoiceAfter, () => after), go: () => queueHandoff($), copy: () => copyHandoff($), openNew: () => moveToNewSession($) }
}
function toolLine(e: ToolCallInput): string {
  const fields = object(e)
  const detail = fields.command ?? fields.file_path ?? fields.pattern ?? fields.query ?? fields.url ?? fields.description ?? ''
  return `${e.tool} ${String(detail).split('\n')[0]}`.trim().slice(0, 70)
}
async function prepareStep($: EngineInterface, e: TurnStepInput): Promise<TurnStepInput> {
  const language = await read($, lang)
  if (e.agentId) {
    const a = (await read($, agents)).find(a => a.id === e.agentId)
    return a?.pick && a.pick.target.agent === 'general-purpose' ? { ...e, effort: a.pick.effort } : e
  }
  const previousModel = await read($, modelIs)
  const oldEffort = await read($, appEffort)
  const changedModel = previousModel !== e.model
  if (changedModel) {
    await update($, modelIs, () => e.model)
    await update($, appEffort, () => e.effort ?? null)
    if (previousModel !== null) {
      await update($, cache, () => null)
      await update($, lastRealReplyAt, () => null)
      if (await read($, kept)) await update($, kept, () => null)
    }
  }
  const safe = isCacheSafeModel(e.model)
  if (await read($, paused) !== !safe) await update($, paused, () => !safe)
  let s = await currentSettings($)
  if ((changedModel || oldEffort === null) && carriedPick) {
    carriedPick = false
    const level = effortOf(e.effort)
    const carried = await read($, pick)
    if (!s.effortAuto && carried?.by === 'manual' && level && carried.effort !== level) {
      await installPick($, { effort: level, by: 'manual', why: t(language, 'toasts.appEffort'), at: await $.clock.now() })
    }
  }
  if (!changedModel && oldEffort !== null && e.effort !== undefined && oldEffort !== e.effort) {
    await update($, appEffort, () => e.effort ?? null)
    await saveSettings($, { ...s, effortAuto: false })
    const level = effortOf(e.effort)
    if (level) await installPick($, { effort: level, by: 'manual', why: t(language, 'toasts.appEffortChanged'), at: await $.clock.now() })
    await $.ui.toast(t(language, 'toasts.autoOff'))
    return e
  }
  if (!changedModel && oldEffort === null && e.effort !== undefined) await update($, appEffort, () => e.effort!)
  s = await currentSettings($)
  const p = await read($, pick)
  if (!await read($, busy)) await update($, busy, () => true)
  if (!safe || !p || (!s.effortAuto && p.by !== 'manual')) return e
  const saving = s.effortAuto && (await read($, saveUntil) ?? 0) > await $.clock.now()
  return { ...e, effort: saving && EFFORTS.indexOf(p.effort) > EFFORTS.indexOf('medium') ? 'medium' : p.effort }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    jevBlips = 0
    try {
      await loadSettings($)
      const language = await read($, lang)
      await $.ui.status(undefined)
      await $.command.register({ name: 'ripple', description: t(language, 'commands.description'), argumentHint: t(language, 'commands.argumentHint'), immediate: true })
      await $.command.register({ name: 'ripple-log', description: t(language, 'commands.logDescription'), immediate: true })
      await $.command.register({ name: 'ripple-bar', description: t(language, 'commands.barDescription'), immediate: true })
      await $.command.register({ name: 'ripple-fast', description: t(language, 'commands.fastDescription'), argumentHint: t(language, 'commands.fastArgumentHint'), immediate: true })
      // loadSettings skips the install when an earlier poll already took this revision, and that
      // poll may have run before the session bound: register here, where it is bound.
      await registerAuto($, await currentSettings($))
      startTimers($)
      // Setup keeps its draft across a reload; quick settings never keep one.
      const open = await read($, panel)
      if (open === 'setup') await rebaseDraft($)
      if (open === 'settings') { await update($, settingsDraft, () => null); await update($, settingsBase, () => null); await jevKey($) }
      if (!(await currentSettings($)).setupDone && !open) await startPanel($, 'setup')
    } catch (error) { await report($, 'session.start', error) }
    return result
  })
  on('classic.SessionStart', async ($, e, next) => {
    try {
      if (['clear', 'resume', 'fork'].includes(e.source)) {
        generation++
        judgeSequence++
        await loadSettings($)
        await update($, busy, () => false)
        await update($, appEffort, () => null)
        await update($, heldPick, () => null)
        await update($, deciding, () => false)
        if (e.source === 'clear') {
          await update($, cache, () => null)
          await update($, context, () => null)
          await update($, lastRealReplyAt, () => null)
          if (await read($, kept)) await update($, kept, () => null)
        }
        if (e.model) await update($, modelIs, () => e.model!)
        await update($, paused, () => e.model ? !isCacheSafeModel(e.model) : false)
      }
      if (['resume', 'fork'].includes(e.source)) {
        const memo = restoreFromResume(e.seconds_since_last_response, e.prompt_cache_likely_expired, (await read($, cache))?.ttlMs ?? 3600000, await $.clock.now())
        await update($, cache, () => memo)
        await update($, lastRealReplyAt, () => memo?.lastReplyAt ?? null)
      }
      startTimers($)
    } catch (error) { await report($, 'classic.SessionStart', error) }
    return next(e)
  })
  on('prompt.submit', async ($, e, next) => {
    const sequence = ++judgeSequence
    // The eager mode's note, beside this prompt only (modes.ts eagerNote).
    let note: string | undefined
    try {
      const s = await currentSettings($)
      const model = await $.session.model()
      if (await read($, paused) !== !isCacheSafeModel(model)) await update($, paused, () => !isCacheSafeModel(model))
      const messages = await $.session.messages()
      const current = await read($, pick)
      const assistant = messages.findLast(m => m.role === 'assistant')?.text.slice(-2000) ?? ''
      let hostCommand = false
      if (e.text.trim().startsWith('/')) {
        const name = e.text.trim().split(/\s+/)[0]!.slice(1)
        const command = (await $.command.list()).find(c => c.name === name)
        hostCommand = !command || command.source === 'builtin' || name.startsWith('ripple')
      }
      const human = ['composer', 'bridge', 'sdk'].includes(e.origin.kind)
      if (human && !hostCommand) {
        await markSeen($)
        await endModeIfOver($)
        const noted = await read($, modeNoted)
        const eager = eagerNote(await currentSettings($), noted)
        if (eager.noted !== noted) await update($, modeNoted, () => eager.noted)
        note = eager.note
      }
      if (human && !hostCommand && (e.text.trim() || e.attachments?.length) && (!isShortFollowUp(e.text) || !!e.attachments?.length)) {
        const count = await read($, promptCount) + 1
        await update($, promptCount, () => count)
        const c = await read($, context)
        if (c && adviceDue(count, c.percent)) {
          const warmCache = ((await read($, cache))?.expiresAt ?? 0) > await $.clock.now()
          await update($, adviceQueue, () => adviceInput({ messages, next: e.text, contextPercent: c.percent, warm: warmCache }))
        }
      }
      if (shouldJudge({ text: e.text, origin: e.origin.kind, auto: s.effortAuto, modelId: model, hostCommand, current, attachments: e.attachments, assistantTail: assistant })) {
        const now = await $.clock.now()
        await update($, decidingSince, () => now)
        await update($, deciding, () => true)
        const c = await read($, context)
        const input: JudgeInput = { messages, next: e.text, attachments: e.attachments, current: { model, effort: current?.effort ?? effortOf(await read($, appEffort)) ?? 'medium' }, contextPercent: c?.percent, midTurn: !!e.turnId }
        const judged = await judge($, s, input, false)
        if (sequence === judgeSequence && (await currentSettings($)).effortAuto && judged.verdict) {
          const final = finalEffort(judged.verdict, s, (await read($, saveUntil) ?? 0) > await $.clock.now(), await read($, lang))
          const value: Pick = { ...judged.verdict, ...final, by: judged.by, at: await $.clock.now() }
          if (e.turnId && current && EFFORTS.indexOf(value.effort) < EFFORTS.indexOf(current.effort)) await update($, heldPick, () => value)
          else { await update($, heldPick, () => null); await installPick($, value) }
          await update($, stats, old => addPrompt(old, value.effort))
        }
      } else if (human && !hostCommand && s.effortAuto && current && isCacheSafeModel(model)) {
        await update($, stats, old => addPrompt(old, current.effort))
      }
      if (!hostCommand && !await read($, busy)) await update($, busy, () => true)
    } catch (error) { await report($, 'prompt.submit', error) }
    finally { if (sequence === judgeSequence && await read($, deciding)) await update($, deciding, () => false) }
    return next(note ? { ...e, context: [...(e.context ?? []), note] } : e)
  })
  on('turn.step', async function* ($, e, next) {
    const ownFork = forking && !e.agentId
    const epoch = generation
    let request = e
    try {
      if (!ownFork) request = await prepareStep($, e)
      const sent = { model: request.model, appEffort: e.effort, sentEffort: request.effort }
      if (!e.agentId && !ownFork && !same(await read($, lastRequest), sent)) await update($, lastRequest, () => sent)
    } catch (error) { request = e; await report($, 'turn.step prepare', error) }
    const answer = yield* next(request)
    try {
      if (epoch !== generation) return answer
      if (ownFork) { if (answer.usage) forkUsage = answer.usage; return answer }
      if (e.agentId && answer.usage) {
        await update($, agents, list => list.map(a => a.id === e.agentId ? { ...a, cost: a.cost + weighted(answer.usage!) } : a))
      } else if (!e.agentId && answer.usage) {
        const now = await $.clock.now()
        if (answer.usage.model === await $.session.model()) {
          const memo = nextMemo(await read($, cache), answer.usage, now)
          await update($, cache, () => memo)
          if (await read($, coldHidden)) await update($, coldHidden, () => false)
          if (await read($, kept)) await update($, kept, () => null)
          await update($, lastRealReplyAt, () => now)
          if ((await read($, warm)).stopped !== undefined) await update($, warm, value => ({ ...value, stopped: undefined }))
        }
        const p = await read($, pick)
        if (p && (await currentSettings($)).effortAuto && isCacheSafeModel(request.model)) await update($, stats, value => addRequest(value, answer.usage!, effortOf(request.effort) ?? p.effort))
      }
    } catch (error) { await report($, 'turn.step record', error) }
    return answer
  })
  on('turn.complete', async ($, e, next) => {
    try {
      const language = await read($, lang)
      if (e.agentId) {
        const now = await $.clock.now()
        await update($, agents, list => list.map(a => a.id === e.agentId ? { ...a, state: e.reason === 'answer' ? 'done' : 'failed', endedAt: now, now: undefined, toolSince: undefined } : a))
      } else if (!forking) {
        if (await read($, busy)) await update($, busy, () => false)
        const held = await read($, heldPick)
        if (held && (await currentSettings($)).effortAuto) await installPick($, held)
        await update($, heldPick, () => null)
        const value = await read($, handoff)
        if (value?.stage === 'writing' && await read($, handoffWaiting)) {
          await update($, handoffWaiting, () => false)
          if (e.reason === 'answer' && e.answer.trim()) await update($, handoff, () => ({ ...value, text: e.answer }))
          else {
            await update($, handoff, () => ({ ...value, stage: 'failed' }))
            await $.ui.toast(t(language, 'toasts.handoffEmpty'))
          }
        }
      }
    } catch (error) { await report($, 'turn.complete', error) }
    return next(e)
  })
  on('agent.spawn', async ($, e, next) => {
    let input = e
    let chosen: WorkerPick | undefined
    try {
      // Only the main chat delegates. A worker that starts its own worker waits on it idle, and a
      // Claude worker's 5-minute cache lapses meanwhile: 324k tokens rewritten in one request after
      // an 8.5-minute wait on 2026-10-11. Forks, workflows and teammates are the engine's, not this.
      const workflow = 'workflow' in e && !!e.workflow
      const teammate = 'isTeammate' in e && !!e.isTeammate
      if (e.parentAgentId && !e.fork && !workflow && !teammate) return { deny: t(await read($, lang), 'workers.nested') }
      const s = await currentSettings($)
      if (!workflow && !teammate && takesOver(e, s)) {
        const routed = await requestPick($, e, s)
        if ('deny' in routed) return routed
        input = routed.input
        chosen = routed.pick
      } else if (!e.fork && !workflow) {
        const files = await workerFiles($)
        try { await refreshModels($) } catch (error) { await report($, 'explicit worker catalogue', error) }
        const file = files.get(e.subagentType)
        const provider = file ? agentProvider(file) : e.model && !/^(?:sonnet|opus|haiku|claude-)/.test(e.model) ? (await read($, routerModels)).find(m => m.value === e.model?.replace(/@[^@]*$/, ''))?.provider : 'anthropic'
        if (provider && s.providers[provider] === false) return { deny: t(await read($, lang), 'workers.disabled', { provider }) }
        const marker = readMarker(e.prompt)
        if (marker) {
          const markerFile = files.get(marker.name) ?? [...files.values()].find(f => agentModel(f)?.replace(/@[^@]*$/, '') === marker.name)
          const markerProvider = markerFile ? agentProvider(markerFile) : (await read($, routerModels)).find(m => m.value === marker.name)?.provider
          if (markerProvider && s.providers[markerProvider] === false) return { deny: t(await read($, lang), 'workers.disabled', { provider: markerProvider }) }
        }
        const fix = await workerFix($, e)
        if (fix) {
          if (fix.dropped) await $.ui.toast(t(await read($, lang), 'toasts.ownModel', { name: e.subagentType, model: fix.dropped }))
          input = { ...e, prompt: fix.prompt, model: fix.model }
        }
      }
    } catch (error) { input = e; await report($, 'agent.spawn prepare', error) }
    try {
      // The title names what really runs: the model set above, else the worker file's, else the parent's.
      if (!e.fork && input.description?.trim()) {
        const file = (await workerFiles($)).get(input.subagentType)
        const model = input.model ?? (file ? agentModel(file) : undefined) ?? e.parentModel
        const effort = chosen?.effort ?? /@([a-z]+)$/.exec(model)?.[1]
        input = { ...input, description: spawnTitle(input.description, model, effort, await read($, routerModels)) }
      }
    } catch (error) { await report($, 'agent.spawn title', error) }
    const result = await next(input)
    try {
      if (result.agentId) {
        const rec: AgentRec = { id: result.agentId, description: input.description, type: input.subagentType, model: result.model, ...(chosen ? { pick: chosen } : {}), state: 'running', startedAt: await $.clock.now(), cost: 0 }
        await update($, agents, list => [...list.filter(a => a.id !== rec.id), rec].slice(-40))
      }
    } catch (error) { await report($, 'agent.spawn record', error) }
    return result
  })
  on('tool.call', async ($, e, next) => {
    let started = 0
    try {
      started = await $.clock.now()
      if (e.agentId) await update($, agents, list => list.map(a => a.id === e.agentId ? { ...a, now: toolLine(e), toolSince: started, state: 'running' } : a))
    } catch (error) { await report($, 'tool.call start', error) }
    try { return await next(e) }
    finally {
      try {
        if (e.agentId) await update($, agents, list => list.map(a => a.id === e.agentId && a.toolSince === started ? { ...a, now: undefined, toolSince: undefined, state: a.state === 'waiting' ? 'running' : a.state } : a))
      } catch (error) { await report($, 'tool.call finish', error) }
    }
  })
  on('session.compact', async ($, e, next) => {
    try {
      const language = await read($, lang)
      // The summary drops the eager note: the first prompt after it carries it again.
      if (!e.agentId && e.trigger !== 'precompute' && await read($, modeNoted) !== null) await update($, modeNoted, () => null)
      if (e.agentId || (await currentSettings($)).compactWith !== 'haiku') return next(e)
      if (e.trigger === 'precompute') return { skip: t(language, 'commands.compactSkip') }
      const transcript = serializeTranscript(e.messages.length ? e.messages : await $.session.messages())
      if (!transcript) throw new Error(t(language, 'toasts.transcriptEmpty'))
      const answer = await $.model.complete({ model: HAIKU, system: COMPACT_SYSTEM, prompt: transcript + (e.instructions ? `\n\nKeep especially:\n${e.instructions}` : ''), maxTokens: 16000, timeoutMs: 240000, effort: 'medium' })
      if (!answer.isAnswered || answer.text.trim().length <= 200) throw new Error(t(language, 'toasts.summaryEmpty'))
      await update($, cache, () => null)
      await update($, context, () => null)
      if (await read($, kept)) await update($, kept, () => null)
      await update($, resultCard, () => ({ stage: 'compacted' }))
      return compactResult(answer.text)
    } catch (error) {
      await $.ui.toast(t(await read($, lang), 'toasts.compactFallback'))
      await report($, 'session.compact', error)
    }
    return next(e)
  })
  on('command.run', { command: 'ripple' }, async ($, e, next) => {
    try {
      const language = await read($, lang)
      const [sub = 'settings', arg] = e.args.trim().toLowerCase().split(/\s+/)
      if (sub === 'stats') return { text: formatStats(await read($, stats), language) }
      if (sub === 'debug') return { text: debugText(language, { judge: (await currentSettings($)).judge, judgeModel: (await currentSettings($)).judgeModel, pick: await read($, pick), paused: await read($, paused), cache: await read($, cache), warm: await read($, warm), lastSpawn: await read($, lastSpawn), lastRequest: await read($, lastRequest), model: await $.session.model(), limit: await read($, limit), hostRateLimits: (await $.session.usage()).rateLimits }) }
      if (sub === 'settings' || sub === 'setup') await startPanel($, sub)
      else if (sub === 'auto') await toggleAuto($)
      else if (sub === 'warm') await toggleWarm($)
      else if (sub === 'save') await toggleSave($)
      else if (sub === 'handoff') await queueHandoff($, arg === 'full' ? 'full' : 'quick')
      else if (sub === 'log') await toggleLog($)
      else if (sub === 'agents') await toggleAgents($)
      else if (sub === 'bar') await toggleBar($)
      else if (['cold', 'swamp', 'hot', 'down', 'kept'].includes(sub)) { await update($, panel, () => null); await update($, demo, () => sub as 'cold' | 'swamp' | 'hot' | 'down' | 'kept') }
      else return { text: t(language, 'commands.help') }
      return { text: t(language, 'commands.done', { command: sub }) }
    } catch (error) { await report($, 'ripple command', error); return next(e) }
  })
  on('command.run', { command: 'ripple-log' }, async ($, e, next) => {
    try {
      const language = await read($, lang)
      return { text: await toggleLog($) ? t(language, 'commands.logOpened') : t(language, 'commands.logClosed') } }
    catch (error) { await report($, 'ripple-log', error); return next(e) }
  })
  on('command.run', { command: 'ripple-bar' }, async ($, e, next) => {
    try {
      const language = await read($, lang)
      if (!await toggleBar($)) return { text: t(language, 'commands.barHidden') }
      // The minimal layout draws no band above the prompt, only the short line under it (#56).
      return { text: t(language, (await currentSettings($)).layout === 'minimal' ? 'commands.barShownMinimal' : 'commands.barShown') } }
    catch (error) { await report($, 'ripple-bar', error); return next(e) }
  })
  on('command.run', { command: 'ripple-fast' }, async ($, e, next) => {
    try {
      const language = await read($, lang)
      const word = e.args.trim().toLowerCase()
      if (word !== '' && word !== 'on' && word !== 'off' && word !== 'auto') return { text: t(language, 'commands.fastUsage') }
      if (word === '') {
        await refreshFast($)
        const state = fastState(await read($, gptFast))
        return { text: t(language, 'fast.' + state) + ' · ' + t(language, state === 'unavailable' ? 'fast.downTip' : 'fast.scope') }
      }
      const done = await writeFast($, word === 'on' ? true : word === 'off' ? false : null)
      if (!done.ok) return { text: t(language, 'toasts.fastFailed', { reason: done.reason }) }
      return { text: t(language, 'commands.fastDone', { state: t(language, word === 'on' ? 'fast.on' : word === 'off' ? 'fast.off' : 'fast.auto') }) }
    } catch (error) { await report($, 'ripple-fast', error); return next(e) }
  })
  on('ui.close', { id: LOG_PANE }, async ($, e, next) => {
    try { await update($, logOpen, () => false) } catch (error) { await report($, 'log close', error) }
    return next(e)
  })
  on('ui.close', { id: AGENTS_PANE }, async ($, e, next) => {
    try { await update($, agentsOpen, () => false) } catch (error) { await report($, 'agents close', error) }
    return next(e)
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      const language = await read($, lang)
      startTimers($)
      if (e.props.hasSurvey) return next(e)
      const which = await read($, panel)
      const frame = await frameOf($, e)
      const el = $.ui.resolve(e)
      if (which === 'settings') return renderSettings(el, frame, await settingsView($), settingsActions($)) as RenderElement
      if (which === 'compact' || which === 'clear' || which === 'handoff') {
        const choice = await alertView($, frame.now)
        if (choice) return renderAlert(el, frame, choice, alertActions($, choice)) as RenderElement
      }
      if (which === 'setup') {
        return renderSetup(el, frame, { draft: normalizeSettings(await read($, settingsDraft) ?? await read($, settings)), jev: await read($, jev), step: await read($, setupStep) }, setupActions($)) as RenderElement
      }
      if (await read($, bandHidden)) return next(e)
      const alert = await alertView($, frame.now)
      if (alert) return renderAlert(el, frame, alert, alertActions($, alert)) as RenderElement
      const s = await currentSettings($)
      if (s.layout === 'minimal') return next(e)
      const { Box, Button, Text } = el
      const actions = bandActions($, e.surface)
      // The desktop draws the band as one surface with its × inside; the terminal keeps the row
      // of facts and controls with the close control (and its effort button) after it.
      if ((e.surface === 'desktop' || e.surface === 'vscode') && 'Svg' in el) {
        return renderBand(el, frame, await dashboard($, e.props.isWorking), { ...actions, hide: () => { void toggleBar($) } }) as RenderElement
      }
      return (
        <Box flexDirection="row" alignItems={e.surface === 'terminal' || e.surface === 'mobile' ? 'flex-start' : 'center'} columnGap={2}>
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>{renderBand(el, { ...frame, columns: frame.columns - besideBand(frame) }, await dashboard($, e.props.isWorking), actions)}</Box>
          <Box flexDirection="row" columnGap={2} flexShrink={0}>
            {e.surface === 'terminal' || e.surface === 'mobile' ? <Button key="effort" plain hotkey="e" label={t(language, 'band.effort')} onPress={actions.toggleEffortMenu} /> : null}
            <Button key="hide" plain role="dismiss" label="×" onPress={() => toggleBar($)} />
          </Box>
        </Box>
      )
    } catch (error) { await report($, 'AbovePrompt render', error); return next(e) }
  })
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const engine = await next(e)
    try {
      startTimers($)
      if ((await currentSettings($)).layout !== 'minimal' || await read($, bandHidden)) return engine
      return renderFooter($.ui.resolve(e), await frameOf($, e), await dashboard($, await read($, busy)), bandActions($, e.surface), engine) as RenderElement
    } catch (error) { await report($, 'SessionMode render', error); return engine }
  })
  on('ui.render', { component: 'Pane', requestId: LOG_PANE }, async ($, e, next) => {
    try {
      startTimers($)
      return renderLog($.ui.resolve(e), await frameOf($, e), { rows: await read($, requests), mineOnly: await read($, onlySession), judges: await read($, judgeRuns) }, { toggleScope: async () => { await update($, onlySession, value => !value); await refreshRouter($) } }) as RenderElement
    } catch (error) { await report($, 'log render', error); return next(e) }
  })
  on('ui.render', { component: 'Pane', requestId: AGENTS_PANE }, async ($, e, next) => {
    try {
      startTimers($)
      const frame = await frameOf($, e)
      return renderAgents($.ui.resolve(e), frame, { agents: await read($, agents), now: frame.now, showDone: await read($, agentsShowDone) }, { toggleDone: () => update($, agentsShowDone, value => !value) }) as RenderElement
    } catch (error) { await report($, 'agents render', error); return next(e) }
  })
}
