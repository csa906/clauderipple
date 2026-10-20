// The dashboard band above the prompt, and its minimal form in the footer.
//
// Desktop: one capsule of the deep (see "Desktop" below, art.ts and kit.tsx): 리플이 glowing at its
// left, acting out what the band is doing (thinking while Auto picks, busy while a request is out,
// drowsy as the cache runs out, asleep once it has, otherwise its idle life), the effort as five
// bars rising shallow to deep, the context ring, the cache clock in whole minutes, the plan limit
// (its window a gauge, its name and reset in the tip) and the mode when on, the last route, the
// judge's reason; then the drawn controls and the way out.
// What each fact means shows in the reason's place on hover. The terminal draws the same facts as
// one quiet row of text, without 리플이.
//
// Facts of the desktop host that shape it (claude.ai assets, read 2026-10-10 and 2026-10-12):
// - Each answer the band gives is drawn as a freshly built DOM tree swapped in for the last one,
//   and an Svg becomes a new <img> of a data URL or, interactive, a new sandboxed <iframe srcdoc>.
//   The frame paints blank until loaded, so an interactive Svg blinks on every redraw; the image
//   does not (seen in the owner's app, 2026-10-11), and its CSS motion runs. So every picture is
//   a plain image whose source is fixed per state: a redraw hands the host the same document and
//   only starts its motion over.
// - The surface asks again on every write of state the band read and on every invalidate, and
//   takes each answer as new. So the countdown shows whole minutes, and register.tsx invalidates
//   only when the minute shown changes.
// - The host's own buttons are its idiom (its primary button is the app's clay orange, and a plain
//   one's label takes the theme's ink), so the desktop draws its controls (art.ts) and lays a blank
//   native button over each (kit.tsx); a state is in the drawing (a switch's track, a lit flame).
//
// No item's width depends on its value: each fact has a slot sized for the widest value its
// language can show; the route is counted at a fixed room and takes what the row leaves; Handoff
// is counted whether it shows or not. The controls sit at the right end with the one
// that comes and goes (Handoff) first, so a changing value never moves a neighbour.

import { t } from '../i18n'
import type { Lang } from '../i18n'
import type { RenderChildren, RenderNode } from 'claude-code'

import type { Effort } from '../../types'
import { AGENTS_W, CELL_PX, DEPTH, ICON_PX, INK, METER_H, METER_W, MUTE, ROW_PX, SUB, TONE, agentsArt, clockArt, fastArt, gaugeArt, iconArt, meterArt, pillArt, plateArt, ringArt, ruleArt, textPx } from './art'
import type { Sea, Tone } from './art'
import { CLOSE_CELLS, capsule, closeButton, lift, lit, pic, pill, press, ripple, rowsOf, segmented, word, wordCells } from './kit'
import { textButton } from './parts'
import type { Els } from './parts'
import type { Face } from './ripple'
import { cacheTone, chOf, clip, contextTone, displayWidth, limitTone, providerColor, textTone } from './theme'
import type { BandActions, DashboardView, FastState, Frame } from './view'
import { EFFORTS, compactNumber, effortIndex, effortLabel, effortName, isRich, limitName, minutesLeft, modelName, resetsLabel, seconds } from './view'

/** Growing ripples: low → max. */
const RIPPLE_CHAR = ['·', '∘', '○', '◎', '◉']
/** Theme keys: they follow the person's light or dark theme on every surface. */
const WARN = 'warning'
const BAD = 'error'
/** Cells between facts, and between controls. */
const GAP = 2
const CTRL_GAP = 1
/** The least room a route is drawn in; on the desktop the host cuts the name to what is left. */
const ROUTE_MIN = 14
const RICH_ROUTE_MIN = 6
/** Desktop: the slot of the live agents' count after its control. */
const COUNT_CELLS = 2
/** The cache's last stretch, when 리플이 grows drowsy: five minutes, or a fifth of a short life. */
const DROWSY_MS = 5 * 60_000

/** What 리플이 acts out in the band, and so which of its fixed sources the band shows. */
export type BandMood = { face: Extract<Face, 'thinking' | 'working' | 'drowsy' | 'sleepy' | 'calm'>; dim: boolean }

/**
 * Thinking while Auto picks, working while a request is out, asleep once the cache has run out
 * and drowsy in its last minutes (not while keep-warm holds it), else its idle life; dimmed at
 * rest when Auto is off or paused. Read from whole minutes, as the countdown is, so the mood
 * changes no more often than what the band shows.
 */
export function bandMood(frame: Frame, view: DashboardView): BandMood {
  const quiet = view.effort.mode === 'off' || view.effort.mode === 'paused'
  if (view.effort.mode === 'deciding') return { face: 'thinking', dim: false }
  if (view.isWorking) return { face: 'working', dim: false }
  const cache = view.cache
  if (cache && !view.hide.includes('timer')) {
    const left = cache.expiresAt - frame.now
    if (left <= 0) return { face: 'sleepy', dim: quiet }
    const shown = Math.ceil(left / 60_000) * 60_000
    const held = view.warm.on && !view.warm.stopped
    if (!held && shown <= Math.min(DROWSY_MS, cache.ttlMs / 5)) return { face: 'drowsy', dim: quiet }
  }
  return { face: 'calm', dim: quiet }
}
/** The reason's slot on a wide terminal. */
const WHY_CELLS = 28

type Run = { text: string; color?: string; dim?: boolean; bold?: boolean }

/** One fact of the band: a slot of fixed width holding a glyph, a value and quiet trailing runs. */
type Fact = {
  key: string
  /** Cells the slot takes, whatever it shows. */
  width: number
  /** Desktop: a quiet name before the value, so a bare "60 min" says what it is. */
  label?: Run
  glyph?: Run
  value: Run
  /** The value is a button (desktop): the effort opens its menu, the route the log. */
  onPress?: () => void
  /** Desktop: the slot takes the room the row leaves instead of `width` (the route). */
  grow?: true
  tail?: Run[]
  /** What a hover card says, a line each (desktop). */
  card?: string[]
}

/**
 * Cells `text` takes: terminal columns, or on the desktop the host's `ch`, the width of "0" in its
 * 14 px sans. Measured 2026-10-10 in Chromium on macOS: ch 8.8 px, Hangul and kana ~12 px (1.36 ch),
 * "Medium" 5.9 ch, "X-High" 5.1 ch. Each class of character is taken a little wide of that; the
 * terminal's 2 cells for a wide character would leave a gap after every short Korean value.
 */
function cells(frame: Frame, text: string): number {
  return isRich(frame) ? Math.ceil(chOf(text)) : displayWidth(text)
}

function widest(frame: Frame, texts: readonly string[]): number {
  return Math.max(1, ...texts.map(text => cells(frame, text)))
}

/** The host's padding either side of a Button's label in the band, in ch (about 8 px each). */
const PAD = 2

/** What the effort slot can show: the names and "Deciding…" (a dash when there is no level). */
function effortWords(lang: Lang, rich: boolean): string[] {
  const words = [...EFFORTS.map(e => effortName(e, lang)), t(lang, 'band.deciding')]
  return rich ? words : words.map(w => w.toLowerCase())
}

