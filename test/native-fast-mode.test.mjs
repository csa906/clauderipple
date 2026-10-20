import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, validate } from '../dist/router/src/config.js';
import { applyProxyEnv, removeProxyEnv } from '../dist/cli/src/settings.js';
import { FAST_CAPABILITIES_ENV as CAP, FAST_GATEWAY_ENV as GATE, gptFastModelsForConfig, fastCapabilityClauses, planFastEnvironment, prepareNativeFastMode, commitNativeFastMode, atomicJsonWrite } from '../dist/cli/src/native-fast-mode.js';
import { resolve } from '../dist/router/src/routing.js';
import { toResponsesRequest } from '../dist/router/src/providers/chatgpt/translate.js';

const GPT = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna'];
const proxy = { proxyUrl: 'http://127.0.0.1:9876', caPath: 'fixture-ca.pem', force: false };
function config() {
  return { ...structuredClone(DEFAULTS), providers: {
    chatgpt: { type: 'chatgpt', models: GPT.map(id => ({ id })) },
    google: { type: 'google', models: [{ id: 'gemini-test' }] },
    claude: { type: 'anthropic', models: [{ id: 'claude-opus-5-5' }] },
  }, direct: [{ prefix: 'gpt-', provider: 'chatgpt' }], routes: {
    'astra-slot': { provider: 'chatgpt', model: GPT[0] },
  }, cli: { ...DEFAULTS.cli, gptFastModels: [...GPT], extraModels: [
    ...GPT.map(model => ({ model })), { model: GPT[0] + '@high' },
    { model: 'gemini-test' }, { model: 'claude-opus-5-5' },
  ] } };
}
function fixture(t, original = {}) {
  const root = process.env.CLAUDERIPPLE_TEST_TMP;
  assert.ok(root, 'CLAUDERIPPLE_TEST_TMP must point into the session scratchpad');
  const dir = fs.mkdtempSync(path.join(root, 'native-fast-settings-'));
  const file = path.join(dir, 'settings.json');
  atomicJsonWrite(file, original);
  const previous = process.env.CLAUDE_SETTINGS_PATH;
  process.env.CLAUDE_SETTINGS_PATH = file;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_SETTINGS_PATH;
    else process.env.CLAUDE_SETTINGS_PATH = previous;
  });
  return { file, sidecar: file + '.clauderipple-native-fast.json', read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('only explicitly selected ChatGPT targets and consistent route aliases are advertised', () => {
  assert.deepEqual(gptFastModelsForConfig(config()), ['astra-slot', ...GPT].sort());
});
test('absence and empty whitelist leave native Fast unmanaged/disabled', () => {
  const cfg = config(); delete cfg.cli.gptFastModels;
  assert.deepEqual(gptFastModelsForConfig(cfg), []);
  cfg.cli.gptFastModels = []; assert.deepEqual(gptFastModelsForConfig(cfg), []);
});
for (const invalid of ['gemini-test', 'claude-opus-5-5', 'gpt-unknown', '*', 'gpt-6-astra;fast_mode']) {
  test(`rejects invalid or non-ChatGPT opt-in: ${invalid}`, () => {
    const cfg = config(); cfg.cli.gptFastModels = [invalid];
    assert.throws(() => gptFastModelsForConfig(cfg));
  });
}
test('does not enable Fast for unselected configured GPT models', () => {
  const cfg = config(); cfg.cli.gptFastModels = [GPT[1]];
  assert.deepEqual(gptFastModelsForConfig(cfg), [GPT[1]]);
});
test('rejects an alias with fallback providers', () => {
  const cfg = config(); cfg.routes['astra-slot'].fallbacks = [{ provider: 'google', model: 'gemini-test' }];
  cfg.cli.gptFastModels = ['astra-slot'];
  assert.throws(() => gptFastModelsForConfig(cfg), /without fallbacks/);
});
test('rejects a priority default that would defeat OFF', () => {
  const cfg = config(); cfg.providers.chatgpt.defaultServiceTier = 'priority';
  assert.throws(() => gptFastModelsForConfig(cfg), /remove provider/);
  assert.ok(validate(cfg).some(error => error.includes('defaultServiceTier')));
});
test('configuration validator rejects malformed whitelists', () => {
  for (const value of [true, 'gpt-6-astra', [null], ['*']]) {
    const cfg = config(); cfg.cli.gptFastModels = value;
    assert.ok(validate(cfg).some(error => error.includes('gptFastModels')));
  }
});
test('capability syntax is exact, deduplicated and supports @effort', () => {
  assert.equal(fastCapabilityClauses([GPT[0], GPT[0]]), 'gpt-6-astra=fast_mode;gpt-6-astra@*=fast_mode');
  assert.throws(() => fastCapabilityClauses(['*']), /Invalid/);
});
test('a route later reassigned to another provider no longer gets a GPT capability', () => {
  const cfg = config(); cfg.routes['astra-slot'] = { provider: 'google', model: 'gemini-test' };
  assert.deepEqual(gptFastModelsForConfig(cfg), [...GPT].sort());
});

test('generated declarations precede and preserve manual exclusions', () => {
  const original = { CUSTOM: 'kept', [CAP]: 'other=vision;gpt-6-astra=-fast_mode' };
  const plan = planFastEnvironment(original, [GPT[0]]);
  assert.ok(plan.env[CAP].endsWith(';' + original[CAP]));
  assert.equal(plan.env[GATE], '1');
  assert.equal(plan.env.CUSTOM, 'kept');
  assert.deepEqual(planFastEnvironment(plan.env, [], plan.state).env, original);
});
test('repeat synchronization is idempotent', () => {
  const first = planFastEnvironment({}, GPT);
  const next = planFastEnvironment(first.env, GPT, first.state);
  assert.equal(next.changed, false); assert.deepEqual(next.state, first.state);
});
test('preexisting manual gateway opt-in survives disable', () => {
  const original = { [GATE]: '1' };
  const on = planFastEnvironment(original, GPT);
  assert.equal(on.state.gateway, null);
  assert.deepEqual(planFastEnvironment(on.env, [], on.state).env, original);
});
test('conflicting manual gateway values are not overwritten', () => {
  const original = { [GATE]: '0', CUSTOM: 'kept' };
  assert.throws(() => planFastEnvironment(original, GPT), /conflicts/);
  assert.deepEqual(original, { [GATE]: '0', CUSTOM: 'kept' });
});
test('externally edited gateway value blocks enable but is kept on disable', () => {
  const on = planFastEnvironment({}, GPT);
  const edited = { ...on.env, [GATE]: '0' };
  assert.throws(() => planFastEnvironment(edited, GPT, on.state), /edited outside/);
  assert.deepEqual(planFastEnvironment(edited, [], on.state).env, { [GATE]: '0' });
});
test('manual capability suffix additions survive regeneration and disable', () => {
  const on = planFastEnvironment({ [CAP]: 'other=vision' }, [GPT[0]]);
  const edited = { ...on.env, [CAP]: on.env[CAP] + ';custom=thinking' };
  const changed = planFastEnvironment(edited, [GPT[1]], on.state);
  assert.ok(!changed.env[CAP].includes('gpt-6-astra=fast_mode'));
  assert.ok(changed.env[CAP].endsWith(';other=vision;custom=thinking'));
  assert.deepEqual(planFastEnvironment(changed.env, [], changed.state).env, { [CAP]: 'other=vision;custom=thinking' });
});
test('a replaced ownership prefix is never silently reclaimed', () => {
  const on = planFastEnvironment({}, GPT);
  const edited = { ...on.env, [CAP]: 'manual=vision' };
  assert.throws(() => planFastEnvironment(edited, GPT, on.state), /ownership changed/);
  assert.deepEqual(planFastEnvironment(edited, [], on.state).env, { [CAP]: 'manual=vision' });
});
test('empty original capability value is restored exactly', () => {
  const original = { [CAP]: '' };
  const on = planFastEnvironment(original, GPT);
  assert.deepEqual(planFastEnvironment(on.env, [], on.state).env, original);
});
test('malformed existing environment values fail without coercion', () => {
  assert.throws(() => planFastEnvironment({ [CAP]: {} }, GPT), /must be a string/);
});

test('settings sync preserves all unrelated fields and saved Fast preference', t => {
  const original = { env: { HTTPS_PROXY: proxy.proxyUrl, NODE_EXTRA_CA_CERTS: proxy.caPath, USER_VALUE: 'keep' }, fastMode: false, permissions: { deny: ['Bash(rm *)'] }, model: 'kept-model', custom: { nested: [1, 2] } };
  const f = fixture(t, original);
  const first = applyProxyEnv({ ...proxy, gptFastModels: GPT });
  assert.equal(first.changed, true); assert.ok(fs.existsSync(first.backup));
  assert.ok(fs.existsSync(f.sidecar));
  const changed = f.read();
  delete changed.env[CAP]; delete changed.env[GATE];
  assert.deepEqual(changed, original);
  assert.equal(applyProxyEnv({ ...proxy, gptFastModels: GPT }).changed, false);
  applyProxyEnv({ ...proxy, gptFastModels: [] });
  assert.deepEqual(f.read(), original); assert.equal(fs.existsSync(f.sidecar), false);
});
test('legacy proxy sync without the new option preserves managed Fast keys', t => {
  const f = fixture(t, {});
  applyProxyEnv({ ...proxy, gptFastModels: GPT }); const before = f.read();
  assert.equal(applyProxyEnv(proxy).changed, false);
  assert.deepEqual(f.read(), before);
});
test('uninstall removes only owned Fast fragments and preserves manual values', t => {
  const original = { env: { USER_VALUE: 'keep', [CAP]: 'custom=vision', [GATE]: '1' }, fastMode: false };
  const f = fixture(t, original);
  applyProxyEnv({ ...proxy, gptFastModels: GPT });
  removeProxyEnv(proxy);
  assert.deepEqual(f.read(), original); assert.equal(fs.existsSync(f.sidecar), false);
});
test('manual conflict causes no settings or ownership write', t => {
  const original = { env: { [GATE]: '0', USER_VALUE: 'keep' } };
  const f = fixture(t, original);
  assert.throws(() => applyProxyEnv({ ...proxy, gptFastModels: GPT }), /conflicts/);
  assert.deepEqual(f.read(), original); assert.equal(fs.existsSync(f.sidecar), false);
});
test('journal recovers when settings were not yet written', t => {
  const f = fixture(t, { env: { USER_VALUE: 'keep' } });
  const plan = prepareNativeFastMode(f.file, f.read().env, GPT);
  assert.throws(() => commitNativeFastMode(plan, () => { throw new Error('simulated interruption'); }), /simulated/);
  assert.ok(JSON.parse(fs.readFileSync(f.sidecar)).pending);
  applyProxyEnv({ ...proxy, gptFastModels: GPT });
  assert.equal(f.read().env[GATE], '1');
  assert.ok(JSON.parse(fs.readFileSync(f.sidecar)).state);
});
test('journal recovers when settings were written but ownership was not committed', t => {
  const f = fixture(t, { env: { USER_VALUE: 'keep' } });
  const plan = prepareNativeFastMode(f.file, f.read().env, GPT);
  assert.throws(() => commitNativeFastMode(plan, () => {
    atomicJsonWrite(f.file, { env: plan.env }); throw new Error('simulated interruption after settings');
  }), /simulated/);
  applyProxyEnv({ ...proxy, gptFastModels: [] });
  assert.equal(f.read().env[CAP], undefined); assert.equal(f.read().env[GATE], undefined);
  assert.equal(f.read().env.USER_VALUE, 'keep'); assert.equal(fs.existsSync(f.sidecar), false);
});
test('journal conflict with manually edited native values refuses recovery', t => {
  const f = fixture(t, { env: {} });
  const plan = prepareNativeFastMode(f.file, {}, GPT);
  assert.throws(() => commitNativeFastMode(plan, () => { throw new Error('stop'); }));
  atomicJsonWrite(f.file, { env: { [CAP]: 'user-edited=vision' } });
  assert.throws(() => applyProxyEnv({ ...proxy, gptFastModels: GPT }), /interrupted/);
  assert.equal(f.read().env[CAP], 'user-edited=vision');
});
test('foreign ownership records do not affect the target settings file', t => {
  const f = fixture(t, { env: {} });
  atomicJsonWrite(f.sidecar, { version: 1, settingsPath: f.file + '-other', state: null });
  assert.throws(() => applyProxyEnv({ ...proxy, gptFastModels: GPT }), /Unrecognized/);
  assert.deepEqual(f.read(), { env: {} });
});
test('corrupt ownership does not keep an uninstalled proxy configured', t => {
  const f = fixture(t, { env: { HTTPS_PROXY: proxy.proxyUrl, NODE_EXTRA_CA_CERTS: proxy.caPath, [CAP]: 'manual=vision', [GATE]: '1' } });
  atomicJsonWrite(f.sidecar, { version: 999 });
  const result = removeProxyEnv(proxy);
  assert.deepEqual(f.read().env, { [CAP]: 'manual=vision', [GATE]: '1' });
  assert.ok(result.notes.some(note => note.includes('left native Fast settings unchanged')));
  assert.ok(fs.existsSync(f.sidecar));
});
test('rapid settings updates retain distinct backups', t => {
  fixture(t, { env: {} });
  const a = applyProxyEnv({ ...proxy, gptFastModels: [GPT[0]] });
  const b = applyProxyEnv({ ...proxy, gptFastModels: [GPT[1]] });
  assert.notEqual(a.backup, b.backup);
  assert.ok(fs.existsSync(a.backup)); assert.ok(fs.existsSync(b.backup));
});

for (const model of GPT) {
  test(`${model}: native OFF ON OFF stays request-scoped after routing`, () => {
    const cfg = config();
    const results = [false, true, false].map(fast => {
      const req = { model: model + '@high', messages: [{ role: 'user', content: 'fixture' }], ...(fast ? { speed: 'fast' } : {}) };
      const route = resolve(req.model, req, cfg);
      const out = toResponsesRequest(req, { model: route.model, effort: route.effort });
      assert.equal(out.model, model); assert.equal(out.reasoning.effort, 'high');
      return out.service_tier ?? null;
    });
    assert.deepEqual(results, [null, 'priority', null]);
  });
}
