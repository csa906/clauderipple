import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { RequestLog } from '../dist/router/src/requestlog.js';
import { toResponsesRequest } from '../dist/router/src/providers/chatgpt/translate.js';

// This installed package ships browser scripts, not a source build or a DOM dependency.
// Execute the real element builder and request renderers against a small in-memory DOM.
const app = fs.readFileSync(new URL('../dist/ui/app.js', import.meta.url), 'utf8');
const i18n = fs.readFileSync(new URL('../dist/ui/i18n.js', import.meta.url), 'utf8');
function section(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `missing source section: ${start}`);
  return source.slice(a, b);
}
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.events = {}; this.className = ''; this.textContent = ''; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  addEventListener(key, value) { this.events[key] = value; }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
}
function ui(lang = 'en') {
  const context = vm.createContext({
    Node: Element,
    document: { createElement: tag => new Element(tag), createTextNode: text => Object.assign(new Element('#text'), { textContent: text }) },
    lang,
    providerClass: () => 'chatgpt',
    timeOf: value => value,
    formatNumber: value => String(value),
    formatSeconds: value => String(value / 1000),
    expandedRequestId: null, requestRows: [], renderRequests: () => {},
  });
  vm.runInContext(section(i18n, 'const I18N =', 'const LANGUAGES ='), context);
  vm.runInContext('function t(key, vars) { let value = I18N[lang][key] ?? I18N.en[key] ?? key; for (const [k, v] of Object.entries(vars || {})) value = value.replaceAll("{" + k + "}", String(v)); return value; }', context);
  vm.runInContext(section(app, 'function el(', 'let toastTimer ='), context);
  vm.runInContext(section(app, 'function totalInputOf(', 'function renderRequests('), context);
  return context;
}
const base = {
  id: 'test-fast-log', at: '2026-10-20T00:00:00Z', kind: 'messages',
  source: 'gpt-6-1-sol@high', target: 'gpt-6.1-sol', provider: 'chatgpt',
  status: 200, ok: true, ms: 1200, stream: true, effort: 'high',
  usage: { input: 100, cached: 900, output: 40 },
};
function nodes(node) { return [node, ...node.children.flatMap(nodes)]; }
function badge(node) { return nodes(node).find(n => n.className.split(' ').includes('fast-badge')); }
function text(node) { return nodes(node).map(n => n.textContent).join(' '); }

for (const [name, fields, expected, requested] of [
  ['confirmed priority', { requestedTier: 'priority', servedTier: 'priority' }, '⚡ fast', false],
  ['served priority without request metadata', { servedTier: 'priority' }, '⚡ fast', false],
  ['served priority overrides requested default', { requestedTier: 'default', servedTier: 'priority' }, '⚡ fast', false],
  ['requested priority without confirmation', { requestedTier: 'priority' }, '⚡ fast requested', true],
  ['requested priority served default', { requestedTier: 'priority', servedTier: 'default' }, '⚡ fast requested', true],
  ['requested priority served standard', { requestedTier: 'priority', servedTier: 'standard' }, '⚡ fast requested', true],
  ['failed priority request', { requestedTier: 'priority', status: 429, ok: false }, '⚡ fast requested', true],
  ['resent priority request', { requestedTier: 'priority', status: 499, ok: false, resent: true }, '⚡ fast requested', true],
  ['legacy entry', {}, null, false],
  ['standard request', { requestedTier: 'default', servedTier: 'default' }, null, false],
  ['note is not fast evidence', { note: 'gpt request fast' }, null, false],
  ['untranslated inbound speed is not evidence', { speed: 'fast' }, null, false],
  ['non-priority service tier', { servedTier: 'flex' }, null, false],
  ['non-GPT ordinary request', { target: 'claude-sonnet-5-5', provider: 'anthropic' }, null, false],
  ['token estimation is not a fast model invocation', { kind: 'count_tokens', requestedTier: 'priority', servedTier: 'priority' }, null, false],
]) {
  test(name, () => {
    const row = ui().requestRow({ ...base, ...fields });
    const found = badge(row);
    assert.equal(found?.textContent ?? null, expected);
    if (found) {
      assert.equal(found.className.split(' ').includes('requested'), requested);
      assert.ok(found.attrs.title.includes(`Requested service tier: ${fields.requestedTier || '—'}`));
      assert.ok(found.attrs.title.includes(`Served service tier: ${fields.servedTier || '—'}`));
    }
    assert.equal(row.children.length, 7);
    assert.ok(text(row).includes(fields.target || base.target));
    assert.equal(row.children[2].textContent, 'high');
    assert.ok(text(row.children[3]).includes('1000'));
    assert.equal(typeof row.events.click, 'function');
  });
}