// ---- Facts -------------------------------------------------------------------------------------

function effortFact(frame: Frame, view: DashboardView, onPress: () => void): Fact {
  const rich = isRich(frame)
  const accent = textTone(frame.appearance).accent
  const { level, mode, why } = view.effort
  const idx = effortIndex(level)
  const quiet = mode === 'off' || mode === 'paused'
  const glyph: Run =
    mode === 'deciding' ? { text: '◌', color: accent } : mode === 'paused' ? { text: '‖', dim: true } : { text: idx >= 0 ? RIPPLE_CHAR[idx]! : '○', ...(mode === 'auto' ? { color: accent } : quiet ? { dim: true } : {}) }
  // Paused or off with no level known: a dash; the glyph, the Auto toggle and the card say why.
  const word = mode === 'deciding' ? t(frame.lang, 'band.deciding') : level ? effortName(level, frame.lang) : '—'
  const label = rich ? word : word.toLowerCase()
  const value: Run = mode === 'deciding' ? { text: label, color: accent } : quiet ? { text: label, dim: true } : { text: label, bold: !rich }
  const tag = t(frame.lang, mode === 'auto' || mode === 'deciding' ? 'band.auto' : mode === 'manual' ? 'band.manual' : mode === 'paused' ? 'band.paused' : 'band.autoOff')
  const hint =
    mode === 'paused' ? t(frame.lang, 'band.pausedHint') : mode === 'off' ? t(frame.lang, 'band.offHint') : mode === 'deciding' ? t(frame.lang, 'band.decidingHint') : why ?? ''
  // Terminal: glyph, a cell, the label. Desktop: the glyph, then the label's button, whose own
  // padding is the air on both sides.
  // The desktop names the slot instead of a glyph: a ripple a few pixels across read as noise, not
  // as a level. A cell to spare: a host font a little wider than the estimate must not wrap it.
  const name = t(frame.lang, 'band.effortShort')
  const width = rich ? Math.ceil(chOf(name) + PAD + 1 + Math.max(...effortWords(frame.lang, rich).map(chOf))) : 2 + widest(frame, effortWords(frame.lang, rich))
  return {
    key: 'effort',
    width,
    ...(rich ? { label: { text: name, dim: true } } : { glyph }),
    value,
    ...(rich ? { onPress } : {}),
    card: [[view.model, tag].filter(Boolean).join(' · '), t(frame.lang, 'band.effortTitle', { value: word, hint: hint ? ' — ' + hint : '' })],
  }
}

/** Cells a mode's name may take in the band; a longer one is cut with an ellipsis. */
export const MODE_CELLS = 12

/** The active mode's name as the band shows it: whole, or cut to its slot. */
export function modeLabel(name: string): string {
  return clip(name, MODE_CELLS)
}

/**
 * The active operating mode, when one is on: "Mode Burn GPT" in the accent, its slot the same
 * width whatever the name (cut past MODE_CELLS), the whole name in the hover card.
 */
function modeFact(frame: Frame, view: DashboardView): Fact | null {
  if (!view.mode) return null
  const rich = isRich(frame)
  const name = t(frame.lang, 'band.mode')
  const value: Run = { text: rich ? modeLabel(view.mode) : name + ' ' + modeLabel(view.mode), color: textTone(frame.appearance).accent }
  const card = [t(frame.lang, 'band.modeTip', { name: view.mode })]
  // Desktop: a cell is about a ch; Latin capitals run a little wider, so the slot takes 1.1 ch each.
  if (rich) return { key: 'mode', width: Math.ceil(chOf(name) + 1 + MODE_CELLS * 1.1), label: { text: name, dim: true }, value, card }
  return { key: 'mode', width: cells(frame, name) + 1 + MODE_CELLS, value, card }
}

/** The pie a share of the cache's life reads as. */
function pie(frac: number): string {
  return frac > 0.875 ? '●' : frac > 0.625 ? '◕' : frac > 0.375 ? '◑' : frac > 0.125 ? '◔' : '○'
}

function cacheFact(frame: Frame, view: DashboardView): Fact | null {
  if (view.hide.includes('timer')) return null
  const accent = textTone(frame.appearance).accent
  const cache = view.cache
  const left = cache ? cache.expiresAt - frame.now : 0
  // Whole minutes, as shown: the slot changes once a minute and no more.
  const shown = cache && left > 0 ? Math.ceil(left / 60_000) : 0
  const warm = view.warm
  const lit = warm.on && !warm.stopped
  const last = shown === 1
  const glyph: Run = { text: shown > 0 && cache ? pie(Math.min(1, (shown * 60_000) / cache.ttlMs)) : '○', ...(last ? { color: WARN } : lit && shown > 0 ? { color: accent } : { dim: true }) }
  const text = cache ? minutesLeft(left, frame.lang) : '—'
  const value: Run = last ? { text, color: WARN } : { text, dim: shown === 0 }
  const tip = cache
    ? t(frame.lang, 'band.cacheTip', {
        state: shown > 0 ? t(frame.lang, 'band.warmFor', { time: text }) : t(frame.lang, 'band.expired'),
        warm: warm.on ? (warm.stopped ? t(frame.lang, 'band.warmStoppedTip', { reason: warm.stopped }) : t(frame.lang, 'band.warmOnTip', { count: warm.pings })) : '',
      })
    : t(frame.lang, 'band.noReply')
  const words = [t(frame.lang, 'units.minutes', { n: 60 }), t(frame.lang, 'band.cold'), '—']
  if (!isRich(frame)) return { key: 'cache', width: 2 + widest(frame, words), glyph, value, card: [tip] }
  // Desktop: "Cache 58 min", the last minute in the warning colour; the pie read as a status dot.
  const name = t(frame.lang, 'band.cache')
  return { key: 'cache', width: Math.ceil(chOf(name) + 1 + Math.max(...words.map(chOf))), label: { text: name, dim: true }, value, card: [tip] }
}

function contextFact(frame: Frame, view: DashboardView): Fact | null {
  const ctx = view.context
  if (!ctx || !view.extras.includes('context')) return null
  const tone = contextTone(ctx.percent, view.swampAt)
  const rich = isRich(frame)
  // Desktop: "Context 38%" in the facts' idiom; the terminal keeps its short "ctx 38%".
  const text = rich ? Math.round(ctx.percent) + '%' : t(frame.lang, 'band.footerContext', { percent: Math.round(ctx.percent) })
  const value: Run = tone === 'ink' ? { text, dim: !rich } : { text, color: tone === 'warn' ? WARN : BAD }
  const name = t(frame.lang, 'band.context')
  const width = rich ? Math.ceil(chOf(name) + 1 + chOf('100%')) : cells(frame, t(frame.lang, 'band.footerContext', { percent: 100 }))
  return { key: 'context', width, ...(rich ? { label: { text: name, dim: true } } : {}), value, card: [t(frame.lang, 'band.contextAlt', { value: Math.round(ctx.percent) + '%', window: compactNumber(ctx.window), tokens: compactNumber(ctx.tokens) })] }
}

