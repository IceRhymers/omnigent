# Omnigent for VS Code

A minimal VS Code extension that opens Omnigent inside the editor — an editor-beside
pane that frames the same UI you see in your browser. It works with your **running
local Omnigent server** (`http://127.0.0.1:6767`) or a **remote Omnigent server** you
sign in to. It is a thin client of the server's existing HTTP API (`server/API.md`);
there is nothing new to run on the server side.

This started as a deliberately small donation (tracking
[omnigent-ai/omnigent#1219](https://github.com/omnigent-ai/omnigent/issues/1219)):
localhost discovery, the editor iframe pane, and the activity-bar / editor-title icons.
Sessions, diffs, send-selection, and embedded rendering are intentionally out of scope
for now.

## How it works

- On activation the extension discovers a locally running server via
  `~/.omnigent/local_server.pid` and a `/health` probe, or uses `omnigent.serverUrl`
  when it is set.
- The Omnigent activity-bar view offers an **Open Omnigent** button. The
  **Omnigent: Open** command (`omnigent.open`) — also on the editor title bar and in the
  command palette — opens an editor-beside pane that frames the server.
- A **local** server is framed directly; it is loopback and needs no auth, so no token
  ever appears in the iframe URL.
- A **remote** server is framed through a proxy the extension runs on `127.0.0.1`. The
  proxy forwards every request (including streams and WebSockets) to the server with
  your session as `Authorization: Bearer`, so no cookie or token reaches the webview.
  It answers only under a random per-launch path, and only for its own `Host` and
  `Origin`.

## Remote servers

Run **Omnigent: Connect to Server…** (`omnigent.connect`) and pick **This computer**, a
recent server, or **Enter server URL…** with the URL you open Omnigent at in your
browser (for example `https://omnigent.example.com`). Remote servers must use `https`.
The choice is saved to `omnigent.serverUrl`.

How you sign in depends on the server:

- **Single sign-on (OIDC)** — the panel shows **Sign in with browser**. Your browser
  completes the sign-in and the panel continues on its own.
- **Username and password (accounts)** — the server's own login page loads in the
  panel.
- If you already ran `omnigent login <server>` with the CLI, the panel reuses that
  session (read-only; the extension never writes the CLI's token file).

Sessions are kept in VS Code's secret storage and renewed before they expire.
**Omnigent: Sign Out of Server** (`omnigent.signOut`) signs the panel out and stops it
from reusing the CLI's session until you sign in again in VS Code; the CLI stays
signed in.

### Databricks Apps

Omnigent deployed as a Databricks App (`https://<app>.databricksapps.com`) signs you in
with your account on the workspace that hosts the app. The extension finds that
workspace from the app's sign-in redirect (or from an earlier `omnigent login` to the
app), then:

- reuses the [Databricks CLI](https://docs.databricks.com/dev-tools/cli/)'s sign-in
  when you have one: a `databricks-cli` profile for the workspace in
  `~/.databrickscfg` (`DATABRICKS_CONFIG_PROFILE` is tried first), else
  `databricks auth login --host <workspace>`. The extension only runs
  `databricks auth token`; it never changes the CLI's sign-in;
- otherwise shows **Sign in with Databricks**, which signs in through your browser.
  If the workspace doesn't allow that, the panel asks you to run
  `databricks auth login --host <workspace>` instead.

If the app turns you away (for example, you don't have permission to use it), the
panel shows the app's answer.

### Not supported yet

- Databricks-hosted Omnigent (`https://<workspace>/…/omnigent`).
- Servers behind a separate login service (`header` auth mode, e.g. an SSO proxy in
  front of Omnigent).
- Remote VS Code windows (SSH, containers, WSL, Codespaces).

The panel says so when it meets one of these and offers to open the server in your
browser instead.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `omnigent.serverUrl` | `""` | Server to open: a localhost URL (e.g. `http://127.0.0.1:6767`) or a remote `https://` URL; empty = auto-discover a local server. |

## Known limitations

- On macOS, VS Code does not deliver `Cmd+A/C/V` keystrokes into a cross-origin iframe
  inside a webview, so keyboard paste into the framed app's inputs does not work there.
  This is an upstream VS Code issue, not fixable from the extension for the iframe
  render path — see microsoft/vscode#129178 and microsoft/vscode#182642. (The on-page
  copy buttons and `navigator.clipboard` paths still work.)
- With a remote server, steps that leave the server's site (for example **Connect
  GitHub** or **Connect Databricks** in Settings) can't load in the panel; the panel
  offers to continue them in your browser.
- Magic links and invite links sign in your browser, not the panel.
- Username-and-password servers ask you to sign in again when their session expires
  (about every 8 hours by default), unless the panel is reusing a CLI session.
- For a Databricks App, **Sign in with Databricks** uses the Databricks CLI's account
  whenever the CLI is signed in to the workspace. To use a different account, sign the
  CLI in with it (`databricks auth login --host <workspace>`) first. Signing out of
  the panel doesn't sign the CLI out.
- Dictation inside the panel hasn't been verified with remote servers.

## Build / test / package

```bash
pnpm install --frozen-lockfile
pnpm run type-check   # tsc --noEmit
pnpm run test         # vitest run
pnpm run build        # esbuild -> dist/extension.js
pnpm run package      # @vscode/vsce package -> omnigent-vscode-<version>.vsix
```

Install the resulting `.vsix` via the Extensions view → "Install from VSIX…". The
`.vsix` runtime is `dist/extension.js` + `media/`.

## Layout

```
src/
├── extension.ts        # activate()/deactivate() — wires the panel, connection, commands, view
├── commands/           # omnigent.open, omnigent.connect, omnigent.signOut
├── panel/              # EditorPanelController, host.ts (render), iframeHtml.ts, csp.ts
├── config/             # settings + server-target resolution
├── discovery/          # local-server discovery (pidfile / health / liveness)
├── servers/            # remote-server recognition, the active connection, recents
├── auth/               # browser sign-in (Omnigent, Databricks), CLI session reuse, stored credentials
├── proxy/              # the loopback credential proxy and its own pages
└── net/                # back-channel JSON requests
```

Licensed under Apache-2.0 (see `LICENSE`). Contributions require a DCO sign-off
(`git commit -s`), per the repository `CONTRIBUTING.md`.