test('each supported language labels requested and served tiers without missing keys', () => {
  for (const lang of ['ko', 'en', 'zh', 'ja', 'es', 'pt']) {
    const view = ui(lang);
    const record = { ...base, requestedTier: 'priority', servedTier: 'default' };
    const found = badge(view.requestRow(record));
    assert.match(found.textContent, /⚡ fast/);
    assert.doesNotMatch(found.textContent + found.attrs.title, /logs\./);
    const detail = text(view.requestDetail(record));
    assert.ok(detail.includes('priority') && detail.includes('default'));
    assert.doesNotMatch(detail, /logs\./);
  }
  assert.equal(badge(ui('ko').requestRow({ ...base, requestedTier: 'priority' })).textContent, '⚡ fast 요청');
});

test('detail shows unknown tiers as unavailable, not as confirmed default', () => {
  const detail = text(ui().requestDetail(base));
  assert.ok(detail.includes('Requested service tier —'));
  assert.ok(detail.includes('Served service tier —'));
});

test('tier strings remain text and attributes, never HTML', () => {
  const value = '<img src=x onerror=alert(1)>';
  const view = ui();
  const record = { ...base, requestedTier: 'priority', servedTier: value };
  const row = view.requestRow(record);
  assert.ok(badge(row).attrs.title.includes(value));
  const detail = view.requestDetail(record);
  assert.ok(nodes(detail).some(n => n.textContent === value));
  assert.equal(nodes(detail).some(n => n.tag === 'img'), false);
});

for (const model of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna']) {
  test(`${model} native OFF → ON → OFF maps to request-scoped fast indicators`, () => {
    const view = ui();
    const rendered = [undefined, 'fast', undefined].map(speed => {
      const request = toResponsesRequest({ model, messages: [{ role: 'user', content: 'test' }], ...(speed ? { speed } : {}) }, { model, effort: 'high' });
      assert.equal(request.model, model);
      assert.equal(request.reasoning.effort, 'high');
      return badge(view.requestRow({ ...base, target: request.model, effort: request.reasoning.effort, requestedTier: request.service_tier }))?.textContent ?? null;
    });
    assert.deepEqual(rendered, [null, '⚡ fast requested', null]);
  });
}

test('persisted tier metadata remains visible after request-log reload', () => {
  const root = process.env.CLAUDERIPPLE_TEST_TMP;
  assert.ok(root, 'CLAUDERIPPLE_TEST_TMP must point into the session scratchpad');
  const dir = fs.mkdtempSync(path.join(root, 'fast-log-'));
  const file = path.join(dir, 'requests.jsonl');
  const log = new RequestLog(file);
  log.add({ ...base, requestedTier: 'priority', servedTier: 'priority' });
  log.add({ ...base, id: 'downgraded', requestedTier: 'priority', servedTier: 'default' });
  log.add({ ...base, id: 'legacy' });
  const restored = new RequestLog(file).list(3);
  const view = ui();
  assert.deepEqual(restored.map(record => badge(view.requestRow(record))?.textContent ?? null), [null, '⚡ fast requested', '⚡ fast']);
});
