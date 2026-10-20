// Global GPT Fast: the band's lightning, /ripple-fast, and how the mod treats the router's answers (GET/PUT /api/fast, no session in it).
// Only the router (http.fetch) and host boundaries are stubbed; the mod runs through the real engine.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { normalizeSettings } from '../hooks/settings'
import { STRINGS } from '../hooks/i18n'
import type { Lang } from '../hooks/i18n'
import type { Settings } from '../types'

const SESSION = 'session-test'
type FastMode = 'ok' | 'offline' | 'old' | 'html-fallback' | 'put500' | 'putWrongValue' | 'putWrongScope' | 'putOlder' | 'putLost'
const FAST_URL = 'http://127.0.0.1:9992/api/fast'

function world(on: On, patch: Partial<Settings> = {}) {
  const clock = mock.clock(on, { now: 1000000 })
  const toasts: string[] = []
  const urls: string[] = []
  const puts: unknown[] = []
  const gets: string[] = []
  const commands: string[] = []
  const opened: string[][] = []
  const w = {
    clock, toasts, urls, puts, gets, commands, opened,
    /** What session.id answers: a string, null (no id) or 'throw'. It must never matter to global Fast. */
    session: SESSION as string | null,
    mode: 'ok' as FastMode,
    server: { fast: null as boolean | null, revision: 0 },
    /** What a GET answers instead of the server's own snapshot (a slow or stale read). */
    reply: null as unknown,
    gate: null as Promise<void> | null,
    /** Holds a GET in flight (a read that began before a write). */
    getGate: null as Promise<void> | null,
    /** How a held GET ends: with its reply, or a failure. */
    getEnd: 'reply' as 'reply' | 'throw' | 'http500' | 'garbage',
    getHeld: 0,
    /** A one-shot hold on the next read of the gptFast atom: it answers what it read, but late. */
    barrier: { armed: false, hit: false, gate: null as Promise<void> | null },
    /** Serve an older version's per-session atom (the state upgrade test). */
    upgraded: false,
  }
  const ok = (body: unknown) => ({ value: { ok: true, status: 200, headers: {}, text: JSON.stringify(body) } })
  const fail = (status: number) => ({ value: { ok: false, status, headers: {}, text: '{}' } })
  on('http.fetch', async ($, e) => {
    urls.push(e.url)
    if (e.url.endsWith('/api/mod-settings')) return ok({ settings: normalizeSettings({ setupDone: true, ...patch }), revision: 1, stored: true })
    if (e.url.includes('/api/fast')) {
      if (w.mode === 'offline') throw new Error('router unavailable')
      if (w.mode === 'old') return fail(404)
      if (w.mode === 'html-fallback') return { value: { ok: true, status: 200, headers: { 'content-type': 'text/html' }, text: '<title>ClaudeRipple</title>' } }
      if ((e.init?.method ?? 'GET') === 'GET') {
        gets.push(e.url)
        const snapshot = w.reply ?? { scope: 'global', fast: w.server.fast, revision: w.server.revision }
        if (w.getGate) {
          ++w.getHeld
          await w.getGate
          if (w.getEnd === 'throw') throw new Error('read lost')
          if (w.getEnd === 'http500') return fail(500)
          if (w.getEnd === 'garbage') return { value: { ok: true, status: 200, headers: {}, text: 'not json' } }
        }
        return ok(snapshot)
      }
      const input = JSON.parse(e.init?.body ?? '{}')
      puts.push(input)
      if (w.gate) await w.gate
      if (w.mode === 'put500') return fail(500)
      if (w.mode === 'putWrongValue') return ok({ scope: 'global', fast: !input.fast, revision: w.server.revision + 1 })
      if (w.mode === 'putLost') {
        // The router stored it, then the answer never arrived.
        w.server = { fast: input.fast, revision: w.server.revision + 1 }
        throw new Error('connection reset')
      }
      if (w.mode === 'putOlder') return ok({ scope: 'global', fast: input.fast, revision: 2 })
      if (w.mode === 'putWrongScope') return ok({ scope: 'session', fast: input.fast, revision: w.server.revision + 1 })
      w.server = { fast: input.fast, revision: w.server.revision + 1 }
      return ok({ scope: 'global', ...w.server })
    }
    return ok({ requests: [] })
  })
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  mock.env(on, { HOME: '/home/test', LANG: 'en_US.UTF-8' })
  on('settings.read', () => ({ value: { language: undefined } }))
  on('session.cwd', () => ({ value: '/work' }))
  on('process.run', ($, e) => {
    if (e.argv[0] === 'xdg-open') opened.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.read', ($, e) => ({ value: e.path.endsWith('config.json') ? JSON.stringify({ admin: { port: 9992 } }) : '' }))
  on('session.start', () => ({ cwd: '/work' }))
  on('classic.SessionStart', () => ({}))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('agent.register', ($, e) => ({ value: { agent: 'ripple:' + e.name } }))
  on('command.list', () => ({ value: [] }))
  on('session.id', () => {
    if (w.session === 'throw') throw new Error('session id unavailable')
    return { value: w.session }
  })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.messages', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: 1000000, context: { percent: 20, tokens: 40000, window: 200000 }, rateLimits: [] } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['host drawing'] }))
  on('ui.panes', () => ({ value: [] }))
  on('state.get', { plugin: 'ripple', key: 'gptFast' }, async ($, e, next) => {
    if (!w.barrier.armed) return next(e)
    w.barrier.armed = false
    w.barrier.hit = true
    const result = await next(e)
    await w.barrier.gate
    return result
  })
  on('command.run', { command: 'fast' }, ($, e) => { commands.push('fast ' + e.args); return { text: '' } })
  return w
}
type World = ReturnType<typeof world>

async function start($: Engine) { await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true }) }
async function settle(w: World) { await w.clock.advance(3000) }
async function band($: Engine, surface: 'terminal' | 'desktop' | 'vscode' | 'mobile') {
  return $.ui.mount({ plugin: 'ripple', component: 'AbovePrompt', requestId: 'band', surface,
    viewport: { columns: 140, rows: 40 }, props: { hasSurvey: false, isWorking: false, bodyColumns: 130, maxRows: 20, scroll: { offset: 0, bodyRows: 20 }, view: {} } })
}
const run = ($: Engine, args: string) => $.command.run({ command: 'ripple-fast', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 } })
type Mounted = Awaited<ReturnType<typeof band>>
/** The control's label (terminal) or picture alt (desktop). */
async function shown(ui: Mounted, surface: string): Promise<string | undefined> {
  if (surface === 'desktop' || surface === 'vscode') return (await ui.findAll({ type: 'Svg' })).map(s => s.props.alt as string).find(alt => typeof alt === 'string' && alt.startsWith('GPT Fast'))
  const button = await ui.find({ type: 'Button', key: 'fast' })
  return typeof button?.props.label === 'string' ? button.props.label : undefined
}