function limitFact(frame: Frame, view: DashboardView): Fact | null {
  const limit = view.limit
  if (!limit || !view.extras.includes('limits')) return null
  const tone = limitTone(limit.percent)
  const rich = isRich(frame)
  const save = t(frame.lang, 'band.save')
  const tail: Run[] = limit.save ? [{ text: save, color: textTone(frame.appearance).accent }] : []
  const resets = resetsLabel(limit.resetsAt, frame.now, frame.lang)
  const card = [t(frame.lang, 'band.limitAlt', { window: limitName(limit.kind, frame.lang), value: Math.round(limit.percent) + '%', reset: resets ? ', ' + resets : '' })]
  if (rich) {
    // Desktop: "5h limit 64%", not a bare "5h 64%".
    const names = (['five_hour', 'seven_day'] as const).map(kind => t(frame.lang, 'band.limitCaption', { window: limitName(kind, frame.lang), save: '' }))
    const text = Math.round(limit.percent) + '%'
    const value: Run = tone === 'ink' ? { text } : { text, color: tone === 'warn' ? WARN : BAD }
    const width = Math.ceil(Math.max(...names.map(chOf)) + 1 + chOf('100%') + 1 + chOf(save))
    return { key: 'limit', width, label: { text: names[limit.kind === 'five_hour' ? 0 : 1]!, dim: true }, value, tail, card }
  }
  const text = limitName(limit.kind, frame.lang) + ' ' + Math.round(limit.percent) + '%'
  const value: Run = tone === 'ink' ? { text, dim: true } : { text, color: tone === 'warn' ? WARN : BAD }
  const width = widest(frame, [limitName('five_hour', frame.lang), limitName('seven_day', frame.lang)]) + cells(frame, ' 100%') + 1 + cells(frame, save)
  return { key: 'limit', width, value, tail, card: [t(frame.lang, 'band.limitAlt', { window: limitName(limit.kind, frame.lang), value: Math.round(limit.percent) + '%', reset: resets ? ', ' + resets : '' })] }
}

/** The last route in `room` cells, or the router's notice; null when there is neither or no room. */
function routeFact(frame: Frame, view: DashboardView, room: number, onPress: () => void): Fact | null {
  const rich = isRich(frame)
  if (view.hide.includes('route') || room < (rich ? RICH_ROUTE_MIN : ROUTE_MIN)) return null
  const r = view.route
  if (!r) {
    if (!view.notice) return null
    return { key: 'route', width: room, ...(rich ? { grow: true as const } : {}), value: { text: clip(view.notice.replace(/^ClaudeRipple:\s*/, ''), room), dim: true } }
  }
  const glyph: Run = r.resent ? { text: '↻', dim: true } : r.ok ? { text: rich ? '→' : '↳', dim: true } : { text: '✕', color: BAD }
  // The desktop says what the figure is ("hit 100%"); a bare percentage beside a model name read as anything.
  const hit = r.cachePct !== undefined ? (rich ? t(frame.lang, 'band.hit', { percent: r.cachePct }) : r.cachePct + '%') : ''
  const tail: Run[] = !r.ok
    ? [r.resent ? { text: t(frame.lang, 'band.resent', { status: r.status }), dim: true } : { text: r.status, color: BAD }]
    : r.cachePct !== undefined
      ? [cacheTone(r.cachePct) === 'ok' ? { text: hit, dim: true } : { text: hit, color: cacheTone(r.cachePct) === 'warn' ? WARN : BAD }]
      : []
  const tailCells = tail.reduce((n, run) => n + 1 + cells(frame, run.text), 0)
  const modelRoom = room - 2 - tailCells
  if (!rich && modelRoom < 4) return null
  const secs = seconds(r.seconds, frame.lang)
  const card = [
    t(frame.lang, 'band.routeAlt', { model: r.model, provider: r.provider, effort: r.effort ? ', ' + effortLabel(r.effort, frame.lang) : '', cache: r.cachePct !== undefined ? t(frame.lang, 'band.routeCache', { percent: r.cachePct }) : '', time: secs, status: r.ok ? '' : t(frame.lang, r.resent ? 'band.routeResent' : 'band.routeFailed', { status: r.status }) }),
    ...(r.note ? [r.note] : []),
    t(frame.lang, 'band.logHint'),
  ]
  // The desktop shows the whole name in whatever the row leaves; the host cuts it only past that.
  if (rich) return { key: 'route', width: room, grow: true, glyph, value: { text: r.model, dim: true }, onPress, tail, card }
  return { key: 'route', width: room, glyph, value: { text: clip(r.model, modelRoom) }, tail, card }
}

// ---- Controls ----------------------------------------------------------------------------------

/** GPT Fast's word: the state itself, localized (Auto, ON, OFF, or unavailable when the router cannot say). */
function fastLabel(lang: Lang, state: FastState): string {
  return t(lang, 'fast.' + state)
}

/** What pointing at (or reading) the control says: the state, what it covers and costs, how to change it. */
function fastTip(lang: Lang, state: FastState, busy: boolean): string {
  return fastLabel(lang, state) + (busy ? ' (' + t(lang, 'fast.saving') + ')' : '') + ' · ' + (state === 'unavailable' ? t(lang, 'fast.downTip') : t(lang, 'fast.scope') + ' ' + t(lang, 'fast.hint'))
}

/**
 * A control: its label, the hotkey, and whether it is on (a toggle that is on, an open pane, the
 * advised Handoff). The terminal says it in the label (● / ○), as its plain Buttons take no colour.
 */
type Control = { key: string; label: string; hotkey: string; onPress: () => void; on: boolean; count?: string }

function controls(frame: Frame, view: DashboardView, actions: BandActions): Control[] {
  const L = frame.lang
  const mark = (on: boolean) => (on ? ' ●' : ' ○')
  const out: Control[] = []
  // Handoff comes and goes; first in the row, it moves nothing when it does.
  if (view.handoff !== 'off') {
    const advised = view.handoff === 'advised'
    out.push({ key: 'handoff', label: t(L, 'band.handoff') + (!isRich(frame) && advised ? ' ◆' : ''), hotkey: 'h', onPress: actions.handoff, on: advised })
  }
  out.push(
    { key: 'auto', label: t(L, 'band.auto') + mark(view.auto), hotkey: 'a', onPress: actions.toggleAuto, on: view.auto },
    { key: 'warm', label: t(L, 'band.warm') + mark(view.warm.on), hotkey: 'w', onPress: actions.toggleWarm, on: view.warm.on },
    // GPT Fast: only a view that carries it draws it (the word is the state, so an unknown one reads unavailable).
    ...(view.fast && actions.toggleFast ? [{ key: 'fast', label: '⚡ ' + fastLabel(L, view.fast.state) + (view.fast.state === 'on' ? ' ●' : view.fast.state === 'off' ? ' ○' : ''), hotkey: 'f', onPress: actions.toggleFast, on: view.fast.state === 'on' }] : []),
    // The desktop opens the log from the route itself (its value is that button), so it has no Log of its own.
    ...(!isRich(frame) ? [{ key: 'log', label: t(L, 'band.log') + mark(view.logOpen), hotkey: 'l', onPress: actions.toggleLog, on: view.logOpen }] : []),
    // The count has a slot of its own (desktop) or is always a number (terminal): no width change.
    { key: 'agents', label: t(L, 'band.agents') + (isRich(frame) ? '' : ' ' + (view.agents.live || '·')) + mark(view.agentsOpen), hotkey: 'g', onPress: actions.toggleAgents, on: view.agentsOpen, ...(isRich(frame) ? { count: view.agents.live > 0 ? String(view.agents.live) : '' } : {}) },
    // The desktop's Clear asks first (a card of its own, "clear" in bandPriority); Compact opens its note bar.
    ...(isRich(frame) ? [{ key: 'compact', label: t(L, 'band.compact'), hotkey: 'c', onPress: actions.compact, on: false }, { key: 'clear', label: t(L, 'band.clear'), hotkey: 'x', onPress: actions.clear, on: false }] : []),
    // A word on the desktop: the host's 14 px font draws ⚙ as a small ring that reads as "o".
    { key: 'settings', label: isRich(frame) ? t(L, 'band.settings') : '⚙', hotkey: 's', onPress: actions.openSettings, on: false },
  )
  return out
}

