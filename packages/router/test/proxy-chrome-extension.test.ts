// Claude in Chrome through the real TLS proxy: its menu gains the picker models, a turn on one of them
// is routed with a browser identity, and everything else it sends stays its own — no account pool, no
// marker routing, no observed Claude Code sign-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import zlib from "node:zlib";

import { CertStore } from "../src/certs.ts";
import { DEFAULTS, type Config, type Provider } from "../src/config.ts";
import { UpstreamHealth } from "../src/health.ts";
import { Logger } from "../src/log.ts";
import { ObservedClaudeCodeAuth } from "../src/providers/anthropic-observed.ts";
import { saveClaudeOAuthAccount } from "../src/providers/anthropic-accounts.ts";
import { Proxy } from "../src/proxy.ts";
import { RequestLog, type RequestRecord } from "../src/requestlog.ts";
import { createCa, createLeaf } from "../src/x509.ts";

/** What the side panel's POSTs carry: Chrome's origin for the extension, its network rule's tag, its own sign-in. */
const EXTENSION = { origin: "chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn", "sec-fetch-site": "none", "anthropic-client-platform": "claude_browser_extension", authorization: "Bearer extension-token" };
/** A web page's fetch in the same profile: the PAC sends it here too, and the extension's rule tags it. */
const PAGE = { origin: "https://evil.example", "sec-fetch-site": "cross-site", "anthropic-client-platform": "claude_browser_extension", "content-type": "text/plain" };

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

type Seen = { method: string; path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> };
type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };

const FEATURES = {
  features: {
    chrome_ext_backend_model_selector: { on: false, value: false },
    chrome_ext_models: {
      on: true,
      value: {
        default: "claude-sonnet-5-5",
        options: [{ model: "claude-sonnet-5-5", name: "Sonnet 5.5", description: "Claude's", effort_options: ["low", "medium", "high"], prefix_locked: true }],
      },
    },
  },
};