for (const surface of ['terminal', 'mobile', 'desktop', 'vscode'] as const) {
  test('GPT Fast control shows Auto, ON, OFF and writes the global setting on ' + surface, async ($, on) => {
    const w = world(on)
    await start($)
    await settle(w)
    const ui = await band($, surface)
    const rich = surface === 'desktop' || surface === 'vscode'
    expect(await shown(ui, surface)).toContain('GPT Fast Auto')
    expect(await ui.find({ type: 'Button', key: 'fast' })).toBeDefined()
    if (rich) expect(await ui.find({ type: 'Text', text: /^GPT Fast Auto · Applies globally to all current and new sessions.*Anthropic extra usage/ })).toBeDefined()
    // Auto -> ON -> OFF -> ON, each only after the router's own answer.
    await ui.press({ key: 'fast' })
    expect(await shown(ui, surface)).toContain('GPT Fast ON')
    await ui.press({ key: 'fast' })
    expect(await shown(ui, surface)).toContain('GPT Fast OFF')
    await ui.press({ key: 'fast' })
    expect(await shown(ui, surface)).toContain('GPT Fast ON')
    expect(w.puts).toEqual([{ fast: true }, { fast: false }, { fast: true }])
    expect(w.gets.length).toBeGreaterThan(0)
    expect(w.gets.every(url => url === FAST_URL)).toBe(true)
    // The setting is the router's: a poll shows what it holds, and the mod writes nothing by itself.
    w.server = { fast: false, revision: 9 }
    await settle(w)
    expect(await shown(ui, surface)).toContain('GPT Fast OFF')
    await settle(w)
    expect(w.puts.length).toBe(3)
    await ui.unmount()
  })
}

