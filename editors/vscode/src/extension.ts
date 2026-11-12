/**
 * Omnigent VS Code extension entry point (iframe build).
 *
 * activate() wires:
 *  - A minimal Sessions/home tree view (so the activity-bar icon renders) whose
 *    welcome content offers an "Open Omnigent" button
 *  - EditorPanelController: the single editor-beside iframe surface
 *  - ServerConnection: local-server discovery, or a remote server through the
 *    local credential proxy, re-resolved when `omnigent.serverUrl` changes
 *  - The omnigent.open, omnigent.connect, and omnigent.signOut commands
 *  - Commands that run the `omnigent` CLI to start Omnigent on this computer,
 *    host on the connected server, or set up Unity Gateway models
 */
import * as vscode from "vscode";
import { EditorPanelController } from "./panel/EditorPanelController";
import { registerOpenPanel } from "./commands/openPanel";
import { registerConnect } from "./commands/connect";
import { registerSignOut } from "./commands/signOut";
import { registerLocalHost } from "./commands/localHost";
import { ServerConnection } from "./servers/connection";

/** Id of the minimal activity-bar view (declared in package.json contributes.views). */
const HOME_VIEW_ID = "omnigent.home";

let output: vscode.OutputChannel | undefined;
let controller: EditorPanelController | undefined;
let connection: ServerConnection | undefined;

/**
 * A no-op tree provider. A `viewsContainer` only renders its activity-bar icon
 * when it has at least one registered view; this provides that view. The actual
 * call-to-action is the `viewsWelcome` "Open Omnigent" button in package.json.
 */
class HomeTreeProvider implements vscode.TreeDataProvider<never> {
  getTreeItem(element: never): vscode.TreeItem {
    return element;
  }
  getChildren(): never[] {
    return [];
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel("Omnigent");
  context.subscriptions.push(output);
  output.appendLine("[omnigent] activating");

  // ── Single editor-beside iframe surface ───────────────────────────────────
  controller = new EditorPanelController(context.extensionUri, output);
  connection = new ServerConnection(context, controller, output);
  context.subscriptions.push(connection);

  // ── Minimal activity-bar view (makes the container icon render) ────────────
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(HOME_VIEW_ID, new HomeTreeProvider()),
  );

  // ── Commands ───────────────────────────────────────────────────────────────
  registerOpenPanel(context, controller);
  registerConnect(context, connection, controller);
  registerSignOut(context, connection);
  registerLocalHost(context, connection, controller);

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
  connection?.dispose();
  connection = undefined;
  controller?.dispose();
  controller = undefined;
  output?.appendLine("[omnigent] deactivating");
  output = undefined;
}
