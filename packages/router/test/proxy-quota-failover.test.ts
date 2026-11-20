// The request that discovers a spent provider fails over in that same turn (2026-11-20).
//
// ProviderHealth keeps exhaustion in memory, so after every router restart the first request to a
// provider whose quota is spent went to it, and its 429 was handed to the client with
// `x-should-retry: false`: the live router logged `-> 429 upstream 429` for OpenCode Go's weekly
// limit after each of four restarts, and only the request after it failed over to Claude. These
// drive the real CONNECT/TLS proxy, started fresh (as after a restart), against local upstreams.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

import { CertStore } from "../src/certs.ts";
import { DEFAULTS, type Config } from "../src/config.ts";
import { providerExhaustion, UpstreamHealth } from "../src/health.ts";
import { Logger } from "../src/log.ts";
import { saveClaudeOAuthAccount } from "../src/providers/anthropic-accounts.ts";
import { ObservedClaudeCodeAuth } from "../src/providers/anthropic-observed.ts";
import { OpenAiCompatibleAdapter } from "../src/providers/openai/index.ts";
import { Proxy } from "../src/proxy.ts";
import { RequestLog, type RequestRecord } from "../src/requestlog.ts";
import { CLAUDE_SMALL_MODEL } from "../src/targets.ts";
import { createCa, createLeaf } from "../src/x509.ts";

const noClaudeCodeCredentialReaders = { keychain: () => null, credentialsFile: () => null };

/** OpenCode Go's answer once a plan's weekly window is spent (live router.log, 2026-11-20). */
const GO_WEEKLY_SPENT = JSON.stringify({ type: "error", error: { type: "GoUsageLimitError", message: "OpenCode Go usage limit reached (weekly, resets in 2d 19h)" }, metadata: { limitName: "weekly" } });
/** An Anthropic-shaped vendor whose key has used up its quota. */
const quotaSpent = (who = "this key"): string => JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: `insufficient_quota: the monthly quota of ${who} is used up` } });
/** An ordinary rate limit: a speed limit, not an exhaustion. */
const RATE_LIMITED = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Rate limit reached for requests per minute" } });

const TITLE = {
  model: "deepseek-v4.1-flash",
  max_tokens: 64,
  system: "Generate a concise, sentence-case title for this conversation.",
  messages: [{ role: "user", content: "Fix the flaky login test" }],
};
const AUX = { "x-claude-code-request-class": "auxiliary" };
const TURN = { model: "claude-opus-4-8", max_tokens: 16, metadata: { user_id: "user-1" }, messages: [{ role: "user", content: "hi" }] };

type Reply = { status: number; headers?: Record<string, string>; body?: string; chunks?: string[]; delayMs?: number };
type Hit = { url: string; body: Record<string, unknown> };
type Upstream = { port: number; hits: Hit[]; close: () => Promise<void> };

function anthropicMessage(model: unknown, text: string): string {
  return JSON.stringify({ id: "msg_up", type: "message", role: "assistant", model, stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 5, output_tokens: 2 } });
}

function anthropicSse(model: unknown, text: string): string[] {
  const event = (name: string, data: unknown): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  return [
    event("message_start", { type: "message_start", message: { id: "msg_up", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }),
    event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }),
    event("message_stop", { type: "message_stop" }),
  ];
}