test('the minimal footer carries the lightning', async ($, on) => {
  const w = world(on, { layout: 'minimal' })
  await start($)
  await settle(w)
  const footer = await $.ui.mount({ plugin: 'ripple', component: 'SessionMode', requestId: 'footer', surface: 'terminal', props: { modes: ['plan'] }, viewport: { columns: 140, rows: 40 } })
  expect((await footer.find({ type: 'Button', key: 'fast' }))?.props.label).toContain('GPT Fast Auto')
  await footer.press({ key: 'fast' })
  expect((await footer.find({ type: 'Button', key: 'fast' }))?.props.label).toContain('GPT Fast ON')
  expect(w.puts).toEqual([{ fast: true }])
})

test('/ripple-fast sets on, off and auto, reports its scope, and rejects other words', async ($, on) => {
  const w = world(on)
  await start($)
  await settle(w)
  expect((await run($, 'on')).text).toContain('GPT Fast ON')
  expect(w.server.fast).toBe(true)
  expect((await run($, ' OFF ')).text).toContain('GPT Fast OFF')
  expect(w.server.fast).toBe(false)
  expect((await run($, 'auto')).text).toContain('GPT Fast Auto')
  expect(w.server.fast).toBe(null)
  expect(w.puts).toEqual([{ fast: true }, { fast: false }, { fast: null }])
  expect((await run($, 'fast')).text).toContain('/ripple-fast')
  expect(w.puts.length).toBe(3)
  const status = (await run($, '')).text ?? ''
  expect(status).toContain('GPT Fast Auto')
  expect(status).toContain('more of your ChatGPT plan usage')
  expect(status).toContain('not Anthropic /fast')
  expect(status).toContain('all current and new sessions')
  expect(status).not.toContain('session ID')
  // The command works before the first poll has answered.
  w.mode = 'put500'
  expect((await run($, 'on')).text).toContain('could not be saved or confirmed')
  expect(w.server.fast).toBe(null)
})

test('a failed write reads unavailable until the router is asked again, and says so', async ($, on) => {
  const w = world(on)
  await start($)
  await settle(w)
  const ui = await band($, 'terminal')
  await ui.press({ key: 'fast' })
  expect(await shown(ui, 'terminal')).toContain('GPT Fast ON')
  for (const mode of ['put500', 'putWrongValue'] as const) {
    w.mode = mode
    await ui.press({ key: 'fast' })
    // The value held is kept, but nothing unconfirmed is drawn as the router's; a read brings it back.
    expect(await shown(ui, 'terminal')).toContain('GPT Fast unavailable')
    await settle(w)
    expect(await shown(ui, 'terminal')).toContain('GPT Fast ON')
  }
  expect(w.toasts.filter(text => /^ClaudeRipple: GPT Fast could not be saved or confirmed/.test(text)).length).toBe(2)
  expect(w.toasts.at(-1)).toContain('router answered another value')
  expect(w.server.fast).toBe(true)
  w.mode = 'ok'
  await ui.press({ key: 'fast' })
  expect(await shown(ui, 'terminal')).toContain('GPT Fast OFF')
})

test('a write whose answer is lost is uncertain, and the next read finds what the router saved', async ($, on) => {
  const w = world(on)
  await start($)
  await settle(w)
  const ui = await band($, 'terminal')
  expect(await shown(ui, 'terminal')).toContain('GPT Fast Auto')
  w.mode = 'putLost'
  await ui.press({ key: 'fast' })
  expect(w.puts).toEqual([{ fast: true }])
  expect(w.server.fast).toBe(true)
  expect(await shown(ui, 'terminal')).toContain('GPT Fast unavailable')
  expect(w.toasts.at(-1)).toMatch(/^ClaudeRipple: GPT Fast could not be saved or confirmed/)
  expect((await run($, 'off')).text).toContain('could not be saved or confirmed')
  w.server = { fast: true, revision: w.server.revision }
  w.mode = 'ok'
  await settle(w)
  expect(await shown(ui, 'terminal')).toContain('GPT Fast ON')
})

