import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SessionFastStore, getSessionFastStore, validFastSession } from '../dist/router/src/session-fast.js';
import { startAdmin } from '../dist/router/src/admin.js';
import { ChatGptAdapter } from '../dist/router/src/providers/chatgpt/index.js';

const quiet = { info() {}, warn() {}, error() {} };
function fixture() {
  assert.ok(process.env.CLAUDERIPPLE_TEST_TMP, 'Set CLAUDERIPPLE_TEST_TMP to the session scratchpad');
  const home = fs.mkdtempSync(path.join(process.env.CLAUDERIPPLE_TEST_TMP, 'session-fast-'));
  return { home, file: path.join(home, 'session-fast.json') };
}
const g = (fast, revision) => ({ scope: 'global', fast, revision });

test('the global choice is durable, shared by all sessions, resettable and revisioned', () => {
  const { file } = fixture();
  let store = new SessionFastStore(file);
  assert.deepEqual(store.snapshotGlobal(), g(null, 0));
  assert.deepEqual(store.snapshot('a'), { session: 'a', scope: 'global', fast: null, revision: 0 });
  assert.deepEqual(store.setGlobal(true), g(true, 1));
  assert.equal(store.get('b'), true);
  assert.equal(store.get(undefined), true);
  assert.equal(store.setGlobal(true).revision, 1);
  assert.equal(store.setGlobal(false).revision, 2);
  assert.deepEqual(store.set('anything', true), { session: 'anything', scope: 'global', fast: true, revision: 3 });
  assert.equal(store.get('another'), true);
  store = new SessionFastStore(file);
  assert.equal(store.getGlobal(), true);
  assert.equal(store.setGlobal(null).revision, 4);
  assert.equal(new SessionFastStore(file).getGlobal(), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 2, revision: 4, fast: null });
});
test('adapter and admin share one store per home, not across homes', () => {
  const a = fixture(), b = fixture();
  assert.equal(getSessionFastStore(a.home), getSessionFastStore(a.home));
  assert.notEqual(getSessionFastStore(a.home), getSessionFastStore(b.home));
});
test('rejects malformed toggle values and legacy invalid sessions without writes', () => {
  const { file } = fixture();
  const store = new SessionFastStore(file);
  for (const value of ['', null, undefined, [], 'a,b', 'a b', 'a\nb', 'a'.repeat(129)]) {
    assert.equal(validFastSession(value), false);
    assert.throws(() => store.snapshot(value), /session/);
    assert.throws(() => store.set(value, true), /session/);
  }
  for (const value of [undefined, 'true', 0, 1, {}, []]) {
    assert.throws(() => store.setGlobal(value), /fast must/);
    assert.throws(() => store.set('a', value), /fast must/);
  }
  assert.equal(fs.existsSync(file), false);
});
test('corrupt storage fails visibly without modifying the file or breaking model lookup', () => {
  const { file } = fixture();
  fs.writeFileSync(file, '{broken');
  const store = new SessionFastStore(file);
  assert.equal(store.getGlobal(), null);
  assert.equal(store.get('a'), null);
  assert.throws(() => store.snapshotGlobal(), /could not be read/);
  assert.throws(() => store.snapshot('a'), /could not be read/);
  assert.throws(() => store.setGlobal(true), /could not be read/);
  assert.throws(() => store.set('a', true), /could not be read/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  for (const bad of [{ version: 2, revision: 1, fast: 'yes' }, { version: 3, revision: 1 }, { version: 2, revision: -1, fast: true }, { version: 2, revision: 1.5, fast: true }]) {
    const text = JSON.stringify(bad);
    fs.writeFileSync(file, text);
    const s = new SessionFastStore(file);
    assert.throws(() => s.setGlobal(true), /could not be read/);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
});
test('a shared store recovers after an initial transient read failure', t => {
  const { home, file } = fixture();
  fs.writeFileSync(file, JSON.stringify({ version: 2, revision: 7, fast: false }));
  const originalRead = fs.readFileSync;
  const read = t.mock.method(fs, 'readFileSync', function (target, ...args) {
    if (target === file) throw Object.assign(new Error('fixture permission temporarily denied'), { code: 'EACCES' });
    return originalRead.call(this, target, ...args);
  });
  const store = getSessionFastStore(home);
  assert.equal(store.getGlobal(), null);
  assert.throws(() => store.snapshotGlobal(), /could not be read/);
  read.mock.restore();
  assert.equal(getSessionFastStore(home), store);
  assert.equal(store.getGlobal(), false);
  assert.deepEqual(store.snapshotGlobal(), g(false, 7));
  assert.equal(store.setGlobal(true).revision, 8);
});
test('a corrected unreadable snapshot is loaded without recreating the store', () => {
  const { file } = fixture();
  fs.writeFileSync(file, '{broken');
  const store = new SessionFastStore(file);
  assert.throws(() => store.snapshotGlobal(), /could not be read/);
  fs.writeFileSync(file, JSON.stringify({ version: 2, revision: 4, fast: false }));
  assert.deepEqual(store.snapshotGlobal(), g(false, 4));
});
test('file data is flushed before the rename and successful acknowledgement', t => {
  const { file } = fixture();
  const events = [];
  const sync = fs.fsyncSync, rename = fs.renameSync;
  t.mock.method(fs, 'fsyncSync', fd => { events.push('sync'); return sync(fd); });
  t.mock.method(fs, 'renameSync', (from, to) => { events.push('rename'); return rename(from, to); });
  const store = new SessionFastStore(file);
  assert.equal(store.setGlobal(false).fast, false);
  assert.ok(events.indexOf('sync') >= 0 && events.indexOf('sync') < events.indexOf('rename'));
  assert.equal(new SessionFastStore(file).getGlobal(), false);
});
test('a file flush failure rejects the change and cleans up without replacing the saved mode', t => {
  const { file } = fixture();
  const store = new SessionFastStore(file);
  store.setGlobal(false);
  const before = fs.readFileSync(file, 'utf8');
  t.mock.method(fs, 'fsyncSync', () => { throw new Error('fixture flush failure'); });
  assert.throws(() => store.setGlobal(true), /previous choice is unchanged/);
  assert.deepEqual(store.snapshotGlobal(), g(false, 1));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['session-fast.json']);
});
test('failed atomic save preserves the acknowledged mode and revision', t => {
  const { file } = fixture();
  const store = new SessionFastStore(file);
  store.setGlobal(true);
  const before = fs.readFileSync(file, 'utf8');
  t.mock.method(fs, 'renameSync', () => { throw new Error('fixture disk failure'); });
  assert.throws(() => store.setGlobal(false), /previous choice is unchanged/);
  assert.deepEqual(store.snapshotGlobal(), g(true, 1));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['session-fast.json']);
});
test('partial temporary writes are cleaned up without changing the saved choice', t => {
  const { file } = fixture();
  const store = new SessionFastStore(file);
  store.setGlobal(false);
  const before = fs.readFileSync(file, 'utf8');
  t.mock.method(fs, 'writeFileSync', fd => {
    fs.writeSync(fd, 'partial');
    throw new Error('fixture disk full');
  });
  assert.throws(() => store.setGlobal(true), /previous choice is unchanged/);
  assert.equal(store.getGlobal(), false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['session-fast.json']);
});

