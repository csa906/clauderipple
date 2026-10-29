// `clauderipple chrome on|off`: Claude in Chrome lists the picker models in its own model menu.
//
// The extension cannot be pointed anywhere but api.anthropic.com, so Chrome reaches the router
// through a PAC that sends that host, and only it, to the proxy (router chrome-extension.ts). Chrome
// is left to the user: it reads a PAC switch only at start, and a profile of its own keeps the
// everyday one — and every page open in it — away from the router.

import path from "node:path";

export type LaunchLine = { shell: string; line: string };

/** How to start Chrome with the proxy script in a profile of its own, per shell the platform has. */
export function chromeLaunchLines(platform: NodeJS.Platform, profile: string, pac: string): LaunchLine[] {
  const args = `--user-data-dir="${profile}" --proxy-pac-url=${pac}`;
  if (platform === "win32") {
    return [
      { shell: "PowerShell", line: `& "$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe" ${args}` },
      { shell: "Command Prompt", line: `"%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" ${args}` },
    ];
  }
  if (platform === "darwin") return [{ shell: "Terminal", line: `open -na "Google Chrome" --args ${args}` }];
  return [{ shell: "shell", line: `google-chrome ${args}` }];
}

/** The profile directory the printed command names, inside this installation's home. */
export function chromeProfileDir(platform: NodeJS.Platform, home: string): string {
  return (platform === "win32" ? path.win32 : path.posix).join(home, "chrome-profile");
}

/** What `chrome on` prints after the switch is on. */
export function chromeOnInstructions(platform: NodeJS.Platform, home: string, adminPort: number): string[] {
  const pac = `http://127.0.0.1:${adminPort}/chrome.pac`;
  const lines = chromeLaunchLines(platform, chromeProfileDir(platform, home), pac);
  return [
    "",
    "The rest is yours: start Chrome with this proxy script, in a profile of its own" + (lines.length > 1 ? " (either line):" : ":"),
    ...lines.map(({ shell, line }) => `  ${shell}: ${line}`),
    (platform === "win32" ? "  (A per-user Chrome install lives under %LOCALAPPDATA%\\Google\\Chrome\\Application instead.)" : null),
    "Install Claude in Chrome there, sign in, and open its model menu: your picker models are listed after Claude's.",
    "If the side panel opens claude.ai's own view (the hosted panel, offered once you allow browser control), it keeps Claude's menu: that panel runs on claude.ai's servers.",
    "Only api.anthropic.com goes through ClaudeRipple; every other site stays direct. A model you pick there receives the page text and screenshots the extension sends.",
  ].filter((line): line is string => line !== null);
}