test('a failed read that is still marking Fast down cannot undo a write acknowledged meanwhile', async ($, on) => {
  const w = world(on)
  await start($)
  await settle(w)
  const ui = await band($, 'terminal')
  expect(await shown(ui, 'terminal')).toContain('GPT Fast Auto')
  let endRead: () => void = () => undefined
  let endState: () => void = () => undefined
  w.getEnd = 'throw'
  w.getGate = new Promise<void>(resolve => { endRead = resolve })
  w.barrier.gate = new Promise<void>(resolve => { endState = resolve })
  const polling = w.clock.advance(3000)
  for (let i = 0; i < 200 && w.getHeld === 0; i++) await new Promise(resolve => setTimeout(resolve, 5))
  expect(w.getHeld).toBe(1)
  // The read fails; the state read it makes to mark Fast down is held, answering with the value from before the write.
  w.barrier.armed = true
  endRead()
  for (let i = 0; i < 200 && !w.barrier.hit; i++) await new Promise(resolve => setTimeout(resolve, 5))
  expect(w.barrier.hit).toBe(true)
  // Meanwhile a write is acknowledged.
  await ui.press({ key: 'fast' })
  expect(await shown(ui, 'terminal')).toContain('GPT Fast ON')
  // The old state read comes back late: its update must find the epoch moved on.
  endState()
  await polling
  w.getGate = null
  expect(await shown(ui, 'terminal')).toContain('GPT Fast ON')
  await settle(w)
  expect(await shown(ui, 'terminal')).toContain('GPT Fast ON')
  expect(w.puts).toEqual([{ fast: true }])
  expect(w.toasts).toEqual([])
})

for (const mode of ['offline', 'old', 'html-fallback'] as const) {
  test('an ' + mode + ' router reads unavailable, never ON or OFF, and recovers', async ($, on) => {
    const w = world(on)
    w.mode = mode
    await start($)
    await settle(w)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await band($, surface)
      const label = await shown(ui, surface)
      expect(label).toContain('GPT Fast unavailable')
      expect(label).not.toMatch(/ON|OFF|Auto/)
      await ui.press({ key: 'fast' })
      await ui.unmount()
    }
    expect(w.puts.length).toBe(0)
    expect(w.toasts.filter(text => text.includes('GPT Fast is unavailable')).length).toBe(2)
    w.mode = 'ok'
    w.server = { fast: true, revision: 4 }
    await settle(w)
    const ui = await band($, 'terminal')
    expect(await shown(ui, 'terminal')).toContain('GPT Fast ON')
    // It goes unavailable again rather than keeping a value the router can no longer confirm.
    w.mode = mode
    await settle(w)
    expect(await shown(ui, 'terminal')).toContain('GPT Fast unavailable')
  })
}

test('a snapshot that does not validate reads unavailable', async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await band($, 'terminal')
  for (const bad of [
    { scope: 'session', fast: true, revision: 1 }, { scope: 'someone-else', fast: true, revision: 1 }, { fast: true, revision: 1 }, { session: SESSION, fast: true, revision: 1 },
    { scope: null, fast: true, revision: 1 }, { scope: 'GLOBAL', fast: true, revision: 1 },
    { scope: 'global', fast: 'yes', revision: 1 }, { scope: 'global', fast: true, revision: -1 }, { scope: 'global', fast: true, revision: 1.5 }, { scope: 'global', fast: true },
  ]) {
    w.reply = bad
    await settle(w)
    expect(await shown(ui, 'terminal')).toContain('GPT Fast unavailable')
  }
})

test('a second press while a write is out does nothing, and the busy state is shown', async ($, on) => {
  const w = world(on)
  await start($)
  await settle(w)
  const ui = await band($, 'desktop')
  let release: () => void = () => undefined
  w.gate = new Promise<void>(resolve => { release = resolve })
  const first = ui.press({ key: 'fast' })
  const second = ui.press({ key: 'fast' })
  await w.clock.advance(1)
  expect(await ui.find({ type: 'Text', text: /^GPT Fast Auto \(saving…\) · / })).toBeDefined()
  release()
  await Promise.all([first, second])
  w.gate = null
  expect(w.puts).toEqual([{ fast: true }])
  expect(await shown(ui, 'desktop')).toContain('GPT Fast ON')
})

test('polls older than what the router acknowledged are ignored, newer ones taken', async ($, on) => {
  const w = world(on)
  await start($)
  await settle(w)
  const ui = await band($, 'terminal')
  await ui.press({ key: 'fast' })
  expect(w.server.revision).toBe(1)
  // A read that began before the write answers late with the old snapshot.
  w.reply = { scope: 'global', fast: null, revision: 0 }
  await settle(w)
  expect(await shown(ui, 'terminal')).toContain('GPT Fast ON')
  w.reply = { scope: 'global', fast: false, revision: 7 }
  await settle(w)
  expect(await shown(ui, 'terminal')).toContain('GPT Fast OFF')
  w.reply = { scope: 'global', fast: true, revision: 6 }
  await settle(w)
  expect(await shown(ui, 'terminal')).toContain('GPT Fast OFF')
  // The press toggles from what the router said last: OFF -> ON.
  w.reply = null
  w.server = { fast: false, revision: 7 }
  await ui.press({ key: 'fast' })
  expect(w.puts.at(-1)).toEqual({ fast: true })
})