/** Cells a control takes. Desktop: the label in the button's padding, then the count's slot. */
function controlCells(frame: Frame, c: Control): number {
  if (!isRich(frame)) return cells(frame, c.hotkey) + 2 + cells(frame, c.label)
  return cells(frame, c.label) + PAD + (c.count !== undefined ? COUNT_CELLS : 0)
}

/** Every control's cells, Handoff counted whether shown or not, so the route's room stays put. */
function controlsCells(frame: Frame, view: DashboardView, actions: BandActions): number {
  const list = controls(frame, { ...view, handoff: 'advised' }, actions)
  return list.reduce((n, c) => n + controlCells(frame, c), 0) + CTRL_GAP * (list.length - 1) * (isRich(frame) ? 1 : 2)
}

// ---- Layout ------------------------------------------------------------------------------------

const span = (facts: readonly Fact[]) => facts.reduce((n, f) => n + f.width, 0) + GAP * Math.max(0, facts.length - 1)

/** The facts in order, the route in what the row leaves it. */
function factsFor(frame: Frame, view: DashboardView, actions: BandActions, room: number, drop: readonly string[] = []): Fact[] {
  const fixed = [effortFact(frame, view, actions.toggleEffortMenu), modeFact(frame, view), contextFact(frame, view), cacheFact(frame, view), limitFact(frame, view)].filter(
    (f): f is Fact => f !== null && !drop.includes(f.key),
  )
  const left = room - span(fixed) - (fixed.length ? GAP : 0)
  // The desktop's route is a flex item: it takes what the row really leaves (the room counted here
  // keeps Handoff's place, which it mostly does not need) and the host cuts its name past that.
  const route = drop.includes('route') ? null : routeFact(frame, view, isRich(frame) ? Math.max(left, RICH_ROUTE_MIN) : left, actions.toggleLog)
  return route ? [...fixed, route] : fixed
}

// ---- Desktop -----------------------------------------------------------------------------------
//
// One capsule of the deep (kit.tsx `capsule`): 리플이 at its left in a glow, ripples spreading from
// it (quick while a request is out, a current running along the floor), a sonar sweep while the
// judge sounds how deep to think, amber light as the cache runs out, frost and snow once it has. On
// it, left to right: the effort as five bars rising shallow to deep and its word; a rule; the
// context ring, the cache clock, the plan limit and the mode when on; a rule; the last route (its
// model the way into the log); the judge's reason in what is left. Then the controls, each lit
// under the pointer: Handoff when advised, Auto's switch, keep-warm's flame, the agents, settings,
// and the way out. Pointing at a fact shows what it means in the reason's place.

/** 리플이 in the band, px: the mini drawing (ripple.ts), a little taller than a line of text. */
export const BAND_RIPPLE = 24
/** 리플이's slot at the row's start, in cells: 24 px and its air. */
export const CREST_CELLS = 4
/** The row's height, px: a pill's, whether or not one shows, so Handoff never moves the band. */
const ROW_H = 26
// Fact and control widths alone decide the row, never a value, so a changing figure never moves its
// neighbours. The air between facts and between controls is trimmed below what reads as a whole cell
// (the limit's word became a gauge for the same reason): at 100 columns a route name of 13
// characters ("glm-5.3-flash") must draw whole beside everything else, and a loose gap ate the
// route's room and cut it (2026-10-14).
/** The air between facts, in cells (the host takes fractions of a cell). */
const DRAWN_GAP = 0.2
/** A rule between the band's groups, in cells. */
const RULE_CELLS = 1
/** The room the route is counted at (a model name and its hit); it takes more when the row has it. */
const ROUTE_ROOM = 14
/** The controls whose words go first when the band is narrow, in that order; Auto's goes last. */
const WORDLESS = ['clear', 'compact', 'settings', 'agents', 'warm', 'fast'] as const
/** The capsule's own air, in cells across and rows down. */
const PAD_X = 1
const PAD_Y = 0.5

/** The water's light and motion for what 리플이 is acting out. */
function bandSea(mood: BandMood): Omit<Sea, 'at'> {
  const strength = mood.dim ? 0.5 : 1
  if (mood.face === 'thinking') return { tone: 'violet', ripples: 'calm', sweep: true, motes: true }
  if (mood.face === 'working') return { tone: 'violet', ripples: 'busy', current: true, strength }
  if (mood.face === 'drowsy') return { tone: 'amber', ripples: 'calm', motes: true, strength }
  if (mood.face === 'sleepy') return { tone: 'ice', weather: 'snow', strength: 0.8 }
  return { tone: 'violet', ripples: 'calm', motes: true, strength }
}

/** A fact's hover group: pointing at it shows its tip in the reason's place. */
const tipScope = (key: string) => 'ripple-tip-' + key

type DrawnFact = { key: string; cells: number; node: RenderNode; tip?: string }

function drawnFact(el: Els, key: string, cells: number, children: RenderNode[], tip?: string): DrawnFact {
  const { Box } = el
  return {
    key,
    cells,
    tip,
    node: (
      <Box key={'fact-' + key} position="relative" flexDirection="row" alignItems="center" columnGap={1} width={cells} flexShrink={0} {...(tip ? { hover: { scope: tipScope(key) } } : {})}>
        {children}
      </Box>
    ),
  }
}

/** A figure's colour by its tone: bright ink while all is well, amber, then red. */
function figure(tone: 'ink' | 'ok' | 'warn' | 'bad'): string {
  return tone === 'warn' ? TONE.amber.text : tone === 'bad' ? TONE.red.text : INK
}

