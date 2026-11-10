/**
 * "Omnigent: Connect to Server…" — pick this computer's server, a recent
 * remote server, or enter a URL. The choice is written to `omnigent.serverUrl`;
 * the configuration listener in extension.ts reconnects the panel.
 */
import * as vscode from "vscode";
import { checkServerUrl, type ServerUrlCheck } from "../config";
import { DEFAULT_HEALTH_TIMEOUT_MS, discoverLocalServer } from "../discovery";
import { CONNECT_COMMAND, type ServerConnection } from "../servers/connection";
import { readRecentServers, RECENT_SERVERS_KEY } from "../servers/recents";
import type { EditorPanelController } from "../panel/EditorPanelController";

interface ServerPick extends vscode.QuickPickItem {
  /** `""` = auto-detect the local server; undefined = enter a URL. */
  serverUrl: string | undefined;
}

export function registerConnect(
  context: vscode.ExtensionContext,
  connection: ServerConnection,
  controller: EditorPanelController,
): vscode.Disposable {
  const command = vscode.commands.registerCommand(CONNECT_COMMAND, async () => {
    const picked = await vscode.window.showQuickPick(serverPicks(context), {
      title: "Connect to Omnigent Server",
      placeHolder: "Choose a server",
    });
    if (!picked) {
      return;
    }
    let serverUrl = picked.serverUrl;
    if (serverUrl === undefined) {
      serverUrl = await promptForServerUrl();
      if (serverUrl === undefined) {
        return;
      }
    }
    await saveServerUrl(serverUrl, connection);
    controller.ensure();
  });
  context.subscriptions.push(command);
  return command;
}

async function serverPicks(context: vscode.ExtensionContext): Promise<ServerPick[]> {
  const local = await discoverLocalServer(undefined, DEFAULT_HEALTH_TIMEOUT_MS).catch(() => null);
  const current = vscode.workspace.getConfiguration("omnigent").get<string>("serverUrl", "").trim();
  const currentUrl = current === "" ? "" : normalized(current);
  const picks: ServerPick[] = [
    {
      label: "$(device-desktop) This computer",
      description:
        local?.found && local.health === "ok"
          ? local.baseUrl
          : "Finds the server started with `omnigent server`",
      detail: currentUrl === "" ? "Current" : undefined,
      serverUrl: "",
    },
  ];
  const recents = readRecentServers(context.globalState.get(RECENT_SERVERS_KEY));
  if (recents.length > 0) {
    picks.push({ label: "Recent", kind: vscode.QuickPickItemKind.Separator, serverUrl: "" });
    for (const url of recents) {
      picks.push({
        label: `$(globe) ${new URL(url).host}`,
        description: url,
        detail: url === currentUrl ? "Current" : undefined,
        serverUrl: url,
      });
    }
  }
  picks.push({ label: "", kind: vscode.QuickPickItemKind.Separator, serverUrl: "" });
  picks.push({ label: "$(add) Enter server URL…", serverUrl: undefined });
  return picks;
}

async function promptForServerUrl(): Promise<string | undefined> {
  const raw = await vscode.window.showInputBox({
    title: "Connect to Omnigent Server",
    prompt: "The URL you open Omnigent at in your browser",
    placeHolder: "https://omnigent.example.com",
    ignoreFocusOut: true,
    validateInput: (value) => serverUrlProblem(checkServerUrl(value)),
  });
  if (raw === undefined) {
    return undefined;
  }
  const checked = checkServerUrl(raw);
  return checked.ok ? checked.url : undefined;
}

/** The input-box message for a URL check, or undefined when it is fine. */
export function serverUrlProblem(checked: ServerUrlCheck): string | undefined {
  if (checked.ok) {
    return undefined;
  }
  switch (checked.reason) {
    case "empty":
      return "Enter the server's URL.";
    case "invalid-url":
      return "Enter an http(s) URL, like https://omnigent.example.com.";
    case "insecure-remote":
      return "Remote servers must use https.";
  }
}

/** Write the setting where it takes effect, and reconnect if it didn't change. */
async function saveServerUrl(serverUrl: string, connection: ServerConnection): Promise<void> {
  const config = vscode.workspace.getConfiguration("omnigent");
  const inspected = config.inspect<string>("serverUrl");
  const target =
    inspected?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  const before = config.get<string>("serverUrl", "");
  await config.update("serverUrl", serverUrl === "" ? undefined : serverUrl, target);
  if (vscode.workspace.getConfiguration("omnigent").get<string>("serverUrl", "") === before) {
    // No configuration change event: reconnect explicitly.
    await connection.refresh();
  }
}

function normalized(raw: string): string {
  const checked = checkServerUrl(raw);
  return checked.ok ? checked.url : raw;
}
