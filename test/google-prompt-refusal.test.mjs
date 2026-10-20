import test from 'node:test';
import assert from 'node:assert/strict';
import { isAntigravityPromptRefusal } from '../dist/router/src/providers/google/prompt-refusal.js';

// Synthetic shapes only; no captured request, account, or credential data.
const sdk = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const system = { parts: [{ text: `prefix\r\n\r\n${sdk}\r\n\r\nsuffix` }] };
const error = { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' };
const body = JSON.stringify({ error });

test('the local prompt-refusal classifier requires the exact response and standalone outbound SDK paragraph', () => {
  assert.equal(isAntigravityPromptRefusal(system, 429, body, null), true);
  assert.equal(isAntigravityPromptRefusal(system, 429, JSON.stringify({ error: { ...error, details: [] } }), null), true);
  for (const status of [200, 400, 401, 403, 500, 503]) {
    assert.equal(isAntigravityPromptRefusal(system, status, body, null), false);
  }
  assert.equal(isAntigravityPromptRefusal(undefined, 429, body, null), false);
  for (const text of [`Quoted example: ${sdk}`, `${sdk} Extra words.`, 'A normal assistant.']) {
    assert.equal(isAntigravityPromptRefusal({ parts: [{ text }] }, 429, body, null), false);
  }
});

test('quota details, retry headers, other errors and malformed responses retain their original classification', () => {
  for (const retry of ['', '0', '120']) assert.equal(isAntigravityPromptRefusal(system, 429, body, retry), false);
  for (const details of [{}, [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'QUOTA_EXHAUSTED' }], [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '120s' }]]) {
    assert.equal(isAntigravityPromptRefusal(system, 429, JSON.stringify({ error: { ...error, details } }), null), false);
  }
  for (const text of ['not JSON', 'null', '[]', '{}', '{"error":null}', '{"error":[]}', JSON.stringify({ error: { ...error, code: 503 } }), JSON.stringify({ error: { ...error, message: 'Quota resets in 3 hours.' } })]) {
    assert.equal(isAntigravityPromptRefusal(system, 429, text, null), false);
  }
});