function effortDrawn(el: Els, frame: Frame, view: DashboardView, actions: BandActions): DrawnFact {
  const { Box, Text } = el
  const { level, mode } = view.effort
  const idx = effortIndex(level)
  const word = mode === 'deciding' ? t(frame.lang, 'band.deciding') : level ? effortName(level, frame.lang) : '—'
  const look = mode === 'deciding' ? 'deciding' : mode === 'auto' ? 'auto' : mode === 'manual' ? 'manual' : 'quiet'
  // The word's slot is sized for the widest word (bold Hangul runs ~15% wide of the estimate).
  const wordPx = Math.max(...effortWords(frame.lang, true).map(w => textPx(w) * 1.15))
  const cells = Math.ceil((METER_W + CELL_PX + wordPx) / CELL_PX)
  const tip = effortFact(frame, view, actions.toggleEffortMenu).card?.join(' · ')
  return drawnFact(
    el,
    'effort',
    cells,
    [
      pic(el, 'meter', meterArt(mode === 'deciding' ? 5 : idx + 1, look), t(frame.lang, 'band.effort'), METER_W, METER_H),
      <Box key="effort-word" flexShrink={0}>
        <Text bold color={mode === 'deciding' ? TONE.violet.text : look === 'quiet' ? MUTE : INK}>{word}</Text>
      </Box>,
      press(el, 'effort', cells * CELL_PX, actions.toggleEffortMenu),
    ],
    tip,
  )
}

function contextDrawn(el: Els, frame: Frame, view: DashboardView): DrawnFact | null {
  const ctx = view.context
  if (!ctx || !view.extras.includes('context')) return null
  const { Text } = el
  const tone = contextTone(ctx.percent, view.swampAt)
  const tip = contextFact(frame, view)?.card?.join(' · ')
  const cells = Math.ceil((16 + CELL_PX + textPx('100%')) / CELL_PX)
  return drawnFact(el, 'context', cells, [
    pic(el, 'ring', ringArt(ctx.percent, tone === 'ink' ? 'ink' : tone === 'warn' ? 'amber' : 'red'), t(frame.lang, 'band.context'), 16, 16),
    <Text key="ctx-value" color={figure(tone)}>{Math.round(ctx.percent) + '%'}</Text>,
  ], tip)
}

function cacheDrawn(el: Els, frame: Frame, view: DashboardView): DrawnFact | null {
  if (view.hide.includes('timer')) return null
  const { Text } = el
  const cache = view.cache
  const left = cache ? cache.expiresAt - frame.now : 0
  const shown = cache && left > 0 ? Math.ceil(left / 60_000) : 0
  const held = view.warm.on && !view.warm.stopped
  const drowsy = !!cache && shown > 0 && !held && shown * 60_000 <= Math.min(DROWSY_MS, cache.ttlMs / 5)
  const tone: Tone | 'soft' = shown === 0 ? 'soft' : drowsy ? 'amber' : held ? 'violet' : 'soft'
  const text = cache ? minutesLeft(left, frame.lang) : '—'
  const words = [t(frame.lang, 'units.minutes', { n: 60 }), t(frame.lang, 'band.cold'), '—']
  const cells = Math.ceil((16 + CELL_PX + Math.max(...words.map(textPx))) / CELL_PX)
  const tip = cacheFact(frame, view)?.card?.join(' · ')
  return drawnFact(el, 'cache', cells, [
    pic(el, 'clock', clockArt(cache ? (shown * 60_000) / cache.ttlMs : 0, tone), t(frame.lang, 'band.cache'), 16, 16),
    <Text key="cache-value" color={drowsy ? TONE.amber.text : shown === 0 ? MUTE : held ? TONE.violet.text : INK}>{text}</Text>,
  ], tip)
}

function limitDrawn(el: Els, frame: Frame, view: DashboardView): DrawnFact | null {
  const limit = view.limit
  if (!limit || !view.extras.includes('limits')) return null
  const { Text } = el
  const save = t(frame.lang, 'band.save')
  // The window is a gauge (art.ts), not its word: at 100 columns the name "주간"/"Weekly" was cut
  // to "g…" beside the route, and the window's name and reset stay in the tip (2026-10-14). Save's
  // word takes room only while save mode is on: reserved always, it cost the limit its place on a
  // band near 95 columns (2026-10-14).
  const cells = Math.ceil((16 + CELL_PX + textPx('100%') + (limit.save ? CELL_PX + textPx(save) : 0)) / CELL_PX)
  return drawnFact(el, 'limit', cells, [
    pic(el, 'limit', gaugeArt(limit.kind), t(frame.lang, 'band.limit'), 16, 16),
    <Text key="limit-value" color={figure(limitTone(limit.percent))}>{Math.round(limit.percent) + '%'}</Text>,
    limit.save ? <Text key="limit-save" color={TONE.violet.text}>{save}</Text> : '',
  ], limitFact(frame, view)?.card?.join(' · '))
}

function modeDrawn(el: Els, frame: Frame, view: DashboardView): DrawnFact | null {
  if (!view.mode) return null
  const { Text } = el
  // One slot whatever the name (cut past MODE_CELLS; Latin capitals run ~1.1 ch).
  const amber = TONE.amber.text
  return drawnFact(el, 'mode', 2 + Math.ceil(MODE_CELLS * 1.1), [<Text key="mode-mark" color={amber}>◆</Text>, <Text key="mode-name" color={amber}>{modeLabel(view.mode)}</Text>], t(frame.lang, 'band.modeTip', { name: view.mode }))
}

/**
 * The routed model as the band names it: what was asked dropped, and Claude's ids by their
 * family and version ("claude-opus-5-5" → "Opus 5.5"); the whole route is in the tip.
 */
function routeName(model: string): string {
  return modelName(model.replace(/\s*\(.*\)$/, ''))
}

/** The last route: where it went (the provider's dot), the model, its cache hit; the way into the log. */
function routeDrawn(el: Els, frame: Frame, view: DashboardView, actions: BandActions, room: number): RenderNode {
  const { Box, Text } = el
  if (view.hide.includes('route')) return ''
  const r = view.route
  if (!r) {
    if (!view.notice) return ''
    return (
      <Box key="fact-route" position="relative" flexShrink={1} minWidth={0} overflow="hidden">
        <Text color={MUTE} wrap="truncate">{view.notice.replace(/^ClaudeRipple:\s*/, '')}</Text>
      </Box>
    )
  }
  const tone = r.cachePct !== undefined ? cacheTone(r.cachePct) : 'ok'
  const tip = routeFact(frame, view, 200, actions.toggleLog)?.card?.join(' · ')
  return (
    <Box key="fact-route" position="relative" flexDirection="row" alignItems="center" columnGap={0.5} flexShrink={1} minWidth={Math.min(ROUTE_ROOM, room)} overflow="hidden" {...(tip ? { hover: { scope: tipScope('route') } } : {})}>
      <Box flexShrink={0}>
        {r.ok ? <Text color={r.resent ? MUTE : providerColor(r.provider)}>{r.resent ? '↻' : '•'}</Text> : <Text color={TONE.red.text}>✕</Text>}
      </Box>
      <Box flexShrink={1} minWidth={0}>
        <Text color={SUB} wrap="truncate">{routeName(r.model)}</Text>
      </Box>
      <Box flexShrink={0}>
        {!r.ok ? (
          <Text color={r.resent ? MUTE : TONE.red.text}>{r.resent ? t(frame.lang, 'band.resent', { status: r.status }) : r.status}</Text>
        ) : r.cachePct !== undefined ? (
          <Text color={tone === 'ok' ? TONE.green.text : figure(tone === 'warn' ? 'warn' : 'bad')}>{r.cachePct + '%'}</Text>
        ) : null}
      </Box>
      {press(el, 'route', Math.max(40, frame.columns) * CELL_PX * 0.4, actions.toggleLog)}
    </Box>
  )
}

