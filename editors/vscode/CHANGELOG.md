# Changelog

All notable changes to the Omnigent VS Code extension are documented here.

## [Unreleased]

- Add an activity-bar Sessions view with **This Folder** (including git worktrees) and
  **All Sessions** scopes, session status, harness labels, and automatic refresh.
- Open a session from the tree in the editor-beside panel.
- Create a session in the current workspace folder with a chosen coding agent, with
  last-used ordering and per-host availability.

## [0.1.0]

Initial release — a minimal, iframe-only client for a locally running Omnigent
server.

- Open a running local Omnigent server in an editor-beside panel.
- **Omnigent: Open** command, available from the editor-title bar and the
command palette, plus an activity-bar view with an "Open Omnigent" button.
- Automatically discovers a local server via `~/.omnigent/local_server.pid`, or
point the extension at one with the `omnigent.serverUrl` setting. Localhost
servers only in this build.

