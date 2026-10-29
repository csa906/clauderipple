// `clauderipple chrome on|off` flips one key of config.json and leaves every other key alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { setChromeExtensionEnabled, setPickerEnabled } from "../src/integrations.ts";
import { chromeLaunchLines, chromeOnInstructions } from "../src/chrome.ts";

test("the Chrome switch and the picker switch are separate keys of the same file", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-chrome-flag-"));
  const file = path.join(home, "config.json");
  try {
    fs.writeFileSync(file, JSON.stringify({ listen: { host: "127.0.0.1", port: 8790 }, picker: { enabled: true, hosts: ["claude.ai"] } }));
    setChromeExtensionEnabled(true, file);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { listen: { host: "127.0.0.1", port: 8790 }, picker: { enabled: true, hosts: ["claude.ai"] }, chromeExtension: { enabled: true } });
    setPickerEnabled(false, file);
    setChromeExtensionEnabled(false, file);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { listen: { host: "127.0.0.1", port: 8790 }, picker: { enabled: false, hosts: ["claude.ai"] }, chromeExtension: { enabled: false } });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a config that is not a JSON object is left untouched", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-chrome-flag-bad-"));
  const file = path.join(home, "config.json");
  try {
    fs.writeFileSync(file, "[]");
    assert.throws(() => setChromeExtensionEnabled(true, file), /is not a JSON object; left untouched/);
    assert.equal(fs.readFileSync(file, "utf8"), "[]");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the printed Chrome command works in the shell it is labelled for", () => {
  const pac = "http://127.0.0.1:8791/chrome.pac";
  const win = chromeLaunchLines("win32", String.raw`C:\Users\me\.clauderipple\chrome-profile`, pac);
  assert.deepEqual(win.map((l) => l.shell), ["PowerShell", "Command Prompt"]);
  assert.equal(win[0]!.line, String.raw`& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" --user-data-dir="C:\Users\me\.clauderipple\chrome-profile" --proxy-pac-url=http://127.0.0.1:8791/chrome.pac`, "PowerShell needs the call operator and $env:");
  assert.equal(win[1]!.line, String.raw`"%ProgramFiles%\Google\Chrome\Application\chrome.exe" --user-data-dir="C:\Users\me\.clauderipple\chrome-profile" --proxy-pac-url=http://127.0.0.1:8791/chrome.pac`);
  assert.deepEqual(chromeLaunchLines("darwin", "/Users/me/.clauderipple/chrome-profile", pac), [{ shell: "Terminal", line: 'open -na "Google Chrome" --args --user-data-dir="/Users/me/.clauderipple/chrome-profile" --proxy-pac-url=http://127.0.0.1:8791/chrome.pac' }]);
  assert.equal(chromeLaunchLines("linux", "/home/me/.clauderipple/chrome-profile", pac)[0]!.line, 'google-chrome --user-data-dir="/home/me/.clauderipple/chrome-profile" --proxy-pac-url=http://127.0.0.1:8791/chrome.pac');
});

test("chrome on names the admin port's script, a profile of its own, and the panel it cannot reach", () => {
  const text = chromeOnInstructions("darwin", "/Users/me/.clauderipple", 9001).join("\n");
  assert.match(text, /--proxy-pac-url=http:\/\/127\.0\.0\.1:9001\/chrome\.pac/);
  assert.match(text, /--user-data-dir="\/Users\/me\/\.clauderipple\/chrome-profile"/);
  assert.match(text, /hosted panel/);
  assert.match(text, /page text and screenshots/);
  assert.doesNotMatch(text, /%LOCALAPPDATA%/, "the per-user install note is Windows only");
  const windows = chromeOnInstructions("win32", String.raw`C:\h`, 8791).join("\n");
  assert.ok(windows.includes(String.raw`--user-data-dir="C:\h\chrome-profile"`), "a Windows path whatever the machine running this");
  assert.ok(windows.includes(String.raw`%LOCALAPPDATA%\Google\Chrome\Application`));
});