test('version 1 files migrate: unanimous explicit entries win, empty or mixed become auto', () => {
  const rows = (...values) => values.map((v, i) => [`s${i}`, v]);
  const cases = [[rows(true, true, true), true], [rows(false, false), false], [rows(true, false, true), null], [[], null]];
  for (const [entries, expected] of cases) {
    const { file } = fixture();
    const text = JSON.stringify({ version: 1, revision: 9, entries });
    fs.writeFileSync(file, text);
    const store = new SessionFastStore(file);
    assert.deepEqual(store.snapshotGlobal(), g(expected, 9));
    assert.equal(store.get('s0'), expected);
    assert.equal(fs.readFileSync(file, 'utf8'), text, 'reading must not rewrite the v1 file');
  }
});
test('version 1 migration persists version 2 on first write, even for the same value, and drops overrides', () => {
  const { file } = fixture();
  fs.writeFileSync(file, JSON.stringify({ version: 1, revision: 5, entries: [['a', true], ['b', true]] }));
  let store = new SessionFastStore(file);
  assert.deepEqual(store.setGlobal(true), g(true, 6));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 2, revision: 6, fast: true });
  assert.equal(store.setGlobal(true).revision, 6);
  store = new SessionFastStore(file);
  assert.deepEqual(store.snapshotGlobal(), g(true, 6));
});
test('a failed first write leaves the version 1 file untouched and still reads the migrated value', t => {
  const { file } = fixture();
  const text = JSON.stringify({ version: 1, revision: 5, entries: [['a', true]] });
  fs.writeFileSync(file, text);
  const store = new SessionFastStore(file);
  t.mock.method(fs, 'renameSync', () => { throw new Error('fixture disk failure'); });
  assert.throws(() => store.setGlobal(true), /previous choice is unchanged/);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.deepEqual(store.snapshotGlobal(), g(true, 5));
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['session-fast.json']);
});
test('malformed version 1 entries are treated as unreadable and never overwritten', () => {
  const bad = [
    { version: 1, revision: 1, entries: [['a', 'yes']] },
    { version: 1, revision: 1, entries: [['a', true], ['a', true]] },
    { version: 1, revision: 1, entries: [['bad id', true]] },
    { version: 1, revision: 1, entries: Array.from({ length: 2049 }, (_, i) => [`s${i}`, true]) },
  ];
  for (const data of bad) {
    const { file } = fixture();
    const text = JSON.stringify(data);
    fs.writeFileSync(file, text);
    const store = new SessionFastStore(file);
    assert.throws(() => store.setGlobal(false), /could not be read/);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
});

async function admin(t, store) {
  const server = await startAdmin({ sessionFast: store, config: () => ({ admin: { port: 0 } }), log: quiet });
  t.after(() => server.close());
  return `http://127.0.0.1:${server.port}`;
}
async function request(base, route, method, body, headers = {}) {
  return fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', connection: 'close', ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
}
const putFast = (base, body, headers) => request(base, '/api/fast', 'PUT', body, headers);
const putLegacy = (base, body, headers) => request(base, '/api/session-fast', 'PUT', body, headers);

test('admin /api/fast GET/PUT acknowledges durable global state and supports auto reset', async t => {
  const { file } = fixture();
  const base = await admin(t, new SessionFastStore(file));
  let response = await request(base, '/api/fast', 'GET');
  assert.deepEqual(await response.json(), g(null, 0));
  for (const [fast, revision] of [[true, 1], [false, 2], [null, 3]]) {
    response = await putFast(base, { fast });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), g(fast, revision));
    assert.equal(new SessionFastStore(file).getGlobal(), fast);
  }
  response = await putFast(base, { fast: null });
  assert.deepEqual(await response.json(), g(null, 3));
  response = await request(base, '/api/fast', 'GET');
  assert.deepEqual(await response.json(), g(null, 3));
});
test('admin /api/fast rejects invalid JSON, shapes and values with 400 and no write', async t => {
  const { file } = fixture();
  const base = await admin(t, new SessionFastStore(file));
  for (const body of ['{', 'null', '[]', '{}', { fast: 'on' }, { fast: 1 }, { session: 'a', fast: true }, { fast: true, extra: 1 }, { session: 'a' }]) {
    const response = await putFast(base, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    await response.text();
  }
  assert.equal(fs.existsSync(file), false);
});
test('admin legacy /api/session-fast keeps validation and its response shape', async t => {
  const { file } = fixture();
  const base = await admin(t, new SessionFastStore(file));
  for (const body of ['{', 'null', '[]', '{}', { session: '', fast: true }, { session: 'a', fast: 'on' }, { session: 'a', fast: true, extra: 1 }]) {
    const response = await putLegacy(base, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    await response.text();
  }
  for (const query of ['session=a%0Ab', '']) {
    const response = await request(base, `/api/session-fast?${query}`, 'GET');
    assert.equal(response.status, 400);
    await response.text();
  }
  assert.equal(fs.existsSync(file), false);
});
test('admin legacy read alias reports the global value for any session', async t => {
  const { file } = fixture();
  const store = new SessionFastStore(file);
  store.setGlobal(true);
  const base = await admin(t, store);
  for (const session of ['one', 'two']) {
    const response = await request(base, `/api/session-fast?session=${session}`, 'GET');
    assert.deepEqual(await response.json(), { session, scope: 'global', fast: true, revision: 1 });
  }
});
test('admin legacy write updates the global setting for all sessions and /api/fast', async t => {
  const { file } = fixture();
  const store = new SessionFastStore(file);
  const base = await admin(t, store);
  let response = await putLegacy(base, { session: 'one', fast: false });
  assert.deepEqual(await response.json(), { session: 'one', scope: 'global', fast: false, revision: 1 });
  assert.deepEqual(await (await request(base, '/api/fast', 'GET')).json(), g(false, 1));
  assert.deepEqual(await (await request(base, '/api/session-fast?session=two', 'GET')).json(), { session: 'two', scope: 'global', fast: false, revision: 1 });
  response = await putFast(base, { fast: true });
  await response.text();
  assert.equal((await (await request(base, '/api/session-fast?session=one', 'GET')).json()).fast, true);
  assert.equal(new SessionFastStore(file).getGlobal(), true);
});
test('admin cross-site protection applies to both Fast controls', async t => {
  const { file } = fixture();
  const store = new SessionFastStore(file);
  const base = await admin(t, store);
  for (const [send, body] of [[putFast, { fast: true }], [putLegacy, { session: 'a', fast: true }]]) {
    const response = await send(base, body, { Origin: 'https://unrelated.invalid' });
    assert.equal(response.status, 403);
    await response.text();
    assert.equal(store.getGlobal(), null);
  }
  const sameOrigin = await putFast(base, { fast: true }, { Origin: base });
  assert.equal(sameOrigin.status, 200);
  await sameOrigin.text();
  assert.equal(store.getGlobal(), true);
});
test('admin never acknowledges a failed save', async t => {
  const { file } = fixture();
  const store = new SessionFastStore(file);
  const base = await admin(t, store);
  t.mock.method(fs, 'renameSync', () => { throw new Error('fixture disk failure'); });
  for (const send of [() => putFast(base, { fast: true }), () => putLegacy(base, { session: 'a', fast: true })]) {
    const response = await send();
    assert.equal(response.status, 500);
    await response.text();
  }
  assert.equal(store.getGlobal(), null);
  assert.equal(fs.existsSync(file), false);
});
test('admin reports an unreadable file with an error and leaves it unmodified', async t => {
  const { file } = fixture();
  fs.writeFileSync(file, '{broken');
  const base = await admin(t, new SessionFastStore(file));
  for (const response of [await request(base, '/api/fast', 'GET'), await putFast(base, { fast: true }), await request(base, '/api/session-fast?session=a', 'GET')]) {
    assert.equal(response.status, 500);
    await response.text();
  }
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

class ClientResponse extends EventEmitter {
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  writeHead(status) { this.status = status; this.headersSent = true; return this; }
  write() { return true; }
  end() { this.writableEnded = true; return this; }
}
function setupWire(t, defaultServiceTier = 'priority', onFetch) {
  const { home } = fixture();
  const adapter = new ChatGptAdapter('fixture', { type: 'chatgpt', url: 'https://session-fast.invalid', identity: false, defaultServiceTier }, home, quiet);
  const credentials = ['a', 'b'].map(id => ({ id, ownerId: id, accountId: `fake-${id}`, headers: { authorization: `Bearer fake-${id}` } }));
  adapter.pick = async (_conversation, tried) => credentials.find(c => !tried.has(c.ownerId)) ?? null;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://session-fast.invalid/codex/responses');
    calls.push({ body: JSON.parse(init.body), headers: new Headers(init.headers) });
    const custom = onFetch?.(calls.length, adapter);
    return custom ?? new Response('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: { id: 'fixture', status: 'completed', service_tier: 'default', usage: { input_tokens: 10, output_tokens: 2 } } }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  return { adapter, calls };
}
async function send(adapter, session, speed, route = '/v1/messages') {
  return adapter.handle({ headers: session === undefined ? {} : { 'x-claude-code-session-id': session } }, new ClientResponse(), route, { model: 'gpt-6-astra', stream: false, messages: [{ role: 'user', content: 'OK' }], ...(speed ? { speed } : {}) }, 'gpt-6-astra', 'high');
}
test('global ON forces priority, OFF overrides native Fast and provider default, auto restores it', async t => {
  const { adapter, calls } = setupWire(t);
  adapter.sessionFast.setGlobal(true);
  await send(adapter, 'session-1');
  adapter.sessionFast.setGlobal(false);
  await send(adapter, 'session-1', 'fast');
  adapter.sessionFast.setGlobal(null);
  await send(adapter, 'session-1');
  assert.deepEqual(calls.map(c => c.body.service_tier), ['priority', undefined, 'priority']);
  assert.deepEqual(calls.map(c => c.headers.get('x-codex-routing-hint')), ['model=gpt-6-astra;tier=priority', 'model=gpt-6-astra', 'model=gpt-6-astra;tier=priority']);
});
test('admin acknowledgements control the actual adapter body for every session', async t => {
  const apiFetch = globalThis.fetch;
  const { adapter, calls } = setupWire(t, 'priority');
  const base = await admin(t, adapter.sessionFast);
  for (const fast of [true, false, null]) {
    const response = await apiFetch(`${base}/api/fast`, { method: 'PUT', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ fast }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).fast, fast);
    await send(adapter, 'bar-session', 'fast');
    await send(adapter, 'unrelated-session', 'fast');
  }
  assert.deepEqual(calls.map(c => c.body.service_tier), ['priority', 'priority', undefined, undefined, 'priority', 'priority']);
});
test('global ON applies to every session including absent or invalid session ids', async t => {
  const { adapter, calls } = setupWire(t, 'default');
  adapter.sessionFast.setGlobal(true);
  for (const session of ['chosen', 'other', undefined, ['chosen'], 'chosen,other']) await send(adapter, session);
  assert.deepEqual(calls.map(c => c.body.service_tier), Array(5).fill('priority'));
});
test('legacy alias write affects a request that carries no session header', async t => {
  const apiFetch = globalThis.fetch;
  const { adapter, calls } = setupWire(t, 'default');
  const base = await admin(t, adapter.sessionFast);
  const response = await apiFetch(`${base}/api/session-fast`, { method: 'PUT', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ session: 'old-bar', fast: true }) });
  await response.text();
  await send(adapter, undefined);
  await send(adapter, 'someone-else');
  assert.deepEqual(calls.map(c => c.body.service_tier), ['priority', 'priority']);
});
test('clicking OFF mid-request does not change its failover attempt, but changes the next request', async t => {
  const { adapter, calls } = setupWire(t, 'priority', (n, adapter) => {
    if (n === 1) {
      adapter.sessionFast.setGlobal(false);
      return new Response('{"error":{"message":"rate limit exceeded"}}', { status: 429 });
    }
  });
  adapter.sessionFast.setGlobal(true);
  await send(adapter, 'session-1');
  await send(adapter, 'session-2', 'fast');
  assert.deepEqual(calls.map(c => c.body.service_tier), ['priority', 'priority', undefined]);
});
test('global Fast never turns token estimation into an upstream call', async t => {
  const { adapter, calls } = setupWire(t);
  adapter.sessionFast.setGlobal(true);
  const outcome = await send(adapter, 'a', 'fast', '/v1/messages/count_tokens');
  assert.equal(calls.length, 0);
  assert.equal(outcome.requestedTier, undefined);
});
test('provider adapter reconstruction retains the global selection', async t => {
  const { adapter } = setupWire(t);
  adapter.sessionFast.setGlobal(false);
  const home = path.dirname(adapter.sessionFast.file);
  const replacement = new ChatGptAdapter('fixture', { type: 'chatgpt', defaultServiceTier: 'priority' }, home, quiet);
  assert.equal(replacement.sessionFast.getGlobal(), false);
});