test('no native fast, billing or settings call is ever made', async ($, on) => {
  const w = world(on)
  await start($)
  await settle(w)
  const ui = await band($, 'desktop')
  await ui.press({ key: 'fast' })
  await ui.press({ key: 'fast' })
  await run($, 'auto')
  await settle(w)
  expect(w.commands).toEqual([])
  const fastUrls = w.urls.filter(url => /fast|billing|extra|credit/i.test(url))
  expect(fastUrls.length).toBeGreaterThan(0)
  expect(fastUrls.every(url => url === FAST_URL)).toBe(true)
  expect(w.urls.every(url => url.startsWith('http://127.0.0.1:9992/'))).toBe(true)
  expect(w.urls.some(url => /session-fast|[?&]session=/.test(url) && /fast/.test(url))).toBe(false)
})

test('every language names the control, its scope and its failures', async ($, on) => {
  for (const lang of ['ko', 'en', 'zh', 'ja', 'es', 'pt'] as Lang[]) {
    for (const key of ['fast.auto', 'fast.on', 'fast.off', 'fast.unavailable', 'fast.scope', 'fast.hint', 'fast.downTip', 'toasts.fastFailed', 'toasts.fastUnavailable', 'commands.fastDone', 'commands.fastUsage', 'commands.fastDescription'] as const) {
      expect(STRINGS[lang][key], lang + ' ' + key).toBeTruthy()
    }
    expect(STRINGS[lang]['fast.auto']).toContain('GPT Fast')
    expect(STRINGS[lang]['fast.scope']).toContain('/fast')
    expect(STRINGS[lang]['toasts.fastFailed']).toContain('{reason}')
  }
  const w = world(on, { language: 'ko' })
  await start($)
  await settle(w)
  const ui = await band($, 'terminal')
  expect(await shown(ui, 'terminal')).toContain(STRINGS.ko['fast.auto'])
  expect((await run($, 'on')).text).toContain(STRINGS.ko['fast.on'])
})

test('an older GET never replaces a newer acknowledgement, after an unavailable spell', async ($, on) => {
  const w = world(on)
  await start($)
  await settle(w)
  const ui = await band($, 'terminal')
  await ui.press({ key: 'fast' })
  expect(w.server.revision).toBe(1)
  // Unavailable, then a late read with an older revision: still not taken as the router's truth over the ACK.
  w.mode = 'offline'
  await settle(w)
  expect(await shown(ui, 'terminal')).toContain('GPT Fast unavailable')
  w.mode = 'ok'
  w.reply = { scope: 'global', fast: null, revision: 0 }
  await settle(w)
  expect(await shown(ui, 'terminal')).not.toContain('GPT Fast Auto')
  w.reply = null
  await settle(w)
  expect(await shown(ui, 'terminal')).toContain('GPT Fast ON')
})

// Global Fast never depends on the session: its id may be missing, different or throwing, and may change under the bar.
for (const [label, session] of [['missing', null], ['throwing', 'throw'], ['empty', ''], ['different', 'another-session'], ['unsafe', 'a&b=c#x']] as const) {
  test('a ' + label + ' session id cannot prevent the global Fast toggle and commands', async ($, on) => {
    const w = world(on)
    w.session = session
    await start($)
    await settle(w)
    const ui = await band($, 'terminal')
    expect(await shown(ui, 'terminal')).toContain('GPT Fast Auto')
    await ui.press({ key: 'fast' })
    expect(await shown(ui, 'terminal')).toContain('GPT Fast ON')
    expect((await run($, 'off')).text).toContain('GPT Fast OFF')
    expect((await run($, 'on')).text).toContain('GPT Fast ON')
    expect((await run($, 'auto')).text).toContain('GPT Fast Auto')
    expect((await run($, '')).text).toContain('GPT Fast Auto')
    expect(w.puts).toEqual([{ fast: true }, { fast: false }, { fast: true }, { fast: null }])
    expect(w.server.fast).toBe(null)
    expect(w.gets.every(url => url === FAST_URL)).toBe(true)
    expect(w.toasts).toEqual([])
    await ui.unmount()
  })
}

