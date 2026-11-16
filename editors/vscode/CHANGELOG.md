# Changelog

All notable changes to the Omnigent VS Code extension are documented here.

## [Unreleased]

- Add an activity-bar Sessions view with **This Folder** (including git worktrees) and
  **All Sessions** scopes, session status, harness labels, and automatic refresh.
- Open a session from the tree in the editor-beside panel.
- Create a session in the current workspace folder with a chosen coding agent, with
  last-used ordering and per-host availability.
- Group sessions by git worktree when the repository has several, with waiting/running
  counts per worktree and the current window's worktree first.
- **Omnigent: Switch Worktree…** and worktree row actions to open a worktree in a new or
  the current window (keeping the opened subfolder), open a terminal there, copy its
  path, or reveal it in the OS file manager. New `omnigent.worktrees.openIn` setting.
- **New Session in New Worktree…** asks the host to create a worktree (branch and base
  of your choice) with the session; a worktree row's **+** creates a session there.
- **Go to Worktree** on a session in another worktree opens that worktree's window with
  the session in the pane. The extension now activates on startup to receive the
  handoff, and consumes it when the window gains focus.

## [0.1.0]

Initial release — a minimal, iframe-only client for a locally running Omnigent
server.

- Open a running local Omnigent server in an editor-beside panel.
- **Omnigent: Open** command, available from the editor-title bar and the
command palette, plus an activity-bar view with an "Open Omnigent" button.
- Automatically discovers a local server via `~/.omnigent/local_server.pid`, or
point the extension at one with the `omnigent.serverUrl` setting. Localhost
servers only in this build.

