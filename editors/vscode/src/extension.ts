/**
 * Omnigent VS Code extension entry point.
 *
 * activate() wires:
 *  - The activity-bar Sessions tree, scoped to this folder or all sessions
 *  - Commands to open sessions and create one here with a chosen harness
 *  - EditorPanelController: the single editor-beside iframe surface
 *  - ServerConnection: local discovery or a remote credential proxy, shared by
 *    the panel and Sessions tree and re-resolved when serverUrl changes
 *  - CLI commands to start Omnigent, host on a server, or set up models
 */
import * as vscode from "vscode";
import { EditorPanelController } from "./panel/EditorPanelController";
import { registerOpenPanel } from "./commands/openPanel";
import { registerConnect } from "./commands/connect";
import { registerSignOut } from "./commands/signOut";
import { registerLocalHost } from "./commands/localHost";
import { registerSessionCommands } from "./commands/sessions";
import { ServerConnection } from "./servers/connection";
import { SessionsTreeProvider } from "./sessions/SessionsTreeProvider";
import { SESSIONS_VIEW_ID } from "./sessions/constants";

let output: vscode.OutputChannel | undefined;
let controller: EditorPanelController | undefined;
let connection: ServerConnection | undefined;
let sessions: SessionsTreeProvider | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel("Omnigent");
  context.subscriptions.push(output);
  output.appendLine("[omnigent] activating");

  // ── Single editor-beside iframe surface ───────────────────────────────────
  controller = new EditorPanelController(context.extensionUri, output);
  connection = new ServerConnection(context, controller, output);
  context.subscriptions.push(connection);

  // ── Activity-bar Sessions tree ────────────────────────────────────────────
  sessions = new SessionsTreeProvider(context, connection, output);
  context.subscriptions.push(sessions);
  const sessionsView = vscode.window.createTreeView(SESSIONS_VIEW_ID, {
    treeDataProvider: sessions,
    showCollapseAll: false,
  });
  context.subscriptions.push(
    sessionsView,
    sessionsView.onDidChangeVisibility((event) => sessions?.setVisible(event.visible)),
    vscode.window.onDidChangeWindowState((event) => sessions?.setWindowFocused(event.focused)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => sessions?.refreshIfVisible()),
  );
  sessions.setWindowFocused(vscode.window.state.focused);
  sessions.setVisible(sessionsView.visible);

  // ── Commands ───────────────────────────────────────────────────────────────
  registerOpenPanel(context, controller);
  registerConnect(context, connection, controller);
  registerSignOut(context, connection);
  registerLocalHost(context, connection, controller);
  registerSessionCommands(context, connection, controller, sessions);

  // ── Resolve the server now and whenever the setting changes ───────────────
  const active = connection;
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("omnigent.serverUrl")) {
        void active.refresh();
      }
    }),
  );
  void active.refresh();

  output.appendLine("[omnigent] ready");
}

export function deactivate(): void {
  sessions?.dispose();
  sessions = undefined;
  connection?.dispose();
  connection = undefined;
  controller?.dispose();
  controller = undefined;
  output?.appendLine("[omnigent] deactivating");
  output = undefined;
}
