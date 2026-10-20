import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ChatGptAdapter } from '../dist/router/src/providers/chatgpt/index.js';

// Exercise the real adapter and retry loop, replacing only credentials and HTTP transport.
// No user's tokens, account files, prompts, or network connections are used.
class ClientResponse extends EventEmitter {
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  chunks = [];
  writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; return this; }
  write(chunk) { this.chunks.push(chunk); return true; }
  end(chunk) { if (chunk) this.chunks.push(chunk); this.writableEnded = true; return this; }
}
function event(type, body) { return `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`; }
function upstream(tier) {
  return new Response(
    event('response.created', { response: { id: 'resp_fixture', service_tier: 'auto' } }) +
    event('response.output_text.delta', { output_index: 0, content_index: 0, delta: 'OK' }) +
    event('response.completed', { response: { id: 'resp_fixture', status: 'completed', ...(tier ? { service_tier: tier } : {}), usage: { input_tokens: 10, output_tokens: 2 } } }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}
function setup(t, { defaultServiceTier, servedTier = 'priority', refuseFirst = false } = {}) {
  const root = process.env.CLAUDERIPPLE_TEST_TMP;
  assert.ok(root, 'CLAUDERIPPLE_TEST_TMP must point into the session scratchpad');
  const home = fs.mkdtempSync(path.join(root, 'fast-wire-'));
  const adapter = new ChatGptAdapter('fixture', { type: 'chatgpt', url: 'https://fast-wire.invalid', auth: 'own', identity: false, defaultServiceTier }, home, { info() {}, warn() {}, error() {} });
  const credentials = ['a', 'b'].map(id => ({ id, ownerId: id, accountId: `fixture-${id}`, headers: { authorization: `Bearer fixture-${id}` } }));
  adapter.pick = async (_conversation, tried) => credentials.find(c => !tried.has(c.ownerId)) ?? null;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://fast-wire.invalid/codex/responses');
    calls.push({ body: JSON.parse(init.body), headers: new Headers(init.headers) });
    if (refuseFirst && calls.length === 1) return new Response('{"error":{"message":"rate limit exceeded"}}', { status: 429 });
    return upstream(servedTier);
  });
  return { adapter, calls };
}
async function send(adapter, model, speed, stream = false) {
  const response = new ClientResponse();
  const outcome = await adapter.handle({}, response, '/v1/messages', {
    model, stream, max_tokens: 32,
    metadata: { user_id: 'fast-wire-fixture' },
    messages: [{ role: 'user', content: 'Reply OK.' }],
    ...(speed ? { speed } : {}),
  }, model, 'high');
  assert.equal(response.status, 200);
  assert.equal(response.writableEnded, true);
  assert.equal(outcome.status, 200);
  return outcome;
}

for (const model of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna']) {
  for (const stream of [false, true]) {
    test(`${model} stream=${stream}: OFF/ON/OFF keeps body and routing hint in sync`, async t => {
      const { adapter, calls } = setup(t);
      for (const speed of [undefined, 'fast', undefined]) await send(adapter, model, speed, stream);
      assert.deepEqual(calls.map(c => c.body.service_tier), [undefined, 'priority', undefined]);
      assert.deepEqual(calls.map(c => c.headers.get('x-codex-routing-hint')), [`model=${model}`, `model=${model};tier=priority`, `model=${model}`]);
      assert.ok(calls.every(c => c.body.model === model && c.body.reasoning.effort === 'high'));
    });
  }
}
for (const tier of ['default', 'priority']) {
  test(`provider ${tier} default remains explicit on the wire`, async t => {
    const { adapter, calls } = setup(t, { defaultServiceTier: tier });
    await send(adapter, 'gpt-6-astra');
    assert.equal(calls[0].body.service_tier, tier);
    assert.equal(calls[0].headers.get('x-codex-routing-hint'), `model=gpt-6-astra;tier=${tier}`);
  });
}
test('native Fast overrides a standard provider default in both body and header', async t => {
  const { adapter, calls } = setup(t, { defaultServiceTier: 'default' });
  await send(adapter, 'gpt-6-astra', 'fast');
  assert.equal(calls[0].body.service_tier, 'priority');
  assert.equal(calls[0].headers.get('x-codex-routing-hint'), 'model=gpt-6-astra;tier=priority');
});
test('account failover retains Fast intent and changes only the selected credential', async t => {
  const { adapter, calls } = setup(t, { refuseFirst: true });
  await send(adapter, 'gpt-6-astra', 'fast');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body, calls[1].body);
  assert.equal(calls[0].headers.get('x-codex-routing-hint'), 'model=gpt-6-astra;tier=priority');
  assert.equal(calls[1].headers.get('x-codex-routing-hint'), 'model=gpt-6-astra;tier=priority');
  assert.notEqual(calls[0].headers.get('authorization'), calls[1].headers.get('authorization'));
});
for (const servedTier of ['priority', 'default', undefined]) {
  test(`preserves the actual served tier (${servedTier ?? 'absent'}) without inferring success`, async t => {
    const { adapter } = setup(t, { servedTier: servedTier ?? '' });
    const outcome = await send(adapter, 'gpt-6-astra', 'fast');
    assert.equal(outcome.requestedTier, 'priority');
    assert.equal(outcome.servedTier, servedTier);
  });
}
test('count_tokens does not make a Fast upstream request', async t => {
  const { adapter, calls } = setup(t);
  const response = new ClientResponse();
  const outcome = await adapter.handle({}, response, '/v1/messages/count_tokens', { model: 'gpt-6-astra', speed: 'fast', messages: [] }, 'gpt-6-astra', 'high');
  assert.equal(calls.length, 0);
  assert.equal(outcome.requestedTier, undefined);
});
test('unusual model identifiers cannot inject routing-hint fields', async t => {
  const { adapter, calls } = setup(t);
  await send(adapter, 'custom;tier=default', 'fast');
  assert.equal(calls[0].body.model, 'custom;tier=default');
  assert.equal(calls[0].body.service_tier, 'priority');
  assert.equal(calls[0].headers.get('x-codex-routing-hint'), null);
});