/**
 * What the row leaves, blank, and each fact's or control's tip laid over it on hover. The judge's
 * reason is no longer written here (cut to a word or two it said nothing, 2026-10-13); it is in the
 * effort's tip.
 *
 * The layer is placed absolutely over the facts (columns `left` to the facts' right edge, which is
 * just before the controls) rather than drawn in what the row leaves free: at the band's real width
 * (2026-10-14: 100 columns with every fact and control drawn) nothing is left free, and a tip drawn
 * in a zero-width box never showed. Covering the facts while a tip shows is expected. The tips rest
 * `display: "none"` (so they take no pointer) and carry no `key`: a keyed Box drawn `display: "none"`
 * is refused as a hover scope (the pointer could never be over it), so each tip reveals through its
 * own `hover.scope`, which the fact's or control's hover lights.
 */
function whyDrawn(el: Els, frame: Frame, tips: { key: string; text: string }[], at: number): RenderNode {
  const { Box, Text } = el
  // Placed Box offsets are whole cells; the layer starts at the first cell past 리플이 and the effort.
  const left = Math.ceil(at)
  const width = Math.max(40, frame.columns) * CELL_PX
  return (
    <Box key="band-why" position="absolute" top={0} bottom={0} left={left} right={0} minWidth={0} overflow="hidden">
      {tips.map(tip => (
        <Box position="absolute" top={0} bottom={0} left={0} right={0} display="none" hover={{ scope: tipScope(tip.key), display: 'flex' }} overflow="hidden">
          <Box position="absolute" top={0} left={0}>
            {pic(el, 'tip-plate-' + tip.key, plateArt(width, ROW_PX), tip.text, width, ROW_PX)}
          </Box>
          <Box position="relative" flexShrink={1} minWidth={0}>
            {lift(el)}
            <Text color={INK} wrap="truncate">{tip.text}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}

/** A thin rule between the band's groups. */
function rule(el: Els, key: string): RenderNode {
  const { Box } = el
  return (
    <Box key={'rule-' + key} width={RULE_CELLS} flexShrink={0} alignItems="center">
      {pic(el, 'rule-' + key, ruleArt(), '|', 9, 16)}
    </Box>
  )
}

type DrawnControl = { key: string; cells: number; node: RenderNode; tip: string }

/** An icon control, lit under the pointer: its picture, its word when the band has room, its press. */
function iconControl(el: Els, key: string, source: string, artPx: number, alt: string, tip: string, onPress: () => void, label?: string, color = SUB): DrawnControl {
  const { Text } = el
  const pad = label ? 0.5 : 0.25
  const cells = Math.ceil((artPx + (label ? CELL_PX + chOf(label) * CELL_PX * 1.04 : 0)) / CELL_PX + pad * 2)
  return {
    key,
    cells,
    tip,
    node: lit(el, key, cells, [pic(el, key, source, alt, artPx, 16), label ? <Text key={key + '-word'} color={color}>{label}</Text> : '', press(el, key, cells * CELL_PX, onPress)], pad, tipScope(key)),
  }
}

/** The controls at the right end, each naming what it does on hover; `words` the ones with their word. */
function controlsDrawn(el: Els, frame: Frame, view: DashboardView, actions: BandActions, words: readonly string[]): DrawnControl[] {
  const L = frame.lang
  const out: DrawnControl[] = []
  const state = (on: boolean) => t(L, on ? 'band.on' : 'band.off')
  if (view.handoff !== 'off') {
    const advised = view.handoff === 'advised'
    const label = t(L, 'band.handoff')
    const look = advised ? 'primary' : 'ghost'
    out.push({ key: 'handoff', cells: pillArt(label, look, 'violet').cells + 1, node: pill(el, 'handoff', label, look, actions.handoff, 'violet'), tip: t(L, 'alerts.handoffTitle') })
  }
  // Auto's word is the control (art.ts `wordArt`): lit violet while on, a quiet ghost while off,
  // pulsing while the judge decides. No switch: the state is in the word's own light (2026-10-14).
  const autoLabel = t(L, 'band.auto')
  const autoTip = t(L, 'band.effortAutoAlt', { state: state(view.auto) }) + ' · ' + t(L, 'settings.autoLine')
  out.push({ key: 'auto', cells: wordCells(autoLabel), node: word(el, 'auto', view.auto, autoLabel, actions.toggleAuto, view.effort.mode === 'deciding', tipScope('auto')), tip: autoTip })
  const warmLabel = t(L, 'band.warm')
  out.push(iconControl(el, 'warm', iconArt('flame', view.warm.on, 'amber'), ICON_PX, warmLabel, t(L, 'band.warmAlt', { state: state(view.warm.on) }) + ' · ' + t(L, view.warm.here ? 'band.warmHere' : 'settings.warmLine'), actions.toggleWarm, words.includes('warm') ? warmLabel : undefined, view.warm.on ? TONE.amber.text : SUB))
  if (view.fast && actions.toggleFast) {
    const fastText = fastLabel(L, view.fast.state)
    out.push(iconControl(el, 'fast', fastArt(view.fast.state), ICON_PX, fastText, fastTip(L, view.fast.state, view.fast.busy), actions.toggleFast, words.includes('fast') ? fastText : undefined, view.fast.state === 'on' ? TONE.amber.text : view.fast.state === 'unavailable' ? MUTE : SUB))
  }
  const agentsLabel = t(L, 'band.agents')
  const live = view.agents.live
  // The live count sits on the icon's shoulder, in one picture of one width: no width change.
  out.push(iconControl(el, 'agents', agentsArt(live, view.agentsOpen || live > 0), AGENTS_W, live > 0 ? agentsLabel + ' ' + live : agentsLabel, t(L, 'band.agentsAlt', { count: live }), actions.toggleAgents, words.includes('agents') ? agentsLabel : undefined, view.agentsOpen ? INK : SUB))
  const compactLabel = t(L, 'band.compact')
  out.push(iconControl(el, 'compact', iconArt('compact', false), ICON_PX, compactLabel, t(L, 'band.compactAlt'), actions.compact, words.includes('compact') ? compactLabel : undefined))
  const clearLabel = t(L, 'band.clear')
  out.push(iconControl(el, 'clear', iconArt('clear', false), ICON_PX, clearLabel, t(L, 'band.clearAlt'), actions.clear, words.includes('clear') ? clearLabel : undefined))
  const settingsLabel = t(L, 'band.settings')
  out.push(iconControl(el, 'settings', iconArt('gear', false), ICON_PX, settingsLabel, t(L, 'band.settingsAlt'), actions.openSettings, words.includes('settings') ? settingsLabel : undefined))
  return out
}

function effortMenuDrawn(el: Els, frame: Frame, view: DashboardView, actions: BandActions): RenderNode {
  const { Box } = el
  const current = view.effort.mode === 'manual' || view.effort.mode === 'off' ? view.effort.level : null
  return (
    <Box key="effort-menu" flexDirection="row" alignItems="center" flexWrap="wrap" columnGap={2} rowGap={1} paddingTop={1} paddingLeft={CREST_CELLS}>
      {word(el, 'pick-auto', view.auto, t(frame.lang, 'band.auto'), actions.toggleAuto)}
      {segmented(el, 'pick', EFFORTS.map(effort => ({ value: effort, label: effortName(effort, frame.lang) })), current, effort => actions.pickEffort(effort), 'violet', DEPTH)}
    </Box>
  )
}

function bandDrawn(el: Els, frame: Frame, view: DashboardView, actions: BandActions): RenderNode {
  const { Box } = el
  // The capsule's air and edge take their share of the frame.
  const cols = Math.max(30, frame.columns) - 2 * PAD_X - 1
  const mood = bandMood(frame, view)
  // The row's budget, widths alone (never values): 리플이, the facts at their slots, the rules, a
  // route at its least, the controls, the way out. Narrow, the controls drop their words first,
  // then the quietest facts go.
  const close = actions.hide ? CLOSE_CELLS : 0
  const effort = effortDrawn(el, frame, view, actions)
  const optional = [modeDrawn(el, frame, view), contextDrawn(el, frame, view), cacheDrawn(el, frame, view), limitDrawn(el, frame, view)].filter((f): f is DrawnFact => f !== null)
  // The Auto word is its control: it never loses its shape, so no word of it is dropped, and the
  // spare words (the icons' beside it) go first when the row narrows.
  let words: readonly string[] = [...WORDLESS]
  // Counted with Handoff in its place whether it shows or not, and the route at a fixed room
  // (a long model name is cut, a short one leaves air): what the band holds never depends on a value.
  // The air between controls is the row's own columnGap (a fraction of a cell, as the facts' air),
  // and the hide button a half-separator of its own.
  const counted = (w: readonly string[]) => {
    const list = controlsDrawn(el, frame, { ...view, handoff: 'advised' }, actions, w)
    return list.reduce((n, c) => n + c.cells, 0) + 0.15 * (list.length - 1) + (actions.hide ? 0.15 : 0)
  }
  let controlCells = counted(words)
  let route = view.hide.includes('route') ? 0 : ROUTE_ROOM
  let ruled = true
  const span = (facts: DrawnFact[]) => facts.reduce((n, f) => n + f.cells + DRAWN_GAP, 0)
  const rules = (facts: DrawnFact[]) => (ruled ? (facts.length ? RULE_CELLS + DRAWN_GAP : 0) + (route ? RULE_CELLS + DRAWN_GAP : 0) : 0)
  const need = (facts: DrawnFact[]) => CREST_CELLS + DRAWN_GAP + effort.cells + DRAWN_GAP + rules(facts) + span(facts) + (route ? route + DRAWN_GAP : 0) + controlCells + close + 1
  let facts = optional
  // Narrow, things go in this order until the row fits: the icons' words (clear, compact,
  // settings, agents, keep-warm), the rules, then the route draws in to its least, then the mode
  // and the context chip, last the cache. The limit and the new icons stay (2026-10-14: the band
  // sits at its ~100-column maximum and must hold everything there, Handoff with the rest).
  for (const drop of [...WORDLESS, 'rules', 'route', 'mode', 'context', 'cache']) {
    if (need(facts) <= cols) break
    if ((WORDLESS as readonly string[]).includes(drop)) {
      words = words.filter(w => w !== drop)
      controlCells = counted(words)
    } else if (drop === 'rules') ruled = false
    else if (drop === 'route') route = RICH_ROUTE_MIN
    else facts = facts.filter(f => f.key !== drop)
  }
  const controls = controlsDrawn(el, frame, view, actions, words)
  const tips = [effort, ...facts].filter(f => f.tip).map(f => ({ key: f.key, text: f.tip! }))
  const routeTip = route > 0 && view.route ? routeFact(frame, view, 200, actions.toggleLog)?.card?.join(' · ') : undefined
  if (routeTip) tips.push({ key: 'route', text: routeTip })
  for (const c of controls) if (c.key !== 'handoff') tips.push({ key: c.key, text: c.tip })
  if (actions.hide) tips.push({ key: 'hide', text: t(frame.lang, 'band.hideBand') })
  const crest = (
    <Box key="band-crest" width={CREST_CELLS} flexShrink={0} alignItems="center">
      {ripple(el, 'band-' + mood.face + (mood.dim ? '-dim' : ''), mood.face, 'ClaudeRipple', BAND_RIPPLE, undefined, mood.dim)}
    </Box>
  )
  const routeNode = route > 0 ? routeDrawn(el, frame, view, actions, route) : ''
  const row = (
    <Box key="band-row" flexDirection="row" alignItems="center" width="100%" minWidth={0} height={rowsOf(ROW_H)}>
      <Box key="band-facts" flexDirection="row" alignItems="center" columnGap={DRAWN_GAP} flexGrow={1} flexShrink={1} width={0} minWidth={0}>
        {crest}
        {effort.node}
        {ruled && facts.length ? rule(el, 'facts') : null}
        {facts.map(f => f.node)}
        {ruled && routeNode ? rule(el, 'route') : null}
        {routeNode}
        {whyDrawn(el, frame, tips, CREST_CELLS + DRAWN_GAP + effort.cells + DRAWN_GAP)}
      </Box>
      <Box key="band-controls" flexDirection="row" alignItems="center" columnGap={0.15} flexShrink={0} marginLeft={0.5}>
        {controls.map(c => c.node)}
        {actions.hide ? closeButton(el, 'hide', t(frame.lang, 'band.hideBand'), () => actions.hide!(), tipScope('hide')) : null}
      </Box>
    </Box>
  )
  return capsule(el, frame, {
    key: 'band',
    sea: { ...bandSea(mood), reach: 120, at: { x: PAD_X * CELL_PX + (CREST_CELLS * CELL_PX) / 2, y: PAD_Y * ROW_PX * 0.5 + ROW_H / 2 } },
    rows: view.effortMenu ? 3.4 : 1.8,
    paddingX: PAD_X,
    paddingY: PAD_Y,
    children: [row, view.effortMenu ? effortMenuDrawn(el, frame, view, actions) : ''],
  })
}

// ---- Terminal ----------------------------------------------------------------------------------

function runText(el: Els, key: string, run: Run): RenderNode {
  const { Text } = el
  return (
    <Text key={key} color={run.color} dimColor={run.dim} bold={run.bold}>
      {run.text}
    </Text>
  )
}

function factText(el: Els, f: Fact): RenderNode {
  const { Box } = el
  return (
    <Box key={'fact-' + f.key} flexDirection="row" columnGap={1} width={f.width} flexShrink={0}>
      {f.glyph ? runText(el, 'glyph', f.glyph) : null}
      {runText(el, 'value', f.value)}
      {(f.tail ?? []).map((run, i) => runText(el, 'tail-' + i, run))}
    </Box>
  )
}

/**
 * The judge's reason in a slot of its own on a wide terminal, cut to it; the slot stays, blank,
 * while there is no reason, so the route beside it never changes width.
 */
function whyFact(view: DashboardView): Fact | null {
  if (view.hide.includes('reason')) return null
  const why = view.effort.mode === 'auto' ? view.effort.why : undefined
  return { key: 'why', width: WHY_CELLS, value: { text: why ? clip('“' + why + '”', WHY_CELLS) : '', dim: true } }
}

function bandText(el: Els, frame: Frame, view: DashboardView, actions: BandActions): RenderNode {
  const { Box } = el
  const cols = Math.max(20, frame.columns)
  const ctrls = controls(frame, view, actions)
  const ctrlCells = controlsCells(frame, view, actions)
  const budget = Math.max(1, frame.maxRows)
  // One row when the facts (a route at its least) and the controls fit; else facts, then controls.
  // Too tall for the band: the quietest facts go first. Widths alone decide, never values.
  let drop: string[] = []
  const plan = () => {
    const routeCells = view.hide.includes('route') || drop.includes('route') ? 0 : GAP + ROUTE_MIN
    const oneRow = span(factsFor(frame, view, actions, cols, [...drop, 'route'])) + routeCells + GAP + ctrlCells <= cols
    const room = oneRow ? cols - ctrlCells - GAP : cols
    return { oneRow, facts: factsFor(frame, view, actions, room, drop), room }
  }
  let p = plan()
  for (const key of ['limit', 'context', 'route', 'mode', 'cache']) {
    if ((p.oneRow ? 1 : 2) <= budget) break
    drop = [...drop, key]
    p = plan()
  }
  let facts = p.facts
  // The reason only where the row has room for its whole slot and a roomy route beside it.
  const why = whyFact(view)
  const routeNeed = view.hide.includes('route') || drop.includes('route') ? 0 : GAP + 2 * WHY_CELLS
  if (why && p.room - span(factsFor(frame, view, actions, p.room, [...drop, 'route'])) - GAP >= WHY_CELLS + routeNeed) {
    const room = p.room - WHY_CELLS - GAP
    facts = factsFor(frame, view, actions, room, drop)
    const at = facts.findIndex(f => f.key === 'route')
    facts = at < 0 ? [...facts, why] : [...facts.slice(0, at), why, ...facts.slice(at)]
  }
  const factRow = (
    <Box key="facts" flexDirection="row" columnGap={GAP} flexShrink={0}>
      {facts.map(f => factText(el, f))}
    </Box>
  )
  const ctrlRow = (
    <Box key="controls" flexDirection="row" flexWrap="wrap" columnGap={GAP} flexShrink={0}>
      {ctrls.map(c => textButton(el, c.key, c.label, c.onPress, c.hotkey))}
    </Box>
  )
  const menu = view.effortMenu ? (
    <Box key="effort-menu" flexDirection="row" flexWrap="wrap" columnGap={GAP}>
      {textButton(el, 'pick-auto', t(frame.lang, 'band.auto') + ' ' + (view.auto ? '●' : '○'), actions.toggleAuto, '0')}
      {EFFORTS.map((effort: Effort, i) => textButton(el, 'pick-' + effort, RIPPLE_CHAR[i]! + ' ' + effortName(effort, frame.lang).toLowerCase(), () => actions.pickEffort(effort), String(i + 1)))}
    </Box>
  ) : null
  return (
    <Box flexDirection="column" width="100%">
      {p.oneRow ? (
        <Box key="row" flexDirection="row" width="100%">
          {factRow}
          <Box flexGrow={1} minWidth={GAP} />
          {ctrlRow}
        </Box>
      ) : (
        [factRow, ctrlRow]
      )}
      {menu}
    </Box>
  )
}

/**
 * Cells the caller's controls beside the band take (the close control, and the terminal's effort
 * button `e: Effort`), with the gap before them: what to take off the frame's columns.
 */
export function besideBand(frame: Frame): number {
  return isRich(frame) ? 5 : 2 + displayWidth('e: ' + t(frame.lang, 'band.effort')) + 2 + 1
}

/** The dashboard band, `frame.columns` being its own width (see besideBand). */
export function renderBand(el: Els, frame: Frame, view: DashboardView, actions: BandActions): RenderNode {
  return isRich(frame) && 'Svg' in el ? bandDrawn(el, frame, view, actions) : bandText(el, frame, view, actions)
}

// ---- Minimal: the footer -----------------------------------------------------------------------

export type FooterActions = Pick<BandActions, 'toggleAuto' | 'openSettings'> & Partial<Pick<BandActions, 'toggleFast'>>

/**
 * The minimal layout: one quiet line in the footer's mode area (SessionMode), the engine's own
 * modes kept beside it. `engine` is what `next(e)` drew there.
 */
export function renderFooter(el: Els, frame: Frame, view: DashboardView, actions: FooterActions, engine?: RenderChildren): RenderNode {
  const { Box, Text } = el
  const tone = textTone(frame.appearance)
  const { level, mode } = view.effort
  const idx = effortIndex(level)
  const effortText =
    mode === 'deciding' ? t(frame.lang, 'band.decidingText') : (idx >= 0 ? RIPPLE_CHAR[idx]! : '○') + ' ' + (level ? effortName(level, frame.lang).toLowerCase() : '—') + (mode === 'auto' ? '' : mode === 'paused' ? t(frame.lang, 'band.footerPaused') : mode === 'off' ? t(frame.lang, 'band.footerOff') : t(frame.lang, 'band.footerManual'))
  const left = view.cache ? view.cache.expiresAt - frame.now : 0
  const ctxTone = view.context ? contextTone(view.context.percent, view.swampAt) : 'ink'
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2} alignItems="center">
      <Text color={mode === 'deciding' || mode === 'auto' ? tone.accent : undefined} dimColor={mode === 'paused' || mode === 'off'}>
        {effortText}
      </Text>
      {view.mode ? <Text color={tone.accent}>{t(frame.lang, 'band.mode') + ' ' + modeLabel(view.mode)}</Text> : null}
      {view.context && view.extras.includes('context') ? (
        <Text dimColor color={ctxTone === 'ink' ? undefined : ctxTone === 'warn' ? WARN : BAD}>
          {t(frame.lang, 'band.footerContext', { percent: Math.round(view.context.percent) })}
        </Text>
      ) : null}
      {view.cache && !view.hide.includes('timer') ? <Text dimColor>{'⧗ ' + minutesLeft(left, frame.lang) + (view.warm.on ? ' ≈' : '')}</Text> : null}
      {view.limit && view.extras.includes('limits') ? <Text dimColor>{limitName(view.limit.kind, frame.lang) + ' ' + Math.round(view.limit.percent) + '%'}</Text> : null}
      {textButton(el, 'auto', t(frame.lang, 'band.auto') + (view.auto ? ' ●' : ' ○'), actions.toggleAuto)}
      {view.fast && actions.toggleFast ? textButton(el, 'fast', '⚡ ' + fastLabel(frame.lang, view.fast.state) + (view.fast.state === 'on' ? ' ●' : view.fast.state === 'off' ? ' ○' : ''), actions.toggleFast) : null}
      {textButton(el, 'settings', '⚙', actions.openSettings)}
      {engine ?? null}
    </Box>
  )
}
