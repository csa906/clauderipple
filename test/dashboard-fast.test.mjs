import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { startAdmin } from '../dist/router/src/admin.js';

// The dashboard ships as a browser script. Run the real "GPT Fast" section (and the helpers it calls)
// inside a vm context against a small in-memory DOM, a scripted fetch and a controllable timeout.
// Fast is ONE global value: the card has no session selector and never reads a session from the URL.
const app = fs.readFileSync(new URL('../dist/ui/app.js', import.meta.url), 'utf8');
const i18n = fs.readFileSync(new URL('../dist/ui/i18n.js', import.meta.url), 'utf8');
const indexHtml = fs.readFileSync(new URL('../dist/ui/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../dist/ui/style.css', import.meta.url), 'utf8');
function section(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `missing source section: ${start}`);
  return source.slice(a, b);
}
const fastSource = section(app, '// ---- GPT Fast', '// ---- Saving');

class Element {
  constructor(tag, doc) {
    this.tag = tag; this.doc = doc; this.children = []; this.attrs = {}; this.events = {}; this.dataset = {};
    this.className = ''; this.textContent = ''; this.value = ''; this.disabled = false; this.checked = false; this.parentNode = null;
    const self = this;
    this.classList = {
      toggle(name, on) { const set = new Set(self.className.split(' ').filter(Boolean)); (on ?? !set.has(name)) ? set.add(name) : set.delete(name); self.className = [...set].join(' '); },
      add(name) { this.toggle(name, true); }, remove(name) { this.toggle(name, false); },
      contains(name) { return self.className.split(' ').includes(name); },
    };
  }
  setAttribute(key, value) {
    value = String(value);
    this.attrs[key] = value;
    if (key === 'id') this.id = value;
    else if (key === 'value') this.value = value;
    else if (key === 'disabled') this.disabled = true;
    else if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = value;
  }
  addEventListener(type, fn) { (this.events[type] ||= []).push(fn); }
  dispatch(type, event = {}) { for (const fn of this.events[type] || []) fn({ preventDefault() {}, ...event }); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  append(...children) { for (const child of children) this.appendChild(child); }
  replaceChildren(...children) {
    for (const child of this.children) {
      if (child.contains(this.doc.activeElement)) this.doc.activeElement = this.doc.body;
      child.parentNode = null;
    }
    this.children = []; this.append(...children);
  }
  get firstChild() { return this.children[0] ?? null; }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  focus() { if (!this.disabled) this.doc.activeElement = this; }
  *walk() { for (const child of this.children) { yield child; yield* child.walk(); } }
  matches(selector) {
    selector = selector.trim();
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    const data = /^\[data-key="(.*)"\]$/.exec(selector);
    if (data) return this.dataset.key === data[1].replace(/\\(.)/g, '$1');
    throw new Error(`unsupported selector ${selector}`);
  }
  querySelector(selector) { for (const node of this.walk()) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) { const parts = selector.split(','); return [...this.walk()].filter(node => parts.some(part => node.matches(part))); }
}

/**
 * One dashboard tab. `fetch` is scripted: every call is recorded and stays pending until the test
 * replies, fails or times it out. Pass `server` to send the calls to a real admin instead.
 * `search` is the tab's own query string; it must never matter to the Fast card.
 */
function dashboard({ search = '', hash = '#mod', server } = {}) {
  const doc = { activeElement: null, hidden: false, events: {} };
  const body = new Element('body', doc);
  Object.assign(doc, {
    body,
    createElement: tag => new Element(tag, doc),
    createTextNode: text => Object.assign(new Element('#text', doc), { textContent: String(text) }),
    querySelector: selector => body.querySelector(selector),
    querySelectorAll: selector => body.querySelectorAll(selector),
    addEventListener: (type, fn) => { (doc.events[type] ||= []).push(fn); },
  });
  body.appendChild(Object.assign(new Element('div', doc), { id: 'mod-fast' }));
  const location = { href: `http://127.0.0.1:8791/${search}${hash}`, search, hash };
  const calls = [], timeouts = [], toasts = [], intervals = [], windowEvents = {};
  function scripted(url, opts = {}) {
    return new Promise((resolve, reject) => {
      const call = {
        url, opts, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined, settled: false,
        reply(value, status = 200) { call.settled = true; resolve(new Response(value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value), { status })); },
        fail(error = new TypeError('fetch failed')) { call.settled = true; reject(error); },
        timeout() { const t = timeouts.find(entry => entry.signal === opts.signal); assert.ok(t, 'request has no timeout signal'); t.controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')); },
      };
      opts.signal?.addEventListener('abort', () => { call.settled = true; reject(opts.signal.reason); });
      calls.push(call);
    });
  }
  const ctx = vm.createContext({
    Node: Element, document: doc, location, URL, URLSearchParams, Response, DOMException, console,
    history: { replaceState() { throw new Error('the Fast card must not touch the URL'); } },
    window: { addEventListener: (type, fn) => { (windowEvents[type] ||= []).push(fn); } },
    CSS: { escape: value => String(value).replace(/["\\]/g, '\\$&') },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    AbortSignal: server ? AbortSignal : { timeout(ms) { const controller = new AbortController(); timeouts.push({ ms, controller, signal: controller.signal }); return controller.signal; } },
    fetch: server ? (url, opts = {}) => fetch(server + url, { ...opts, headers: { ...(opts.headers || {}), connection: 'close' } }) : scripted,
    toast: (message, isError) => toasts.push({ message, isError }),
    lang: 'en',
  });
  const run = code => vm.runInContext(code, ctx);
  run(section(i18n, 'const I18N =', 'const LANGUAGES ='));
  run('function t(key, vars) { let value = I18N[lang][key] ?? I18N.en[key] ?? key; for (const [k, v] of Object.entries(vars || {})) value = value.replaceAll("{" + k + "}", String(v)); return value; }');
  run(section(app, 'function $(sel', 'let toastTimer ='));
  run(section(app, 'async function api(', '// The router writes'));
  run(section(app, '/** One row of an inset group', '/** A titled group'));
  run(section(app, '/** Rebuild a region in place', '// ---- GPT Fast'));
  run(fastSource);
  const $ = selector => body.querySelector(selector);
  const view = {
    ctx, run, calls, timeouts, toasts, intervals, windowEvents, doc, location,
    t: key => run(`t(${JSON.stringify(key)})`),
    state: () => JSON.parse(run('JSON.stringify(modFast)')),
    mount: () => run('modFastMount()'),
    poll: () => run('modFastPoll()'),
    write: value => run(`modFastWrite(${JSON.stringify(value)})`),
    control: () => $('#mod-fast-control'),
    buttons: () => $('#mod-fast-control').children[0].children,
    button: label => view.buttons().find(b => b.textContent === label),
    click: label => view.button(label).dispatch('click'),
    selected: () => view.buttons().find(b => b.attrs['aria-checked'] === 'true')?.textContent ?? null,
    enabled: () => view.buttons().filter(b => !b.disabled).map(b => b.textContent),
    status: () => $('#mod-fast-status').textContent,
    statusBad: () => $('#mod-fast-status').classList.contains('bad-text'),
    reads: () => calls.filter(c => c.method === 'GET'),
    writes: () => calls.filter(c => c.method === 'PUT'),
    lastRead: () => view.reads().at(-1),
    lastWrite: () => view.writes().at(-1),
  };
  return view;
}
async function settle() { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); }
const G = (fast, revision) => ({ scope: 'global', fast, revision });
/** Mounted and synced to the given global server state. */
async function ready(fast, revision, options = {}) {
  const view = dashboard(options);
  view.mount();
  view.lastRead().reply(G(fast, revision));
  await settle();
  assert.equal(view.state().status, 'ready');
  return view;
}
const LABEL = { true: 'ON', false: 'OFF', null: 'Auto' };

// ---- Shape: one global card, no session UI -----------------------------------------------------

test('the card has no session selector, recent list or session wording left anywhere', () => {
  assert.doesNotMatch(fastSource, /\b(?:modFastSession|modFastSelect|modFastRecent|modFastValidSession|mod-fast-session|mod-fast-recent|mod-fast-use|mod-fast-selected|api\/session-fast|api\/requests)\b/);
  assert.doesNotMatch(fastSource, /URLSearchParams|history\.replaceState|\?session=|location\.search/);
  assert.doesNotMatch(css, /#mod-fast \.text-field|#mod-fast-recent/);
  assert.match(indexHtml, /id="mod-fast"/);
  for (const key of ['session', 'use', 'selected', 'noSession', 'recent', 'choose', 'invalidSession']) {
    assert.ok(!new RegExp(`"mod\\.fast\\.${key}"`).test(i18n), `dead i18n key mod.fast.${key}`);
    assert.ok(!app.includes(`mod.fast.${key}"`), `dead key still used: mod.fast.${key}`);
  }
});

test('every key the card uses exists in ko and en, and both describe all sessions', () => {
  const view = dashboard();
  const keys = [...new Set([...fastSource.matchAll(/t\("(mod\.fast\.[\w.]+)"\)/g)].map(m => m[1]))];
  assert.ok(keys.length >= 6);
  for (const lang of ['ko', 'en']) {
    view.run(`lang = ${JSON.stringify(lang)}`);
    for (const key of keys) assert.ok(view.run(`I18N[lang][${JSON.stringify(key)}]`), `${lang} lacks ${key}`);
  }
  view.run('lang = "ko"');
  assert.match(view.t('mod.fast.title'), /전체 세션/);
  assert.doesNotMatch(view.t('mod.fast.title') + view.t('mod.fast.blurb') + view.t('mod.fast.scope'), /세션별/);
  view.run('lang = "en"');
  assert.match(view.t('mod.fast.title'), /all sessions/);
  assert.doesNotMatch(view.t('mod.fast.title') + view.t('mod.fast.blurb'), /per session/i);
});

test('the mounted card contains only the Auto/ON/OFF control and a status line', () => {
  const view = dashboard({ search: '?session=whatever' });
  view.mount();
  const ids = [...view.doc.body.walk()].map(n => n.id).filter(Boolean);
  assert.ok(ids.includes('mod-fast-control') && ids.includes('mod-fast-status'));
  assert.ok(![...view.doc.body.walk()].some(n => n.tag === 'input' || n.tag === 'select' || n.tag === 'form'));
  assert.equal(view.control().attrs.tabindex, '-1');
});

// ---- Reading -----------------------------------------------------------------------------------

test('mount reads the global /api/fast value, uncached, with a 5s timeout and no session anywhere', async () => {
  const view = dashboard({ search: '?session=ignored-1' });
  view.mount();
  assert.equal(view.reads().length, 1);
  const read = view.lastRead();
  assert.equal(read.url, '/api/fast');
  assert.equal(read.opts.cache, 'no-store');
  assert.deepEqual(view.timeouts.map(t => t.ms), [5000]);
  assert.equal(view.selected(), null, 'nothing is shown as chosen before the router answers');
  assert.deepEqual(view.enabled(), []);
  assert.equal(view.status(), view.t('mod.fast.loading'));
  read.reply(G(true, 4));
  await settle();
  assert.equal(view.selected(), 'ON');
  assert.deepEqual(view.enabled(), ['Auto', 'ON', 'OFF']);
  assert.equal(view.status(), view.t('mod.fast.synced'));
  assert.deepEqual(view.state(), { value: true, revision: 4, status: 'ready', writing: false, error: '' });
});

for (const fast of [true, false, null]) {
  test(`server value ${fast} is shown as ${LABEL[fast]}`, async () => {
    const view = await ready(fast, 1);
    assert.equal(view.selected(), LABEL[fast]);
  });
}

test('a missing, different or invalid session in the URL never changes the request or the result', async () => {
  for (const search of ['', '?session=a', '?session=b', '?session=a%20b', `?session=${'x'.repeat(300)}`]) {
    const view = dashboard({ search });
    view.mount();
    assert.equal(view.lastRead().url, '/api/fast');
    view.lastRead().reply(G(false, 2));
    await settle();
    assert.equal(view.selected(), 'OFF');
    assert.equal(view.statusBad(), false);
    view.click('ON');
    assert.deepEqual(view.lastWrite().body, { fast: true });
    assert.equal(view.location.search, search);
  }
});

// ---- Writing -----------------------------------------------------------------------------------

test('each click PUTs only {fast} and shows the value only after the router acknowledges it', async () => {
  const view = await ready(null, 0);
  let revision = 0, shown = 'Auto';
  for (const target of [true, false, null, false, true]) {
    view.click(LABEL[target]);
    const put = view.lastWrite();
    assert.equal(put.url, '/api/fast');
    assert.equal(put.opts.headers['content-type'], 'application/json');
    assert.deepEqual(put.body, { fast: target });
    assert.deepEqual(Object.keys(put.body), ['fast']);
    assert.ok(view.timeouts.some(t => t.signal === put.opts.signal && t.ms === 5000));
    // Not optimistic: still the acknowledged value, everything locked, "Saving…".
    assert.equal(view.selected(), shown);
    assert.deepEqual(view.enabled(), []);
    assert.equal(view.status(), view.t('slots.saving'));
    put.reply(G(target, ++revision));
    await settle();
    shown = LABEL[target];
    assert.equal(view.selected(), shown);
    assert.equal(view.state().revision, revision);
    assert.equal(view.status(), view.t('mod.fast.synced'));
  }
  assert.equal(view.writes().length, 5);
});

test('clicking the already-acknowledged value sends nothing', async () => {
  const view = await ready(true, 3);
  view.click('ON');
  assert.equal(view.writes().length, 0);
});

test('acknowledge-only: a reply naming a different value is not adopted and leaves the state unknown', async () => {
  const view = await ready(false, 2);
  view.click('ON');
  view.lastWrite().reply(G(null, 3));
  await settle();
  const state = view.state();
  assert.equal(state.value, false);
  assert.equal(state.revision, 2);
  assert.equal(state.status, 'unavailable');
  assert.equal(state.writing, false);
  assert.match(view.status(), /valid global Fast state/);
  assert.ok(view.statusBad());
  assert.equal(view.selected(), null);
  assert.deepEqual(view.enabled(), []);
});

test('a router error is never shown as saved, and the next poll re-reads the real value', async () => {
  const view = await ready(false, 2);
  view.click('ON');
  view.lastWrite().reply({ error: 'fixture disk failure' }, 500);
  await settle();
  assert.equal(view.state().value, false);
  assert.equal(view.state().status, 'unavailable');
  assert.ok(view.status().startsWith(view.t('common.saveFailed')));
  assert.match(view.status(), /fixture disk failure/);
  assert.deepEqual(view.enabled(), []);
  view.poll();
  assert.equal(view.reads().length, 2);
  view.lastRead().reply(G(false, 2));
  await settle();
  assert.equal(view.selected(), 'OFF');
  assert.equal(view.status(), view.t('mod.fast.synced'));
  assert.equal(view.statusBad(), false);
});

test('double writes: a second click, direct call or poll while saving does nothing', async () => {
  const view = await ready(null, 0);
  view.click('ON');
  view.click('OFF');            // disabled in a browser; the guard must hold anyway
  view.write(false);
  view.poll();
  assert.equal(view.writes().length, 1);
  assert.equal(view.reads().length, 1);
  view.lastWrite().reply(G(true, 1));
  await settle();
  assert.equal(view.selected(), 'ON');
  view.click('OFF');
  assert.equal(view.writes().length, 2, 'writing is possible again once the first is acknowledged');
});

// ---- Stale reads around a write ---------------------------------------------------------------

test('a read started before a write cannot overwrite its acknowledgement (read lands after the ack)', async () => {
  const view = await ready(false, 1);
  view.poll();
  const staleRead = view.lastRead();
  view.click('ON');
  view.lastWrite().reply(G(true, 2));
  await settle();
  staleRead.reply(G(false, 1));
  await settle();
  assert.equal(view.selected(), 'ON');
  assert.deepEqual({ value: view.state().value, revision: view.state().revision, status: view.state().status }, { value: true, revision: 2, status: 'ready' });
});

test('a read started before a write that lands while it is saving is ignored', async () => {
  const view = await ready(false, 1);
  view.poll();
  const staleRead = view.lastRead();
  view.click('ON');
  staleRead.reply(G(null, 1));
  await settle();
  assert.equal(view.state().writing, true);
  assert.equal(view.state().value, false);
  assert.equal(view.status(), view.t('slots.saving'));
  view.lastWrite().reply(G(true, 2));
  await settle();
  assert.equal(view.selected(), 'ON');
});

test('a read started before a write that fails (error or timeout) does not mark the write failed', async () => {
  for (const finish of [read => read.reply({ error: 'boom' }, 500), read => read.timeout(), read => read.fail()]) {
    const view = await ready(false, 1);
    view.poll();
    const staleRead = view.lastRead();
    view.click('ON');
    finish(staleRead);
    await settle();
    assert.equal(view.state().error, '');
    assert.equal(view.state().writing, true);
    assert.equal(view.status(), view.t('slots.saving'));
    view.lastWrite().reply(G(true, 2));
    await settle();
    assert.equal(view.state().status, 'ready');
    assert.equal(view.statusBad(), false);
    assert.equal(view.selected(), 'ON');
  }
});

test('after a write the next poll reads again (the cancelled read does not block polling)', async () => {
  const view = await ready(false, 1);
  view.poll();
  view.click('ON');
  view.lastWrite().reply(G(true, 2));
  await settle();
  view.poll();
  assert.equal(view.reads().length, 3);
});

// ---- Revision ordering and recovery -----------------------------------------------------------

test('reads never move the value back to an older revision; equal or newer revisions are taken', async () => {
  const view = await ready(true, 5);
  for (const [fast, revision, expected] of [[false, 3, 'ON'], [false, 5, 'OFF'], [true, 4, 'OFF'], [null, 7, 'Auto']]) {
    view.poll();
    view.lastRead().reply(G(fast, revision));
    await settle();
    assert.equal(view.selected(), expected, `revision ${revision}`);
    assert.equal(view.state().status, 'ready');
  }
  assert.equal(view.state().revision, 7);
});

test('a write acknowledged with an older revision than the one shown is rejected', async () => {
  const view = await ready(false, 5);
  view.click('ON');
  view.lastWrite().reply(G(true, 4));
  await settle();
  assert.equal(view.state().value, false);
  assert.equal(view.state().revision, 5);
  assert.equal(view.state().status, 'unavailable');
  assert.match(view.status(), /valid global Fast state/);
});

test('a write timeout keeps the last acknowledgement but marks it unknown until a read confirms', async () => {
  const view = await ready(false, 2);
  view.click('ON');
  view.lastWrite().timeout();
  await settle();
  const state = view.state();
  assert.deepEqual([state.value, state.revision, state.status, state.writing], [false, 2, 'unavailable', false]);
  assert.ok(view.status().startsWith(view.t('common.saveFailed')));
  assert.deepEqual(view.enabled(), []);
  // The PUT did persist after all: the read-back shows it.
  view.poll();
  view.lastRead().reply(G(true, 3));
  await settle();
  assert.equal(view.selected(), 'ON');
  assert.equal(view.status(), view.t('mod.fast.synced'));
});

test('read failure and timeout make the control unavailable; the next good read recovers it', async () => {
  for (const finish of [read => read.reply({ error: 'router down' }, 503), read => read.timeout(), read => read.fail(new TypeError('fetch failed'))]) {
    const view = await ready(true, 3);
    view.poll();
    finish(view.lastRead());
    await settle();
    assert.equal(view.state().status, 'unavailable');
    assert.ok(view.status().startsWith(view.t('common.loadFailed')));
    assert.ok(view.statusBad());
    assert.deepEqual(view.enabled(), []);
    view.write(false);
    assert.equal(view.writes().length, 0, 'an unknown state cannot be written over');
    view.poll();
    view.lastRead().reply(G(true, 3));
    await settle();
    assert.equal(view.state().status, 'ready');
    assert.equal(view.statusBad(), false);
    assert.equal(view.selected(), 'ON');
  }
});

test('initial read failure, then success, becomes ready', async () => {
  const view = dashboard();
  view.mount();
  view.lastRead().reply({ error: 'x' }, 500);
  await settle();
  assert.equal(view.state().status, 'unavailable');
  view.poll();
  view.lastRead().reply(G(false, 0));
  await settle();
  assert.equal(view.selected(), 'OFF');
});

test('older snapshots stay rejected after an outage (the revision guard survives a failed read)', async () => {
  const view = await ready(true, 9);
  view.poll();
  view.lastRead().reply({ error: 'restarting' }, 503);
  await settle();
  view.poll();
  view.lastRead().reply(G(null, 0));
  await settle();
  assert.equal(view.state().status, 'unavailable');
  assert.equal(view.state().revision, 9);
  assert.equal(view.state().value, true);
  assert.equal(view.selected(), null);
  view.poll();
  view.lastRead().reply(G(true, 9));
  await settle();
  assert.equal(view.selected(), 'ON');
});

// ---- Malformed replies ------------------------------------------------------------------------

const malformed = [
  ['null body', null], ['empty object', {}], ['non-JSON text', 'oops'],
  ['missing scope', { fast: true, revision: 1 }],
  ['session scope', { scope: 'session', fast: true, revision: 1 }],
  ['legacy session shape', { session: 's1', fast: true, revision: 1 }],
  ['string fast', { scope: 'global', fast: 'true', revision: 1 }],
  ['numeric fast', { scope: 'global', fast: 1, revision: 1 }],
  ['missing fast', { scope: 'global', revision: 1 }],
  ['negative revision', { scope: 'global', fast: true, revision: -1 }],
  ['fractional revision', { scope: 'global', fast: true, revision: 1.5 }],
  ['string revision', { scope: 'global', fast: true, revision: '3' }],
  ['missing revision', { scope: 'global', fast: true }],
  ['unsafe revision', { scope: 'global', fast: true, revision: 2 ** 53 }],
];
for (const [name, reply] of malformed) {
  test(`malformed GET reply (${name}) is not shown as the server value`, async () => {
    const view = await ready(false, 1);
    view.poll();
    view.lastRead().reply(reply);
    await settle();
    assert.equal(view.state().status, 'unavailable');
    assert.equal(view.state().value, false);
    assert.equal(view.state().revision, 1);
    assert.match(view.status(), /valid global Fast state/);
    assert.deepEqual(view.enabled(), []);
  });
  test(`malformed PUT reply (${name}) is not acknowledged`, async () => {
    const view = await ready(false, 1);
    view.click('ON');
    view.lastWrite().reply(reply);
    await settle();
    assert.equal(view.state().status, 'unavailable');
    assert.equal(view.state().value, false);
    assert.equal(view.state().writing, false);
    assert.match(view.status(), /valid global Fast state/);
  });
}

test('invalid write targets are not sent', async () => {
  const view = await ready(false, 1);
  for (const target of ['true', 1, 0, undefined, {}]) view.run(`modFastWrite(${target === undefined ? 'undefined' : JSON.stringify(target)})`);
  assert.equal(view.writes().length, 0);
});

// ---- Polling ---------------------------------------------------------------------------------

test('polling runs every 3 seconds and on focus/visibility, only on the visible mod view', async () => {
  const view = await ready(false, 1);
  assert.equal(view.intervals.length, 1);
  assert.equal(view.intervals[0].ms, 3000);
  assert.equal(view.intervals[0].fn, view.run('modFastPoll'));
  assert.equal(view.windowEvents.focus?.[0], view.run('modFastPoll'));
  assert.equal(view.doc.events.visibilitychange?.[0], view.run('modFastPoll'));
  view.intervals[0].fn();
  assert.equal(view.reads().length, 2);
  view.intervals[0].fn();
  assert.equal(view.reads().length, 2, 'no second read while one is pending');
  view.lastRead().reply(G(true, 2));
  await settle();
  assert.equal(view.selected(), 'ON', 'another surface\'s change appears on the next poll');
  view.doc.hidden = true;
  view.doc.events.visibilitychange[0]();
  view.intervals[0].fn();
  assert.equal(view.reads().length, 2, 'hidden tab does not poll');
  view.doc.hidden = false;
  view.location.hash = '#logs';
  view.windowEvents.focus[0]();
  assert.equal(view.reads().length, 2, 'other views do not poll');
  view.location.hash = '#mod';
  view.doc.events.visibilitychange[0]();
  assert.equal(view.reads().length, 3);
});

test('a poll with an unchanged value keeps the same control elements and focus; a change redraws', async () => {
  const view = await ready(false, 1);
  const before = view.buttons();
  view.button('ON').focus();
  const focused = view.doc.activeElement;
  for (let i = 0; i < 3; i++) {
    view.poll();
    view.lastRead().reply(G(false, 1 + i));
    await settle();
    assert.equal(view.buttons()[1], before[1], 'unchanged state is not redrawn');
    assert.equal(view.doc.activeElement, focused);
  }
  view.poll();
  view.lastRead().reply(G(true, 9));
  await settle();
  assert.notEqual(view.buttons()[1], before[1]);
  assert.equal(view.selected(), 'ON');
  assert.equal(view.doc.activeElement, view.button('ON'), 'focus follows the redrawn control');
  // Unavailable -> ready with the same value must re-enable the controls.
  view.poll();
  view.lastRead().reply({ error: 'x' }, 500);
  await settle();
  assert.deepEqual(view.enabled(), []);
  view.poll();
  view.lastRead().reply(G(true, 9));
  await settle();
  assert.deepEqual(view.enabled(), ['Auto', 'ON', 'OFF']);
  assert.equal(view.selected(), 'ON');
});

test('saving restores keyboard focus to its enabled button without stealing focus from another control', async () => {
  const view = await ready(false, 1);
  view.button('ON').focus();
  view.click('ON');
  assert.equal(view.doc.activeElement, view.doc.body, 'disabled replacements cannot take focus');
  view.lastWrite().reply(G(true, 2));
  await settle();
  assert.equal(view.doc.activeElement, view.button('ON'));
  view.button('OFF').focus();
  view.click('OFF');
  const other = view.doc.createElement('button');
  view.doc.body.appendChild(other);
  other.focus();
  view.lastWrite().reply(G(false, 3));
  await settle();
  assert.equal(view.doc.activeElement, other);
});

test('a failed keyboard save keeps focus inside the card (on the control) for recovery', async () => {
  const view = await ready(false, 1);
  view.button('ON').focus();
  view.click('ON');
  view.lastWrite().reply({ error: 'offline' }, 503);
  await settle();
  assert.equal(view.doc.activeElement, view.control());
  assert.deepEqual(view.enabled(), []);
  view.poll();
  view.lastRead().reply(G(false, 1));
  await settle();
  assert.deepEqual(view.enabled(), ['Auto', 'ON', 'OFF']);
});

test('remounting keeps the same controls and reads again', async () => {
  const view = await ready(false, 1);
  const control = view.control();
  view.mount();
  assert.equal(view.control(), control);
  assert.equal(view.reads().length, 2);
});

// ---- Two dashboards: one shared global value ---------------------------------------------------

test('two tabs with different or absent session URLs show and change one shared value (scripted server)', async () => {
  const server = { fast: null, revision: 0 };
  const a = dashboard({ search: '?session=alpha' });
  const b = dashboard({ search: '?session=beta' });
  const c = dashboard({ search: '' });
  for (const view of [a, b, c]) { view.mount(); view.lastRead().reply(G(server.fast, server.revision)); }
  await settle();
  for (const view of [a, b, c]) assert.equal(view.selected(), 'Auto');
  a.click('ON');
  assert.deepEqual(a.lastWrite().body, { fast: true });
  Object.assign(server, { fast: true, revision: 1 });
  a.lastWrite().reply(G(true, 1));
  await settle();
  for (const view of [b, c]) { view.poll(); assert.equal(view.lastRead().url, '/api/fast'); view.lastRead().reply(G(server.fast, server.revision)); }
  await settle();
  assert.equal(b.selected(), 'ON');
  assert.equal(c.selected(), 'ON');
  // A brand-new tab with yet another session id starts from the same value.
  const d = dashboard({ search: '?session=gamma' });
  d.mount();
  d.lastRead().reply(G(server.fast, server.revision));
  await settle();
  assert.equal(d.selected(), 'ON');
});

test('two dashboards share one durable global value through the real admin API', async t => {
  const root = process.env.CLAUDERIPPLE_TEST_TMP;
  assert.ok(root, 'Set CLAUDERIPPLE_TEST_TMP to the session scratchpad');
  const home = fs.mkdtempSync(path.join(root, 'dashboard-fast-'));
  const previousHome = process.env.CLAUDERIPPLE_HOME;
  process.env.CLAUDERIPPLE_HOME = home; // keep the admin's other stores out of the real home
  t.after(() => { if (previousHome === undefined) delete process.env.CLAUDERIPPLE_HOME; else process.env.CLAUDERIPPLE_HOME = previousHome; });
  const server = await startAdmin({ config: () => ({ admin: { port: 0 } }), log: { info() {}, warn() {}, error() {} } });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;

  async function until(view, predicate, label) {
    for (let i = 0; i < 200; i++) { if (predicate(view.state())) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail(`timed out waiting for ${label}: ${JSON.stringify(view.state())}`);
  }
  const ready2 = state => state.status === 'ready' && !state.writing;
  const a = dashboard({ search: '?session=shared-1', server: base });
  const b = dashboard({ search: '?session=other-1', server: base });
  const c = dashboard({ search: '', server: base });
  for (const view of [a, b, c]) { view.mount(); await until(view, ready2, 'initial read'); }
  assert.equal(a.selected(), 'Auto');

  a.click('ON');
  await until(a, s => ready2(s) && s.value === true, 'A acknowledged ON');
  assert.equal(b.selected(), 'Auto', 'B has not polled yet');
  for (const view of [b, c]) { view.poll(); await until(view, s => s.value === true, 'reads ON'); assert.equal(view.state().revision, a.state().revision); }

  b.click('OFF');
  await until(b, s => ready2(s) && s.value === false, 'B acknowledged OFF');
  for (const view of [a, c]) { view.poll(); await until(view, s => s.value === false, 'reads OFF'); }
  c.click('Auto');
  await until(c, s => ready2(s) && s.value === null, 'C acknowledged Auto');
  for (const view of [a, b]) { view.poll(); await until(view, s => s.value === null && s.revision === c.state().revision, 'reads Auto'); }

  // A fresh tab (after a restart of the page) shows the persisted value whatever its session URL.
  b.click('OFF');
  await until(b, s => ready2(s) && s.value === false, 'B acknowledged OFF again');
  const d = dashboard({ search: '?session=brand-new', server: base });
  d.mount();
  await until(d, ready2, 'fresh tab');
  assert.equal(d.selected(), 'OFF');
});