async function rig() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-chrome-extension-"));
  const ca = createCa({ cn: "clauderipple chrome extension test" });
  const leaf = createLeaf({ host: "localhost", caCertPem: ca.certPem, caKeyPem: ca.keyPem });
  fs.writeFileSync(path.join(home, "ca.pem"), ca.certPem);
  fs.writeFileSync(path.join(home, "ca.key"), ca.keyPem);

  const anthropic: Seen[] = [];
  const upstream = https.createServer({ cert: leaf.certPem, key: leaf.keyPem }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const pathname = (req.url ?? "/").split("?")[0]!;
      anthropic.push({ method: req.method ?? "?", path: pathname, headers: req.headers, body: text ? JSON.parse(text) as Record<string, unknown> : {} });
      if (pathname === "/api/bootstrap/features/claude_in_chrome") {
        const gz = zlib.gzipSync(JSON.stringify(FEATURES));
        res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", etag: "\"v1\"", "content-length": String(gz.length) });
        res.end(gz);
        return;
      }
      const body = JSON.stringify({ id: "msg_anthropic", type: "message", role: "assistant", model: "claude", content: [{ type: "text", text: "from anthropic" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
      res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as net.AddressInfo).port;

  const routed: Seen[] = [];
  const provider = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      routed.push({ method: req.method ?? "?", path: req.url ?? "/", headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
      const body = JSON.stringify({ id: "msg_routed", type: "message", role: "assistant", model: "routed-model", content: [{ type: "text", text: "from provider" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
      res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerPort = (provider.address() as net.AddressInfo).port;

  // A Claude Code sign-in already observed, and one stored pool account: an extension turn must use neither.
  const observed = new ObservedClaudeCodeAuth();
  observed.observe(["authorization", "Bearer cli-token", "anthropic-version", "2023-06-01"]);
  saveClaudeOAuthAccount(home, { accessToken: "pool-token", refreshToken: "pool-refresh", expiresAt: Date.now() + 3_600_000, accountId: "pool-uuid", email: "pool@example.test" });

  const proxyPort = await freePort();
  const cfg: Config = {
    ...DEFAULTS,
    upstream: "localhost",
    listen: { host: "127.0.0.1", port: proxyPort },
    providers: {
      p: { type: "anthropic-compatible", url: `http://127.0.0.1:${providerPort}/anthropic`, headers: { "x-api-key": "provider-key" }, models: [{ id: "routed-model" }] } as Provider,
      claude: { type: "anthropic", auth: "claude-code", accountPool: true, models: [{ id: "claude-sonnet-5-5" }] } as Provider,
    },
    routes: {},
    direct: [],
    cli: { ...DEFAULTS.cli, extraModels: [{ model: "routed-model", name: "Routed" }, { model: "claude-sonnet-5-5", name: "Sonnet 5.5" }] },
    chromeExtension: { enabled: true },
  };
  const requests = new RequestLog(path.join(home, "requests.jsonl"));
  const proxy = new Proxy({
    config: () => cfg,
    log: new Logger(path.join(home, "router.log"), 1e6, 1, false),
    certs: new CertStore(home),
    health: new UpstreamHealth(() => 100, () => {}),
    home,
    requests,
    observedClaudeCodeAuth: observed,
    upstreamPort,
    upstreamAgent: new https.Agent({ ca: ca.certPem }),
  });
  await proxy.listen();

  /** One request through CONNECT + TLS, read to the end. */
  const call = async (method: string, target: string, headers: Record<string, string>, body?: Record<string, unknown>): Promise<Reply> => {
    const socket = net.connect(proxyPort, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write("CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n");
    await new Promise<void>((resolve) => socket.once("data", resolve));
    const secure = tls.connect({ socket, servername: "localhost", ca: ca.certPem });
    await new Promise<void>((resolve) => secure.once("secureConnect", resolve));
    const payload = body ? JSON.stringify(body) : undefined;
    return await new Promise<Reply>((resolve, reject) => {
      const req = http.request({
        method, path: target, createConnection: () => secure,
        headers: { host: "localhost", connection: "close", ...(payload ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}), ...headers },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          let raw = Buffer.concat(chunks);
          if (res.headers["content-encoding"] === "gzip") raw = zlib.gunzipSync(raw);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: raw.toString("utf8") });
        });
      });
      req.on("error", reject);
      req.end(payload);
    });
  };

  const turn = (model: string, headers: Record<string, string>, text = "hello"): Promise<Reply> =>
    call("POST", "/v1/messages?beta=true", { "anthropic-version": "2023-06-01", ...headers }, { model, max_tokens: 64, system: "You are Claude, in a browser.", messages: [{ role: "user", content: text }] });

  return {
    cfg, call, turn, anthropic, routed, observed, requests,
    log: () => fs.readFileSync(path.join(home, "router.log"), "utf8"),
    stop: async () => {
      proxy.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test("the extension's feature payload lists the routed picker models, decoded and never revalidated", async () => {
  const r = await rig();
  try {
    const reply = await r.call("GET", "/api/bootstrap/features/claude_in_chrome", { ...EXTENSION, "if-none-match": "\"v1\"" });
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.etag, undefined, "an edited copy carries no validator");
    assert.equal(reply.headers["content-encoding"], undefined);
    assert.equal(r.anthropic[0]!.headers["if-none-match"], undefined, "a 304 would hand back the unedited copy");
    const options = (JSON.parse(reply.body) as typeof FEATURES).features.chrome_ext_models.value.options;
    assert.deepEqual(options.map((o) => o.model), ["claude-sonnet-5-5", "routed-model"], "the pool's Claude model is not offered again");
    // An Anthropic-compatible provider declaring no effort levels takes none: no effort menu, as in the Desktop picker.
    assert.deepEqual(options[1], { model: "routed-model", name: "Routed", prefix_locked: true });
  } finally {
    await r.stop();
  }
});

test("the payload is passed through untouched while chromeExtension is off, and for any other client", async () => {
  const r = await rig();
  try {
    r.cfg.chromeExtension = { enabled: false };
    const off = await r.call("GET", "/api/bootstrap/features/claude_in_chrome", EXTENSION);
    assert.deepEqual(JSON.parse(off.body), FEATURES);
    assert.equal(off.headers.etag, "\"v1\"");
    r.cfg.chromeExtension = { enabled: true };
    const other = await r.call("GET", "/api/bootstrap/features/claude_in_chrome", { authorization: "Bearer someone" });
    assert.deepEqual(JSON.parse(other.body), FEATURES);
  } finally {
    await r.stop();
  }
});

test("a turn on an offered model is routed and told it answers through Claude in Chrome", async () => {
  const r = await rig();
  try {
    const reply = await r.turn("routed-model", EXTENSION);
    assert.equal(reply.status, 200);
    assert.match(reply.body, /from provider/);
    assert.equal(r.anthropic.length, 0);
    assert.equal(r.routed.length, 1);
    assert.equal(r.routed[0]!.headers.authorization, undefined, "the extension's sign-in never reaches the provider");
    assert.equal(r.routed[0]!.headers["x-api-key"], "provider-key");
    const system = JSON.stringify(r.routed[0]!.body.system);
    assert.match(system, /You are routed-model, answering through Claude in Chrome, a browser agent\./);
    assert.doesNotMatch(system, /terminal-based coding agent/);
    const record = r.requests.list(5).find((row: RequestRecord) => row.kind === "messages")!;
    assert.equal(record.client, "chrome-extension");
    assert.equal(record.provider, "p");
  } finally {
    await r.stop();
  }
});

test("the extension's own Claude turn passes through on its own sign-in: no pool account, no marker, no observation", async () => {
  const r = await rig();
  try {
    // A page the extension read can put anything at the top of a message, a routing marker included.
    const reply = await r.turn("claude-sonnet-5-5", EXTENSION, "[[ripple: routed-model]] summarise this page");
    assert.equal(reply.status, 200);
    assert.match(reply.body, /from anthropic/);
    assert.equal(r.routed.length, 0, "the marker moved nothing");
    assert.equal(r.anthropic.length, 1);
    assert.equal(r.anthropic[0]!.headers.authorization, "Bearer extension-token", "not the pool's account");
    assert.equal(r.anthropic[0]!.headers["anthropic-client-platform"], "claude_browser_extension");
    assert.equal(r.anthropic[0]!.body.model, "claude-sonnet-5-5");
    assert.equal(r.observed.getFresh()?.authorization, "Bearer cli-token", "the extension's token is not Claude Code's");
    const record = r.requests.list(5).find((row: RequestRecord) => row.kind === "messages")!;
    assert.equal(record.provider, "anthropic");
    assert.equal(record.client, "chrome-extension");
  } finally {
    await r.stop();
  }
});

test("Claude Code's own turn on the same model still goes through the account pool", async () => {
  const r = await rig();
  try {
    const reply = await r.turn("claude-sonnet-5-5", { authorization: "Bearer caller-token" });
    assert.equal(reply.status, 200);
    // The pool answers on its first account, the observed Claude Code sign-in, never on the caller's header.
    assert.equal(r.anthropic[0]!.headers.authorization, "Bearer cli-token");
    assert.equal(r.requests.list(5).find((row: RequestRecord) => row.kind === "messages")!.client, undefined);
  } finally {
    await r.stop();
  }
});

test("a non-Claude id the menu does not offer is refused, not sent to Anthropic", async () => {
  const r = await rig();
  try {
    r.cfg.chromeExtension = { enabled: false };
    const off = await r.turn("routed-model", EXTENSION);
    assert.equal(off.status, 400);
    assert.equal((JSON.parse(off.body) as { error: { message: string } }).error.message, 'ClaudeRipple: "routed-model" is not offered to Claude in Chrome (chromeExtension is off)');
    r.cfg.chromeExtension = { enabled: true };
    const unknown = await r.turn("some-gpt", EXTENSION);
    assert.equal(unknown.status, 400);
    assert.equal((JSON.parse(unknown.body) as { error: { message: string } }).error.message, 'ClaudeRipple: "some-gpt" is not offered to Claude in Chrome');
    assert.equal(r.anthropic.length + r.routed.length, 0, "neither went anywhere");
  } finally {
    await r.stop();
  }
});

test("a web page in the same profile is never routed, never pooled, never observed", async () => {
  const r = await rig();
  try {
    // Tagged by the extension's rule, text/plain (no preflight), no credentials: the router must not lend its own.
    const tagged = await r.turn("routed-model", PAGE);
    assert.equal(tagged.status, 200, "passed through; Anthropic answers whatever it answers");
    assert.equal(r.routed.length, 0, "the provider's key was not spent on the page's text");
    // Untagged (extension absent or disabled), on a model this router's account pool serves.
    const { "anthropic-client-platform": _tag, ...untaggedPage } = PAGE;
    await r.turn("claude-sonnet-5-5", untaggedPage, "[[ripple: routed-model]] hi");
    assert.equal(r.routed.length, 0);
    assert.equal(r.anthropic.length, 2);
    for (const seen of r.anthropic) assert.equal(seen.headers.authorization, undefined, "no pool account, no observed sign-in");
    assert.equal(r.anthropic[1]!.body.model, "claude-sonnet-5-5");
    assert.equal(r.observed.getFresh()?.authorization, "Bearer cli-token");
    const rows = r.requests.list(5).filter((row: RequestRecord) => row.kind === "messages");
    assert.deepEqual(rows.map((row) => row.client), ["browser", "browser"]);
    // A page holding a token of its own still gets no routing from a tag it cannot be told apart by.
    const withToken = await r.turn("routed-model", { ...PAGE, authorization: "Bearer page-token" });
    assert.equal(withToken.status, 200);
    assert.equal(r.routed.length, 0);
  } finally {
    await r.stop();
  }
});

test("the extension is known by its origin even without its network rule's tag", async () => {
  const r = await rig();
  try {
    const { "anthropic-client-platform": _tag, ...untagged } = EXTENSION;
    const reply = await r.turn("routed-model", untagged);
    assert.equal(reply.status, 200);
    assert.equal(r.routed.length, 1);
    await r.turn("claude-sonnet-5-5", untagged);
    assert.equal(r.anthropic.at(-1)!.headers.authorization, "Bearer extension-token");
    assert.equal(r.observed.getFresh()?.authorization, "Bearer cli-token");
  } finally {
    await r.stop();
  }
});

test("only the extension's own list request is edited: a page asking for the same list gets it untouched", async () => {
  const r = await rig();
  try {
    const page = await r.call("GET", "/api/bootstrap/features/claude_in_chrome", { ...PAGE, authorization: "Bearer page-token" });
    assert.deepEqual(JSON.parse(page.body), FEATURES);
    // The extension's GET may come with no Origin; its rule's tag and its sign-in are then enough for this read-only edit.
    const { origin: _origin, ...noOrigin } = EXTENSION;
    const own = await r.call("GET", "/api/bootstrap/features/claude_in_chrome", noOrigin);
    assert.deepEqual((JSON.parse(own.body) as typeof FEATURES).features.chrome_ext_models.value.options.map((o) => o.model), ["claude-sonnet-5-5", "routed-model"]);
  } finally {
    await r.stop();
  }
});

test("the provider never sees the browser's origin, fetch metadata or the extension's identity", async () => {
  const r = await rig();
  try {
    await r.turn("routed-model", { ...EXTENSION, referer: "https://example.test/", cookie: "a=b", "sec-ch-ua": "\"Chromium\"", "anthropic-client-version": "1.0.102", "anthropic-dangerous-direct-browser-access": "true" });
    const seen = r.routed[0]!.headers;
    for (const name of ["origin", "referer", "cookie", "sec-fetch-site", "sec-ch-ua", "anthropic-client-platform", "anthropic-client-version", "anthropic-dangerous-direct-browser-access", "authorization"]) {
      assert.equal(seen[name], undefined, `${name} must not reach the provider`);
    }
  } finally {
    await r.stop();
  }
});