test('the session id changing under the bar changes nothing about the global value', async ($, on) => {
  const w = world(on)
  await start($)
  await settle(w)
  const ui = await band($, 'terminal')
  await ui.press({ key: 'fast' })
  expect(await shown(ui, 'terminal')).toContain('GPT Fast ON')
  for (const next of ['session-two', null, 'throw', 'session-three'] as const) {
    w.session = next
    await settle(w)
    expect(await shown(ui, 'terminal')).toContain('GPT Fast ON')
  }
  await ui.press({ key: 'fast' })
  expect(await shown(ui, 'terminal')).toContain('GPT Fast OFF')
  expect(w.puts).toEqual([{ fast: true }, { fast: false }])
  expect(w.gets.every(url => url === FAST_URL)).toBe(true)
})

test('another bar changing the global value is adopted by every bar here, session notwithstanding', async ($, on) => {
  const w = world(on)
  await start($)
  await settle(w)
  const first = await band($, 'terminal')
  const second = await band($, 'desktop')
  expect(await shown(first, 'terminal')).toContain('GPT Fast Auto')
  // A bar of another session wrote it: the router now holds ON at a newer revision.
  w.server = { fast: true, revision: 5 }
  await settle(w)
  expect(await shown(first, 'terminal')).toContain('GPT Fast ON')
  expect(await shown(second, 'desktop')).toContain('GPT Fast ON')
  expect(w.puts).toEqual([])
  // A snapshot that names another session is still the one global value.
  w.reply = { scope: 'global', session: 'someone-else', fast: false, revision: 6 }
  await settle(w)
  expect(await shown(first, 'terminal')).toContain('GPT Fast OFF')
  expect(await shown(second, 'desktop')).toContain('GPT Fast OFF')
  // The next press here toggles from the adopted value and writes without a session.
  w.reply = null
  w.server = { fast: false, revision: 6 }
  await first.press({ key: 'fast' })
  expect(w.puts).toEqual([{ fast: true }])
  expect(await shown(second, 'desktop')).toContain('GPT Fast ON')
})

test('a write whose answer has another scope is not taken', async ($, on) => {
  const w = world(on)
  await start($)
  await settle(w)
  const ui = await band($, 'terminal')
  w.mode = 'putWrongScope'
  await ui.press({ key: 'fast' })
  expect(await shown(ui, 'terminal')).toContain('GPT Fast unavailable')
  expect(w.toasts.at(-1)).toMatch(/^ClaudeRipple: GPT Fast could not be saved or confirmed/)
  expect((await run($, 'on')).text).toContain('could not be saved or confirmed')
  w.mode = 'ok'
  await settle(w)
  expect(await shown(ui, 'terminal')).toContain('GPT Fast Auto')
  await ui.press({ key: 'fast' })
  expect(await shown(ui, 'terminal')).toContain('GPT Fast ON')
})

test('a write acknowledged at an older revision than the one held is reported, not taken', async ($, on) => {
  const w = world(on)
  await start($)
  await settle(w)
  const ui = await band($, 'terminal')
  w.server = { fast: false, revision: 7 }
  await settle(w)
  expect(await shown(ui, 'terminal')).toContain('GPT Fast OFF')
  w.mode = 'putOlder'
  await ui.press({ key: 'fast' })
  expect(w.puts).toEqual([{ fast: true }])
  expect(await shown(ui, 'terminal')).toContain('GPT Fast unavailable')
  expect(w.toasts.at(-1)).toMatch(/^ClaudeRipple: GPT Fast could not be saved or confirmed/)
  expect(w.toasts.at(-1)).toContain('older revision')
  expect((await run($, 'on')).text).toContain('could not be saved or confirmed')
  w.mode = 'ok'
  w.server = { fast: false, revision: 7 }
  await settle(w)
  expect(await shown(ui, 'terminal')).toContain('GPT Fast OFF')
  await ui.press({ key: 'fast' })
  expect(await shown(ui, 'terminal')).toContain('GPT Fast ON')
})

