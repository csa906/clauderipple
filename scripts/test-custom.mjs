// Regression tests for the local extensions run against a freshly built dist, never the live router.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const parent = process.env.CLAUDERIPPLE_TEST_TMP || os.tmpdir();
const temporary = fs.mkdtempSync(path.join(parent, "clauderipple-custom-tests-"));
try {
  const tests = fs.readdirSync(path.join(root, "test"))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => path.join("test", name));
  if (!tests.length) throw new Error("No custom regression tests found");
  const result = spawnSync(process.execPath, ["--test", ...tests], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, CLAUDERIPPLE_TEST_TMP: temporary, CLAUDERIPPLE_HOME: temporary },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
