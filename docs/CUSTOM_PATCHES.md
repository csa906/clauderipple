# Personal ClaudeRipple patches

This branch preserves the locally customized ClaudeRipple 0.9.5 installation as source changes rather than a checked-in `node_modules` directory.

- Upstream: https://github.com/PBJ-2/clauderipple
- Release baseline: `0a12daf386610c5dbc740c830b4b4f70e3911b62` (`clauderipple@0.9.5`).
- The installed package was compared against the official npm archive with its SHA-512 integrity verified.
- Original license and attribution remain in place: GPL-3.0-only. No affiliation with Anthropic or OpenAI is implied.

## Included changes

### Global GPT Fast control

The Dashboard and Ripple bar share one router-owned setting for all current and future sessions, including GPT requests without a session header. The Dashboard has no session selector.

- `GET /api/fast` returns `{ scope: "global", fast, revision }`.
- `PUT /api/fast` accepts only `{ fast: true | false | null }`.
- `true` requests priority, `false` suppresses priority, and `null` preserves the original request/provider defaults.
- The historical `/api/session-fast` route remains a compatibility alias for older loaded bars; its writes also change the global setting.
- Storage uses version 2 of `session-fast.json`. A valid version 1 file with unanimous explicit choices preserves that choice; empty or mixed choices become Auto. The original file remains untouched until the first explicit save.
- Each in-flight request keeps its initial Fast intent across retries. A setting change applies to later requests.
- Clients show acknowledged state, reject stale replies, and refresh about every three seconds. A lost write acknowledgement is treated as unknown until a read reconciles it, not as proof that the value was unchanged.
- This setting controls routed ChatGPT requests, not native Anthropic `/fast` or billing preferences.

### Existing local extensions retained

- Opt-in native GPT Fast capability synchronization through `cli.gptFastModels`, with ownership tracking and a recovery journal for settings writes. See `ARCHITECTURE.md` for its limitations and startup behavior.
- Requested and response-reported service tiers kept separate in Fast request logging and display.
- Antigravity SDK-prompt refusal classification without stripping the prompt, unnecessarily cooling down accounts, or retrying the same incompatible prompt on other accounts.
- Opaque native select-menu backgrounds for readable options in dark mode.

### Source/build support

The router and CLI changes are implemented in their original TypeScript sources. UI and mod sources are kept in `packages/ui` and `packages/mod`. Build output and installed dependencies are not committed.

The package builder launches the local TypeScript compiler through Node rather than spawning `npm.cmd`, which fails with `EINVAL` on Windows. The tray build remains its existing TypeScript compile.

## Build and verification

Requires Node 24 or later and npm. Dependency lifecycle scripts are not needed for compilation and the custom regression tests:

```bash
npm ci --ignore-scripts
```

```bash
npm run build
```

```bash
npm run test:custom
```

The custom test runner creates and removes an isolated temporary home. `CLAUDERIPPLE_TEST_TMP`, when supplied, selects the existing parent directory for that temporary folder. Tests do not need to modify a live installation or restart the daily-use router.

Additional checks:

```bash
npm run typecheck
```

```bash
npm test
```

The mod engine tests need a compatible Claude Code installation:

```bash
claude plugin validate packages/mod
```

```bash
claude plugin test packages/mod
```

Dependency installation with `--ignore-scripts` does not download Electron's runtime binary. Running or packaging the actual tray application may require Electron's normal setup separately; it is not needed for the source checks above.

## Local verification snapshot

Checked on Windows with Node 24.16.0 on 2026-10-20:

| Check | Result |
| --- | --- |
| `npm run build` | Passed; distribution rebuilt from TypeScript sources |
| `npm run typecheck` | Passed, including the remote web and relay projects |
| `npm run test:custom` | 162 passed on the final run |
| Mod engine tests | 154 passed, 25 failed; the failing test names exactly match the unmodified release baseline in this environment |
| Publication review | No personal runtime files or newly added real credentials identified |

One custom integration run hit its five-second local HTTP timeout; rerunning the unchanged code passed all 162 tests. The full upstream `npm test` run was **not green**: it reported failures in CLI/remote environment and platform fixtures and did not finish, so it was stopped. Those full-suite failures have not all been compared against a clean upstream checkout. Do not interpret the targeted results as a full-suite pass.

The unchanged dependency lockfile also reported 17 audit findings (10 moderate, 7 high) during `npm ci`; this patch set does not claim to remediate those dependencies.

## Private runtime data is not part of this branch

This source checkout does not include account credentials, OAuth tokens, API keys, personal settings, session state, certificates/private keys, or request/conversation logs. Installing or checking out this branch does not itself enable Fast, change model routing, or replace an existing installation.