const chatChunk = (model: string, delta: Record<string, unknown>, finish: string | null = null): string =>
  `data: ${JSON.stringify({ id: "chat_up", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

/** A whole Chat Completions stream answering `text`. */
function chatSse(model: string, text: string): string[] {
  return [
    chatChunk(model, { role: "assistant", content: text }),
    `data: ${JSON.stringify({ id: "chat_up", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`,
    "data: [DONE]\n\n",
  ];
}

/** Records every Messages/Chat call and answers whatever `reply` says. */
function serveWith(reply: (hit: Hit, n: number) => Reply, hits: Hit[]): http.RequestListener {
  return (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      // The Claude pool may read its usage on the side; only model calls are this test's business.
      if (req.method !== "POST") {
        res.writeHead(404, { "content-type": "application/json" }).end("{}");
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      const hit: Hit = { url: req.url ?? "", body: raw ? JSON.parse(raw) as Record<string, unknown> : {} };
      hits.push(hit);
      const r = reply(hit, hits.length);
      setTimeout(() => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(r.status, { "content-type": r.chunks ? "text/event-stream" : "application/json", ...(r.headers ?? {}) });
        if (r.chunks) {
          for (const chunk of r.chunks) res.write(chunk);
          res.end();
        } else {
          res.end(r.body ?? anthropicMessage(hit.body.model, "answer"));
        }
      }, r.delayMs ?? 0);
    });
  };
}

async function upstream(reply: (hit: Hit, n: number) => Reply): Promise<Upstream> {
  const hits: Hit[] = [];
  const server = http.createServer(serveWith(reply, hits));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as net.AddressInfo).port, hits, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const goProvider = (port: number): Config["providers"][string] => ({
  type: "openai-compatible", url: `http://127.0.0.1:${port}/v1`, preset: "opencode-go",
  headers: { authorization: "Bearer go-key" }, models: [{ id: "deepseek-v4.1-flash" }],
});
const compatible = (port: number, key: string): Config["providers"][string] => ({ type: "anthropic-compatible", url: `http://127.0.0.1:${port}`, headers: { "x-api-key": key } });
const POOL: Config["providers"][string] = { type: "anthropic", auth: "claude-code", accountPool: true };

type Sent = { status: number; headers: Record<string, string>; body: string };

async function rig(options: {
  providers: Config["providers"];
  routes?: Config["routes"];
  smallFast?: string;
  /** A Claude subscription account is stored, so the native pool can answer. */
  claude?: boolean;
  claudeReply?: (hit: Hit, n: number) => Reply;
  webSearch?: Config["webSearch"];
  observedClaudeCodeAuth?: ObservedClaudeCodeAuth;
}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-quota-failover-"));
  const ca = createCa({ cn: "quota failover test" });
  const leaf = createLeaf({ host: "localhost", caCertPem: ca.certPem, caKeyPem: ca.keyPem });
  fs.writeFileSync(path.join(home, "ca.pem"), ca.certPem);
  fs.writeFileSync(path.join(home, "ca.key"), ca.keyPem);
  if (options.claude) {
    saveClaudeOAuthAccount(home, { accessToken: "stored-token", refreshToken: "stored-refresh", expiresAt: Date.now() + 3_600_000, accountId: "stored-upstream-uuid", email: "stored@example.test" });
  }
  const claudeHits: Hit[] = [];
  const claudeReply = options.claudeReply ?? ((hit: Hit): Reply => hit.body.stream === true
    ? { status: 200, chunks: anthropicSse(hit.body.model, "Claude answered") }
    : { status: 200, body: anthropicMessage(hit.body.model, "Claude answered") });
  const claude = https.createServer({ cert: leaf.certPem, key: leaf.keyPem }, serveWith(claudeReply, claudeHits));
  const probe = net.createServer();
  await Promise.all([claude, probe].map((server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const cfg: Config = {
    ...DEFAULTS,
    upstream: "localhost",
    listen: { host: "127.0.0.1", port },
    providers: options.providers,
    routes: options.routes ?? {},
    direct: [],
    aliases: {},
    cli: { ...DEFAULTS.cli, ...(options.smallFast ? { models: { smallFast: options.smallFast } } : {}) },
    ...(options.webSearch ? { webSearch: options.webSearch } : {}),
  };
  // A save replaces the config object, as the live store does.
  let current = cfg;
  const requests = new RequestLog(path.join(home, "requests.jsonl"));
  const agent = new https.Agent({ ca: ca.certPem, lookup: (_host, _options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]) });
  const proxy = new Proxy({
    config: () => current,
    ...(options.observedClaudeCodeAuth ? { observedClaudeCodeAuth: options.observedClaudeCodeAuth } : {}),
    home,
    requests,
    claudeCodeCredentialReaders: noClaudeCodeCredentialReaders,
    agentDir: path.join(home, "agents"),
    log: new Logger(path.join(home, "router.log"), 1e6, 1, false),
    certs: new CertStore(home),
    health: new UpstreamHealth(() => 100, () => {}),
    upstreamPort: (claude.address() as net.AddressInfo).port,
    upstreamAgent: agent,
  });
  await proxy.listen();

  async function send(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Sent> {
    const socket = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    socket.write("CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n");
    await new Promise<void>((resolve, reject) => { socket.once("data", () => resolve()); socket.once("error", reject); });
    const secure = tls.connect({ socket, servername: "localhost", ca: ca.certPem });
    await new Promise<void>((resolve, reject) => { secure.once("secureConnect", resolve); secure.once("error", reject); });
    const raw = JSON.stringify(body);
    // Read to the end the response states (its length, or the last chunk): a stream keeps the
    // connection alive, so its close is not the end of the answer.
    const result = new Promise<string>((resolve, reject) => {
      let text = "";
      const whole = (): boolean => {
        const split = text.indexOf("\r\n\r\n");
        if (split < 0) return false;
        const head = text.slice(0, split);
        const length = /\r\ncontent-length:\s*(\d+)/i.exec(head);
        if (length) return Buffer.byteLength(text.slice(split + 4)) >= Number(length[1]);
        return /\r\ntransfer-encoding:\s*chunked/i.test(head) && /(?:^|\r\n)0\r\n\r\n$/.test(text.slice(split + 4));
      };
      secure.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); if (whole()) resolve(text); });
      secure.once("end", () => resolve(text));
      secure.once("close", () => resolve(text));
      secure.once("error", reject);
      secure.setTimeout(15_000, () => { secure.destroy(); reject(new Error("local proxy response timed out")); });
    });
    const extra = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("");
    secure.write(`POST /v1/messages HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nauthorization: Bearer app-login\r\ncontent-type: application/json\r\n${extra}content-length: ${Buffer.byteLength(raw)}\r\n\r\n${raw}`);
    const text = await result;
    secure.destroy();
    const split = text.indexOf("\r\n\r\n");
    const head = split < 0 ? text : text.slice(0, split);
    const parsed: Record<string, string> = {};
    for (const line of head.split("\r\n").slice(1)) {
      const at = line.indexOf(":");
      if (at > 0) parsed[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
    let rest = split < 0 ? "" : text.slice(split + 4);
    if (/chunked/i.test(parsed["transfer-encoding"] ?? "")) {
      let joined = "";
      while (rest.length > 0) {
        const eol = rest.indexOf("\r\n");
        const size = parseInt(rest.slice(0, eol), 16);
        if (!Number.isFinite(size) || size === 0) break;
        joined += rest.slice(eol + 2, eol + 2 + size);
        rest = rest.slice(eol + 2 + size + 2);
      }
      rest = joined;
    }
    // The record is written when the request finishes, which can trail the last byte by a tick.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1] ?? 0), headers: parsed, body: rest };
  }

  return {
    proxy, claudeHits, send,
    save: (next: (cfg: Config) => Config): void => { current = next(current); },
    rows: (): RequestRecord[] => requests.list(50, { kind: "messages" }),
    logs: (): string => fs.readFileSync(path.join(home, "router.log"), "utf8"),
    stop: async () => {
      proxy.close();
      agent.destroy();
      await new Promise<void>((resolve) => claude.close(() => resolve()));
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

const count = (text: string, pattern: RegExp): number => text.match(new RegExp(pattern.source, "g"))?.length ?? 0;
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

for (const stream of [false, true]) {
  test(`after a restart, the first small/fast request to a spent OpenCode Go plan is answered by Claude in that turn (${stream ? "streamed" : "not streamed"})`, async () => {
    const go = await upstream(() => ({ status: 429, body: GO_WEEKLY_SPENT }));
    const r = await rig({ providers: { "opencode-go": goProvider(go.port), anthropic: POOL }, smallFast: "deepseek-v4.1-flash", claude: true });
    try {
      const first = await r.send({ ...TITLE, stream }, AUX);
      assert.equal(first.status, 200, "the turn is answered, not refused");
      assert.match(first.body, /Claude answered/);
      assert.doesNotMatch(first.body, /usage limit|GoUsageLimitError/i, "nothing of the refusal reached the client");
      assert.equal(first.headers["x-should-retry"], undefined);
      assert.equal(go.hits.length, 1, "the spent plan was asked once");
      assert.equal(r.claudeHits.length, 1);
      const seen = r.claudeHits[0]!.body;
      assert.equal(seen.model, CLAUDE_SMALL_MODEL);
      assert.equal(seen.output_config, undefined, "the primary's effort did not follow it");
      assert.equal(seen.stream, stream);
      assert.deepEqual(seen.messages, TITLE.messages, "Claude got the request as the client sent it");
      assert.equal(seen.system, TITLE.system);

      const rows = r.rows();
      assert.equal(rows.length, 1, "one request, one record");
      assert.equal(rows[0]!.provider, "anthropic");
      assert.equal(rows[0]!.target, CLAUDE_SMALL_MODEL);
      assert.equal(rows[0]!.status, 200);
      assert.equal(rows[0]!.ok, true);
      assert.match(rows[0]!.note ?? "", /in-turn failover from opencode-go\/deepseek-v4\.1-flash \(429 quota_exhausted\)/);
      assert.match(rows[0]!.note ?? "", /fallback to Claude \(opencode-go unusable\)/);
      const log = r.logs();
      // The same line, and the same choice, as the request after a recorded exhaustion.
      assert.match(log, new RegExp(`FAILOVER opencode-go/deepseek-v4\\.1-flash → anthropic/${escape(CLAUDE_SMALL_MODEL)} reason=quota_exhausted`));
      assert.equal(count(log, /failing over in turn/), 1);

      const second = await r.send({ ...TITLE, stream }, AUX);
      assert.equal(second.status, 200);
      assert.equal(go.hits.length, 1, "the next request skips the spent plan without asking it");
      assert.equal(r.claudeHits.length, 2);
      assert.equal(count(r.logs(), /failing over in turn/), 1, "the next request takes the ordinary path");
    } finally { await r.stop(); await go.close(); }
  });
}

test("with no usable Claude the spent plan's refusal reaches the client as it always did", async () => {
  const go = await upstream(() => ({ status: 429, body: GO_WEEKLY_SPENT }));
  const r = await rig({ providers: { "opencode-go": goProvider(go.port), anthropic: POOL }, smallFast: "deepseek-v4.1-flash", claude: false });
  try {
    const sent = await r.send(TITLE, AUX);
    assert.equal(sent.status, 429);
    assert.equal(sent.headers["x-should-retry"], "false", "still a definite exhaustion to the client");
    assert.match(sent.body, /OpenCode Go usage limit reached/);
    assert.equal(go.hits.length, 1);
    assert.equal(r.claudeHits.length, 0);
    assert.doesNotMatch(r.rows()[0]!.note ?? "", /in-turn failover/);
    assert.equal(count(r.logs(), /failing over in turn/), 0);
  } finally { await r.stop(); await go.close(); }
});

test("an answer whose stream already started is never asked again elsewhere", async () => {
  // The plan answered 200 and began the answer, then reported its quota spent inside it. The client
  // already holds the start of that answer, and the vendor has started work it may bill for.
  const failing = [chatChunk("deepseek-v4.1-flash", { role: "assistant", content: "partial" }),
    `data: ${JSON.stringify({ error: { message: "insufficient_quota: OpenCode Go usage limit reached", code: "rate_limit_exceeded" } })}\n\n`];
  const go = await upstream(() => ({ status: 200, chunks: failing }));
  const r = await rig({ providers: { "opencode-go": goProvider(go.port), anthropic: POOL }, smallFast: "deepseek-v4.1-flash", claude: true });
  try {
    const sent = await r.send({ ...TITLE, stream: true }, AUX);
    assert.equal(sent.status, 200, "the stream had begun");
    assert.match(sent.body, /partial/);
    assert.match(sent.body, /rate_limit_error/, "the failure arrives inside the stream it belongs to");
    assert.equal(go.hits.length, 1);
    assert.equal(r.claudeHits.length, 0, "no second answer was started anywhere");
    assert.equal(count(r.logs(), /failing over in turn/), 0);
  } finally { await r.stop(); await go.close(); }
});

test("an upstream answer that started is not retried elsewhere even when nothing reached the client yet", async () => {
  // Not streamed to the client, so nothing has been written when the failure arrives; but the vendor
  // answered 200 and started generating, so asking another provider could bill the turn twice.
  const failing = [chatChunk("deepseek-v4.1-flash", { role: "assistant", content: "partial" }),
    `data: ${JSON.stringify({ error: { message: "insufficient_quota: OpenCode Go usage limit reached", code: "rate_limit_exceeded" } })}\n\n`];
  const go = await upstream(() => ({ status: 200, chunks: failing }));
  const r = await rig({ providers: { "opencode-go": goProvider(go.port), anthropic: POOL }, smallFast: "deepseek-v4.1-flash", claude: true });
  try {
    const sent = await r.send({ ...TITLE, stream: false }, AUX);
    assert.equal(sent.status, 429);
    assert.match(sent.body, /rate_limit_error/);
    assert.equal(go.hits.length, 1);
    assert.equal(r.claudeHits.length, 0, "the started answer was not replaced");
    assert.equal(count(r.logs(), /failing over in turn/), 0);
  } finally { await r.stop(); await go.close(); }
});

test("a route's configured fallback takes the turn a spent quota refused, across wires, with its own effort", async () => {
  const prim = await upstream(() => ({ status: 429, body: quotaSpent() }));
  const back = await upstream((hit) => ({ status: 200, chunks: chatSse(String(hit.body.model), "backup answered") }));
  const r = await rig({
    providers: {
      prim: compatible(prim.port, "prim-key"),
      back: { type: "openai-compatible", url: `http://127.0.0.1:${back.port}/v1`, headers: { authorization: "Bearer back-key" }, models: [{ id: "m2", effortLevels: ["low", "high"] }] },
    },
    routes: { "claude-opus-4-8": { provider: "prim", model: "m1", effort: "high", fallbacks: [{ provider: "back", model: "m2", effort: "low" }] } },
  });
  try {
    const first = await r.send(TURN);
    assert.equal(first.status, 200);
    assert.match(first.body, /backup answered/);
    assert.doesNotMatch(first.body, /insufficient_quota/);
    assert.equal(prim.hits.length, 1);
    assert.equal(back.hits.length, 1);
    assert.equal(back.hits[0]!.body.model, "m2");
    assert.equal(back.hits[0]!.body.reasoning_effort, "low", "the fallback's own effort, as on the next request");
    const row = r.rows()[0]!;
    assert.equal(row.provider, "back");
    assert.equal(row.target, "m2");
    assert.equal(row.effort, "low");
    assert.match(row.note ?? "", /in-turn failover from prim\/m1 \(429 quota_exhausted\)/);
    assert.match(r.logs(), /FAILOVER prim\/m1 → back\/m2 reason=quota_exhausted/);

    assert.equal((await r.send(TURN)).status, 200);
    assert.equal(prim.hits.length, 1, "the spent primary is not asked again");
    assert.equal(back.hits.length, 2);
  } finally { await r.stop(); await prim.close(); await back.close(); }
});

test("with no usable fallback the refusal is sent exactly as the provider wrote it", async () => {
  const body = quotaSpent("prim");
  const prim = await upstream(() => ({ status: 429, headers: { "retry-after": "120" }, body }));
  const back = await upstream(() => ({ status: 200 }));
  const r = await rig({
    providers: { prim: compatible(prim.port, "prim-key"), back: compatible(back.port, "back-key") },
    routes: { "claude-opus-4-8": { provider: "prim", model: "m1", fallbacks: [{ provider: "back", model: "m2" }] } },
  });
  try {
    r.proxy.providerHealth.observe("back", 429, providerExhaustion(429, "insufficient_quota", 3_600_000));
    const sent = await r.send(TURN);
    assert.equal(sent.status, 429);
    assert.equal(sent.body, body, "the provider's own bytes");
    assert.equal(sent.headers["x-should-retry"], "false");
    const wait = Number(sent.headers["retry-after"]);
    assert.ok(wait >= 119 && wait <= 120, `retry-after is the stated one: ${wait}`);
    assert.equal(prim.hits.length, 1);
    assert.equal(back.hits.length, 0, "an exhausted fallback is never called");
    assert.equal(count(r.logs(), /failing over in turn/), 0);
  } finally { await r.stop(); await prim.close(); await back.close(); }
});

test("one in-turn failover per request: a fallback that is spent too ends the turn with its own refusal", async () => {
  const prim = await upstream(() => ({ status: 429, body: quotaSpent("prim") }));
  const back = await upstream(() => ({ status: 429, body: quotaSpent("back") }));
  const third = await upstream(() => ({ status: 200 }));
  const r = await rig({
    providers: { prim: compatible(prim.port, "prim-key"), back: compatible(back.port, "back-key"), third: compatible(third.port, "third-key") },
    routes: { "claude-opus-4-8": { provider: "prim", model: "m1", fallbacks: [{ provider: "back", model: "m2" }, { provider: "third", model: "m3" }] } },
  });
  try {
    const sent = await r.send(TURN);
    assert.equal(sent.status, 429);
    assert.equal(sent.body, quotaSpent("back"), "the fallback's refusal, not the primary's");
    assert.equal(sent.headers["x-should-retry"], "false");
    assert.deepEqual([prim.hits.length, back.hits.length, third.hits.length], [1, 1, 0], "no third target inside the same turn");
    assert.equal(count(r.logs(), /failing over in turn/), 1);
    assert.equal(r.rows().length, 1, "one request, one record");

    assert.equal((await r.send(TURN)).status, 200, "the next request goes where both are known spent");
    assert.deepEqual([prim.hits.length, back.hits.length, third.hits.length], [1, 1, 1]);
  } finally { await r.stop(); await prim.close(); await back.close(); await third.close(); }
});

test("a plain rate limit is not an exhaustion: it reaches the client as before", async () => {
  const prim = await upstream(() => ({ status: 429, headers: { "retry-after": "30" }, body: RATE_LIMITED }));
  const back = await upstream(() => ({ status: 200 }));
  const r = await rig({
    providers: { prim: compatible(prim.port, "prim-key"), back: compatible(back.port, "back-key") },
    routes: { "claude-opus-4-8": { provider: "prim", model: "m1", fallbacks: [{ provider: "back", model: "m2" }] } },
  });
  try {
    const sent = await r.send(TURN);
    assert.equal(sent.status, 429);
    assert.equal(sent.body, RATE_LIMITED);
    assert.equal(sent.headers["x-should-retry"], undefined, "the client may retry a speed limit itself");
    assert.equal(back.hits.length, 0);
    assert.equal(count(r.logs(), /failing over in turn/), 0);
  } finally { await r.stop(); await prim.close(); await back.close(); }
});

test("a client that left before the refusal was handed over starts no fallback", async (t) => {
  // The disconnect is delivered at the exact handoff, without depending on TCP close timing: only the
  // socket knows at once that the client is gone (the response learns of it on a later event).
  const handle = OpenAiCompatibleAdapter.prototype.handle;
  t.mock.method(OpenAiCompatibleAdapter.prototype, "handle", async function (this: OpenAiCompatibleAdapter, ...args: Parameters<OpenAiCompatibleAdapter["handle"]>) {
    const result = await handle.apply(this, args);
    args[0].socket.destroy();
    return result;
  });
  const go = await upstream(() => ({ status: 429, body: GO_WEEKLY_SPENT }));
  const r = await rig({ providers: { "opencode-go": goProvider(go.port), anthropic: POOL }, smallFast: "deepseek-v4.1-flash", claude: true });
  try {
    await r.send(TITLE, AUX);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(go.hits.length, 1);
    assert.equal(r.claudeHits.length, 0, "nobody is left to answer");
    assert.equal(count(r.logs(), /failing over in turn/), 0);
    assert.equal(r.rows().length, 1, "the request still has its record");
    assert.equal(r.proxy.stats.inFlight, 0);
  } finally { await r.stop(); await go.close(); }
});

test("a Claude pool whose window is spent hands the turn to the route's fallback in that turn", async () => {
  const reset = Math.floor(Date.now() / 1000) + 3_600;
  const spent = {
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-5h-utilization": "1",
    "anthropic-ratelimit-unified-5h-reset": String(reset),
  };
  const back = await upstream(() => ({ status: 200 }));
  const r = await rig({
    providers: { anthropic: POOL, back: compatible(back.port, "back-key") },
    routes: { "claude-opus-4-8": { provider: "anthropic", model: "claude-opus-5", fallbacks: [{ provider: "back", model: "m2" }] } },
    claude: true,
    claudeReply: () => ({ status: 429, headers: spent, body: JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "rate limited" } }) }),
  });
  try {
    const sent = await r.send(TURN);
    assert.equal(sent.status, 200);
    assert.equal(r.claudeHits.length, 1, "the one account was asked once");
    assert.equal(back.hits.length, 1);
    assert.equal(back.hits[0]!.body.model, "m2");
    const row = r.rows()[0]!;
    assert.equal(row.provider, "back");
    assert.match(row.note ?? "", /in-turn failover from anthropic\/claude-opus-5 \(429 window_spent\)/);
    assert.match(r.logs(), /FAILOVER anthropic\/claude-opus-5 → back\/m2 reason=provider_unusable/);
  } finally { await r.stop(); await back.close(); }
});

test("a config saved while the spent target was asked sends its refusal: the request does not fail over on the config it read", async () => {
  // The save removes the fallback this request read at its start. Going there anyway would send the
  // turn to a target the config no longer allows.
  let saving: (() => void) | undefined;
  const prim = await upstream(() => { saving?.(); return { status: 429, body: quotaSpent("prim") }; });
  const back = await upstream(() => ({ status: 200 }));
  const r = await rig({
    providers: { prim: compatible(prim.port, "prim-key"), back: compatible(back.port, "back-key") },
    routes: { "claude-opus-4-8": { provider: "prim", model: "m1", fallbacks: [{ provider: "back", model: "m2" }] } },
  });
  saving = () => r.save((cfg) => ({ ...cfg, routes: { "claude-opus-4-8": { provider: "prim", model: "m1" } } }));
  try {
    const sent = await r.send(TURN);
    assert.equal(sent.status, 429);
    assert.equal(sent.body, quotaSpent("prim"));
    assert.equal(sent.headers["x-should-retry"], "false");
    assert.equal(prim.hits.length, 1);
    assert.equal(back.hits.length, 0, "the removed fallback was not called");
    assert.equal(count(r.logs(), /failing over in turn/), 0);
  } finally { await r.stop(); await prim.close(); await back.close(); }
});

const WEB_FETCH = {
  model: "claude-haiku-5-5", max_tokens: 8192, stream: false,
  system: [{ type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." }],
  messages: [{ role: "user", content: [{ type: "text", text: "\nWeb page content:\n---\nNode.js 24 is current.\n---\n\nWhich release is current?\n\nProvide a concise response based on the content above. Include relevant details, code examples, and documentation excerpts as needed.\n" }] }],
  tools: [], metadata: { user_id: "webfetch-test" },
};

test("a web-fetch reader's refusal is no evidence about the answer the original destination then starts", async () => {
  // The reader (webSearch) and the slot's route are the same spent provider and model. The reader's
  // refusal sends the request back to the route, which asks the provider again because its fallback
  // is spent too; that second answer starts (200) and then fails inside the stream. By then the
  // fallback is usable again, but the started answer must not be asked again elsewhere.
  let r: Awaited<ReturnType<typeof rig>> | undefined;
  const failing = [chatChunk("x", { role: "assistant", content: "partial" }),
    `data: ${JSON.stringify({ error: { message: "insufficient_quota: OpenCode Go usage limit reached", code: "rate_limit_exceeded" } })}\n\n`];
  const reader = await upstream((_hit, n) => {
    if (n === 1) return { status: 429, body: GO_WEEKLY_SPENT };
    r!.proxy.providerHealth.clear("back");
    return { status: 200, chunks: failing };
  });
  const back = await upstream(() => ({ status: 200 }));
  r = await rig({
    providers: {
      reader: { type: "openai-compatible", url: `http://127.0.0.1:${reader.port}/v1`, headers: { authorization: "Bearer reader-key" }, models: [{ id: "x" }] },
      back: compatible(back.port, "back-key"),
    },
    routes: { "claude-haiku-5-5": { provider: "reader", model: "x", fallbacks: [{ provider: "back", model: "m2" }] } },
    webSearch: { provider: "reader", model: "x" },
  });
  try {
    r.proxy.providerHealth.observe("back", 429, providerExhaustion(429, "insufficient_quota", 3_600_000));
    const sent = await r.send(WEB_FETCH);
    assert.equal(reader.hits.length, 2, "the reader, then the original destination");
    assert.equal(back.hits.length, 0, "the started answer was not replaced");
    assert.notEqual(sent.status, 200);
    assert.equal(count(r.logs(), /failing over in turn/), 0);
  } finally { await r.stop(); await reader.close(); await back.close(); }
});

test("the caller's Claude login is observed once per request, not again by the attempt a failover starts", async (t) => {
  const observed = new ObservedClaudeCodeAuth();
  const observe = t.mock.method(observed, "observe");
  const prim = await upstream(() => ({ status: 429, body: quotaSpent("prim") }));
  const back = await upstream(() => ({ status: 200 }));
  const r = await rig({
    providers: { prim: compatible(prim.port, "prim-key"), back: compatible(back.port, "back-key") },
    routes: { "claude-opus-4-8": { provider: "prim", model: "m1", fallbacks: [{ provider: "back", model: "m2" }] } },
    observedClaudeCodeAuth: observed,
  });
  try {
    const sent = await r.send(TURN);
    assert.equal(sent.status, 200);
    assert.equal(back.hits.length, 1);
    assert.equal(count(r.logs(), /failing over in turn/), 1);
    assert.equal(observe.mock.callCount(), 1);
  } finally { await r.stop(); await prim.close(); await back.close(); }
});

test("an OpenAI-compatible key out of balance (402) hands the turn to the fallback in that turn", async () => {
  // mapHttpError turns the vendor's 402 into a 400 for the client, so the held refusal is a 400.
  const prim = await upstream(() => ({ status: 402, body: JSON.stringify({ error: { message: "Insufficient balance", type: "insufficient_balance" } }) }));
  const back = await upstream(() => ({ status: 200 }));
  const r = await rig({
    providers: {
      prim: { type: "openai-compatible", url: `http://127.0.0.1:${prim.port}/v1`, headers: { authorization: "Bearer prim-key" }, models: [{ id: "m1" }] },
      back: compatible(back.port, "back-key"),
    },
    routes: { "claude-opus-4-8": { provider: "prim", model: "m1", fallbacks: [{ provider: "back", model: "m2" }] } },
  });
  try {
    const sent = await r.send(TURN);
    assert.equal(sent.status, 200);
    assert.match(sent.body, /answer/);
    assert.doesNotMatch(sent.body, /Insufficient balance/);
    assert.equal(prim.hits.length, 1);
    assert.equal(back.hits.length, 1);
    const row = r.rows()[0]!;
    assert.equal(row.provider, "back");
    assert.match(row.note ?? "", /in-turn failover from prim\/m1 \(402 insufficient_balance\)/);
  } finally { await r.stop(); await prim.close(); await back.close(); }
});
