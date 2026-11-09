/**
 * "Omnigent: Sign Out of Server" — sign the panel out of the connected remote
 * server. The CLI's own `omnigent login` session is left alone, but the panel
 * stops reusing it until the next sign-in in VS Code.
 */
import * as vscode from "vscode";
import type { ServerConnection } from "../servers/connection";

export const SIGN_OUT_COMMAND = "omnigent.signOut";

export function registerSignOut(
  context: vscode.ExtensionContext,
  connection: ServerConnection,
): vscode.Disposable {
  const command = vscode.commands.registerCommand(SIGN_OUT_COMMAND, async () => {
    const serverUrl = await connection.signOut();
    if (serverUrl === undefined) {
      void vscode.window.showInformationMessage("Omnigent isn't connected to a remote server.");
      return;
    }
    void vscode.window.showInformationMessage(`Signed out of ${new URL(serverUrl).host}.`);
  });
  context.subscriptions.push(command);
  return command;
}