test('a per-session Fast state left by an older version is never reused as the global one', async ($, on) => {
  const w = world(on)
  // What the previous version kept in this session's atom: a session-scoped acknowledgement at a high revision.
  const old = { status: 'ready', scope: 'session', value: true, revision: 9, writing: false }
  on('state.get', { plugin: 'ripple', key: 'gptFast' }, ($$, e, next) => w.upgraded ? { value: { value: old, version: 0 } } : next(e))
  on('state.set', { plugin: 'ripple', key: 'gptFast' }, async ($$, e, next) => { const result = await next(e); w.upgraded = false; return result })
  w.upgraded = true
  await start($)
  const ui = await band($, 'terminal')
  // Before the router has answered, the old ON is not shown and a press asks the router instead of toggling it.
  expect(await shown(ui, 'terminal')).toContain('GPT Fast unavailable')
  await ui.press({ key: 'fast' })
  expect(w.puts).toEqual([])
  // The router's global snapshot replaces it even at a lower revision than the old one carried.
  w.server = { fast: null, revision: 2 }
  await settle(w)
  expect(await shown(ui, 'terminal')).toContain('GPT Fast Auto')
  await ui.press({ key: 'fast' })
  expect(w.puts).toEqual([{ fast: true }])
  expect(await shown(ui, 'terminal')).toContain('GPT Fast ON')
})

for (const ending of ['throw', 'http500', 'garbage'] as const) {
  test('a read that fails (' + ending + ') after a write succeeded is ignored', async ($, on) => {
    const w = world(on)
    await start($)
    await settle(w)
    const ui = await band($, 'terminal')
    expect(await shown(ui, 'terminal')).toContain('GPT Fast Auto')
    // A poll begins and is held in flight; a write is acknowledged meanwhile; only then does the read fail.
    let end: () => void = () => undefined
    w.getEnd = ending
    w.getGate = new Promise<void>(resolve => { end = resolve })
    const toasts = w.toasts.length
    const polling = w.clock.advance(3000)
    for (let i = 0; i < 200 && w.getHeld === 0; i++) await new Promise(resolve => setTimeout(resolve, 5))
    expect(w.getHeld).toBe(1)
    await ui.press({ key: 'fast' })
    expect(await shown(ui, 'terminal')).toContain('GPT Fast ON')
    end()
    await polling
    w.getGate = null
    expect(await shown(ui, 'terminal')).toContain('GPT Fast ON')
    expect(w.puts).toEqual([{ fast: true }])
    expect(w.toasts.length).toBe(toasts)
    // The next ordinary poll still works.
    w.server = { fast: false, revision: 4 }
    await settle(w)
    expect(await shown(ui, 'terminal')).toContain('GPT Fast OFF')
  })
}

test('a read that fails with no write in between still reads unavailable', async ($, on) => {
  const w = world(on)
  await start($)
  await settle(w)
  const ui = await band($, 'terminal')
  expect(await shown(ui, 'terminal')).toContain('GPT Fast Auto')
  let end: () => void = () => undefined
  w.getEnd = 'throw'
  w.getGate = new Promise<void>(resolve => { end = resolve })
  const polling = w.clock.advance(3000)
  for (let i = 0; i < 200 && w.getHeld === 0; i++) await new Promise(resolve => setTimeout(resolve, 5))
  end()
  await polling
  w.getGate = null
  expect(await shown(ui, 'terminal')).toContain('GPT Fast unavailable')
})

// The band's All settings link opens the plain dashboard (#mod): Fast is global, so no session rides on it.
async function openSettings($: Engine, w: World) {
  await start($)
  await settle(w)
  await $.command.run({ command: 'ripple', args: 'settings', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 } })
  const ui = await band($, 'terminal')
  await ui.press({ key: 'all-settings' })
  await ui.unmount()
}

test('all settings opens the plain dashboard link', async ($, on) => {
  const w = world(on)
  await openSettings($, w)
  expect(w.opened).toEqual([['xdg-open', 'http://127.0.0.1:9992/#mod']])
  expect(w.toasts).toEqual([])
})

for (const [label, session] of [
  ['valid', 'Abc_123-xyz'], ['missing', null], ['throwing', 'throw'], ['empty', ''], ['with a query separator', 'a&b=c'], ['with a space', 'a b'],
  ['with a slash', '../x'], ['with a fragment', 'a#b'], ['non-ASCII', 'sessión'], ['over the router length limit', 'a'.repeat(129)],
] as const) {
  test('all settings carries no session for a ' + label + ' session id', async ($, on) => {
    const w = world(on)
    w.session = session
    await openSettings($, w)
    expect(w.opened).toEqual([['xdg-open', 'http://127.0.0.1:9992/#mod']])
  })
}
