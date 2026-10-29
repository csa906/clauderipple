// Claude in Chrome's model menu: what is offered, where its turns go, and how its two lists are edited.
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULTS, type Config, type Provider } from "../src/config.ts";
import { validate } from "../src/config.ts";
import {
  CHROME_FEATURES_PATH,
  CLAUDE_IN_CHROME_ORIGIN,
  chromeEditFor,
  chromeExtensionModels,
  chromeExtensionRoute,
  chromePac,
  injectChromeFeatures,
  injectChromeSelector,
  isChromeExtensionRequest,
  isChromeListRequest,
  requestClient,
} from "../src/chrome-extension.ts";

function config(enabled = true): Config {
  return {
    ...DEFAULTS,
    providers: {
      chatgpt: { type: "anthropic-compatible", url: "http://127.0.0.1:1/anthropic", models: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-astra" }] } as Provider,
      claude: { type: "anthropic", auth: "claude-code", accountPool: true, models: [{ id: "claude-sonnet-5-5" }] } as Provider,
    },
    cli: {
      ...DEFAULTS.cli,
      extraModels: [
        { model: "gpt-6.1-sol", name: "GPT-6.1 Sol", description: "routed" },
        { model: "gpt-6-astra@high", name: "GPT-6 Astra" },
        { model: "claude-sonnet-5-5", name: "Sonnet 5.5" },
        { model: "nowhere", name: "Nowhere" },
      ],
    },
    chromeExtension: { enabled },
  };
}

/** The extension's cached feature payload, trimmed to what the menu reads (2026-10-29). */
function features(): Record<string, unknown> {
  return {
    features: {
      chrome_ext_backend_model_selector: { on: false, value: false },
      chrome_ext_models: {
        on: true,
        value: {
          default: "claude-sonnet-5-5",
          default_model_override_id: "2026-10-07-sonnet-5-5",
          options: [
            { model: "claude-opus-5-5", name: "Opus 5.5", description: "Most capable", effort_options: ["low", "medium", "high"], prefix_locked: true },
            { model: "claude-sonnet-5-5", name: "Sonnet 5.5", description: "Most efficient", effort_options: ["low", "medium", "high"], prefix_locked: true, knowledgeCutoff: "2026-01", notice_text: "new", xml_system_reminders: false, capabilities: { vision: true } },
            "claude-haiku-5-5",
          ],
        },
      },
    },
  };
}

test("the extension's network rule tag is recognised", () => {
  assert.equal(isChromeExtensionRequest({ "anthropic-client-platform": "claude_browser_extension" }), true);
  assert.equal(isChromeExtensionRequest({ "anthropic-client-platform": " Claude_Browser_Extension " }), true);
  assert.equal(isChromeExtensionRequest({}), false);
  assert.equal(isChromeExtensionRequest({ "anthropic-client-platform": "cli" }), false);
  assert.equal(isChromeExtensionRequest({ "user-agent": "claude-browser-extension/1.0.102" }), false, "a user agent alone is not the tag");
});

test("the extension is its origin plus a sign-in of its own; any other browser context is just a browser", () => {
  const signedIn = { authorization: "Bearer t" };
  assert.equal(requestClient({ origin: CLAUDE_IN_CHROME_ORIGIN, ...signedIn }), "claude-in-chrome");
  assert.equal(requestClient({ origin: CLAUDE_IN_CHROME_ORIGIN, "x-api-key": "k" }), "claude-in-chrome", "its API-key mode");
  assert.equal(requestClient({ origin: CLAUDE_IN_CHROME_ORIGIN }), "browser", "no sign-in, no trust");
  assert.equal(requestClient({ origin: "https://evil.example", "anthropic-client-platform": "claude_browser_extension", ...signedIn }), "browser", "the rule tags pages too");
  assert.equal(requestClient({ origin: "chrome-extension://another", ...signedIn }), "browser");
  assert.equal(requestClient({ origin: "null", ...signedIn }), "browser", "a sandboxed frame");
  assert.equal(requestClient({ "anthropic-client-platform": "claude_browser_extension", ...signedIn }), "browser", "a tag with no origin is not the extension's turn");
  assert.equal(requestClient({ "sec-fetch-site": "cross-site", ...signedIn }), "browser");
  // Claude Code: Node's fetch sends sec-fetch-mode but neither Origin nor sec-fetch-site.
  assert.equal(requestClient({ "sec-fetch-mode": "cors", "user-agent": "claude-cli/2.1.310", ...signedIn }), null);
  assert.equal(requestClient({}), null);
});

test("a list response is edited for the extension's own request only", () => {
  assert.equal(isChromeListRequest({ origin: CLAUDE_IN_CHROME_ORIGIN, authorization: "Bearer t" }), true);
  assert.equal(isChromeListRequest({ "anthropic-client-platform": "claude_browser_extension", authorization: "Bearer t" }), true, "its GET may carry no origin");
  assert.equal(isChromeListRequest({ "anthropic-client-platform": "claude_browser_extension" }), false, "it always signs in");
  assert.equal(isChromeListRequest({ origin: "https://evil.example", "anthropic-client-platform": "claude_browser_extension", authorization: "Bearer t" }), false);
});

test("the extension is offered the picker models a non-Anthropic provider serves, and only while on", () => {
  assert.deepEqual(chromeExtensionModels(config()).map((m) => m.model), ["gpt-6.1-sol", "gpt-6-astra@high"]);
  assert.deepEqual(chromeExtensionModels(config(false)), []);
  const unset = config();
  delete unset.chromeExtension;
  assert.deepEqual(chromeExtensionModels(unset), [], "off unless set");
});

test("an extension turn routes only on an offered id, and no marker in its body can move it", () => {
  const cfg = config();
  assert.equal(chromeExtensionRoute("gpt-6.1-sol", cfg)?.provider, "chatgpt");
  assert.equal(chromeExtensionRoute("gpt-6-astra@high", cfg)?.model, "gpt-6-astra");
  assert.equal(chromeExtensionRoute("claude-sonnet-5-5", cfg), null, "its own Claude model stays on its own sign-in");
  assert.equal(chromeExtensionRoute("gpt-6-astra", cfg), null, "an id the menu did not list");
  assert.equal(chromeExtensionRoute("gpt-6.1-sol", config(false)), null);
  assert.equal(chromeExtensionRoute(undefined, cfg), null);
});

test("a Claude id stays the extension's own even when the picker maps it elsewhere", () => {
  const cfg = config();
  cfg.cli.extraModels.push({ model: "claude-haiku-5-5", name: "Haiku 5.5 (GPT)" });
  cfg.routes = { "claude-haiku-5-5": { provider: "chatgpt", model: "gpt-6-astra" } };
  assert.equal(chromeExtensionModels(cfg).some((m) => m.model === "claude-haiku-5-5"), false);
  assert.equal(chromeExtensionRoute("claude-haiku-5-5", cfg), null);
});

test("an offered slot loses its fallbacks onto this router's Claude accounts", () => {
  const cfg = config();
  cfg.cli.extraModels.push({ model: "slot", name: "Slot" });
  cfg.routes = { slot: { provider: "chatgpt", model: "gpt-6.1-sol", fallbacks: [{ provider: "claude", model: "claude-sonnet-5-5" }, { provider: "chatgpt", model: "gpt-6-astra" }] } };
  assert.deepEqual(chromeExtensionRoute("slot", cfg)?.fallbacks, [{ provider: "chatgpt", model: "gpt-6-astra" }]);
});

test("the two lists are recognised by method and path", () => {
  assert.equal(chromeEditFor("GET", CHROME_FEATURES_PATH), "features");
  assert.equal(chromeEditFor("GET", "/api/organizations/0f3c-uuid/model_selector/chrome"), "selector");
  assert.equal(chromeEditFor("PATCH", "/api/organizations/0f3c-uuid/model_selector_state/chrome"), null, "the sticky choice is not a list");
  assert.equal(chromeEditFor("GET", "/api/organizations/0f3c-uuid/model_selector/code"), null);
  assert.equal(chromeEditFor("POST", CHROME_FEATURES_PATH), null);
  assert.equal(chromeEditFor("GET", "/api/bootstrap/features/claude_in_chrome/extra"), null);
});

test("menu options are cloned from the default option, minus what is that Claude model's own", () => {
  const json = features();
  const efforts: Record<string, string[]> = { "gpt-6.1-sol": ["low", "medium", "high", "xhigh", "max"], "gpt-6-astra": ["xhigh", "max"] };
  const n = injectChromeFeatures(json, chromeExtensionModels(config()), (model) => efforts[model]);
  assert.equal(n, 2);
  const value = (json.features as { chrome_ext_models: { value: { default: string; options: unknown[] } } }).chrome_ext_models.value;
  assert.equal(value.default, "claude-sonnet-5-5", "the default stays the extension's");
  assert.equal(value.options.length, 5);
  assert.deepEqual(value.options[3], { model: "gpt-6.1-sol", name: "GPT-6.1 Sol", description: "routed", effort_options: ["low", "medium", "high"], prefix_locked: true, capabilities: { vision: true } });
  assert.deepEqual(value.options[4], { model: "gpt-6-astra@high", name: "GPT-6 Astra", prefix_locked: true, capabilities: { vision: true } }, "no level the menu can show → no effort menu, no inherited description");
  assert.equal(injectChromeFeatures(json, chromeExtensionModels(config())), 0, "a repeat adds nothing");
});

test("a model nobody declares levels for keeps the template's effort menu", () => {
  const json = features();
  injectChromeFeatures(json, [{ model: "m", name: "M" }]);
  const options = (json.features as { chrome_ext_models: { value: { options: Record<string, unknown>[] } } }).chrome_ext_models.value.options;
  assert.deepEqual(options.at(-1)?.effort_options, ["low", "medium", "high"]);
});

test("a feature payload of another shape is left alone", () => {
  assert.equal(injectChromeFeatures({}, [{ model: "m", name: "M" }]), 0);
  assert.equal(injectChromeFeatures({ features: { chrome_ext_models: { value: {} } } }, [{ model: "m", name: "M" }]), 0, "no options list to add to");
  assert.equal(injectChromeFeatures({ features: { chrome_ext_models: { value: [] } } }, [{ model: "m", name: "M" }]), 0);
  assert.equal(injectChromeFeatures(features(), []), 0);
});

test("the backend list gains the same ids, cloned from an enabled Claude entry", () => {
  const json: Record<string, unknown> = {
    model_selector_config: [{
      id: "chrome",
      models: [
        { id: "claude-opus-4-1", name: "Opus 4.1", section: "legacy", disabled: true },
        { id: "claude-sonnet-5-5", name: "Sonnet 5.5", description: "Claude's", badge: "new", section: "main", thinking: { effort_options: [{ id: "low" }, { id: "medium" }, { id: "high", recommended: true }] } },
      ],
    }],
    model_selector_state: [{ model: "claude-sonnet-5-5" }],
  };
  const n = injectChromeSelector(json, chromeExtensionModels(config()), (model) => model === "gpt-6.1-sol" ? ["medium", "high", "xhigh"] : undefined);
  assert.equal(n, 2);
  const models = (json.model_selector_config as { models: Record<string, unknown>[] }[])[0]!.models;
  assert.deepEqual(models[2], { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", description: "routed", section: "main", thinking: { effort_options: [{ id: "medium" }, { id: "high", recommended: true }] } });
  assert.equal(models[3]!.id, "gpt-6-astra@high");
  assert.equal("badge" in models[3]!, false);
  assert.deepEqual(json.model_selector_state, [{ model: "claude-sonnet-5-5" }], "the sticky choice is not touched");
  assert.equal(injectChromeSelector({ model_selector_config: [{ models: [{ id: "other" }] }] }, [{ model: "m", name: "M" }]), 0, "no Claude template → nothing");
  assert.equal(injectChromeSelector({}, [{ model: "m", name: "M" }]), 0);
});

test("the PAC sends the API host to the proxy and everything else direct", () => {
  const pac = chromePac({ ...DEFAULTS, listen: { host: "127.0.0.1", port: 8790 } });
  assert.match(pac, /if \(host === "api\.anthropic\.com"\) return "PROXY 127\.0\.0\.1:8790; DIRECT";/);
  assert.match(pac, /return "DIRECT";/);
  assert.match(chromePac({ ...DEFAULTS, listen: { host: "::1", port: 9000 } }), /PROXY \[::1\]:9000/);
  assert.match(chromePac({ ...DEFAULTS, listen: { host: "0.0.0.0", port: 9000 } }), /PROXY 127\.0\.0\.1:9000/, "a wildcard bind is reached on loopback");
  // The script is evaluated by Chrome: it must at least be valid JavaScript with the expected answer.
  const find = new Function(`${pac}; return FindProxyForURL;`)() as (url: string, host: string) => string;
  assert.equal(find("https://api.anthropic.com/v1/messages", "api.anthropic.com"), "PROXY 127.0.0.1:8790; DIRECT");
  assert.equal(find("https://claude.ai/new", "claude.ai"), "DIRECT");
});

test("chromeExtension must be an object with a boolean switch", () => {
  assert.deepEqual(validate({ ...DEFAULTS, chromeExtension: { enabled: true } }), []);
  assert.ok(validate({ ...DEFAULTS, chromeExtension: { enabled: "yes" } } as unknown as Config).includes("chromeExtension.enabled must be true or false"));
  assert.ok(validate({ ...DEFAULTS, chromeExtension: true } as unknown as Config).includes("chromeExtension must be an object"));
});
