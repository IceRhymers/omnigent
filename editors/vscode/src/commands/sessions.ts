/** Commands behind the Sessions tree: open, create, refresh, and change scope. */
import * as vscode from "vscode";
import type { EditorPanelController } from "../panel/EditorPanelController";
import type { ServerConnection } from "../servers/connection";
import { HOST_HERE_COMMAND } from "./localHost";
import { NetworkError } from "../net/request";
import { SessionsApi } from "../sessions/api";
import { harnessChoices, type HarnessChoice } from "../sessions/harnesses";
import { normalizeHostId, readLocalHostIdentity } from "../sessions/hostIdentity";
import type { SessionNode, SessionsTreeProvider } from "../sessions/SessionsTreeProvider";
import {
  LAST_AGENT_STATE_KEY,
  NEW_SESSION_COMMAND,
  OPEN_SESSION_COMMAND,
  REFRESH_SESSIONS_COMMAND,
  SHOW_ALL_SESSIONS_COMMAND,
  SHOW_FOLDER_SESSIONS_COMMAND,
} from "../sessions/constants";

interface HarnessPick extends vscode.QuickPickItem {
  choice?: HarnessChoice;
}

interface FolderPick extends vscode.QuickPickItem {
  folder: vscode.WorkspaceFolder;
}

export function registerSessionCommands(
  context: vscode.ExtensionContext,
  connection: ServerConnection,
  controller: EditorPanelController,
  sessions: SessionsTreeProvider,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_SESSION_COMMAND, (node?: SessionNode | string) => {
      const id = typeof node === "string" ? node : node?.session.id;
      if (!id) {
        return;
      }
      if (!connection.serverTarget) {
        controller.ensure();
        void vscode.window.showWarningMessage("Connect to an Omnigent server first.");
        return;
      }
      controller.openPath(`/c/${encodeURIComponent(id)}`);
    }),
    vscode.commands.registerCommand(NEW_SESSION_COMMAND, async () => {
      await newSession(context, connection, controller, sessions);
    }),
    vscode.commands.registerCommand(REFRESH_SESSIONS_COMMAND, () => sessions.refresh()),
    vscode.commands.registerCommand(SHOW_FOLDER_SESSIONS_COMMAND, () =>
      sessions.setScope("folder"),
    ),
    vscode.commands.registerCommand(SHOW_ALL_SESSIONS_COMMAND, () => sessions.setScope("all")),
  );
}

async function newSession(
  context: vscode.ExtensionContext,
  connection: ServerConnection,
  controller: EditorPanelController,
  sessions: SessionsTreeProvider,
): Promise<void> {
  const target = connection.serverTarget;
  if (!target) {
    controller.ensure();
    void vscode.window.showWarningMessage(
      "Start or connect to an Omnigent server before creating a session.",
    );
    return;
  }
  const folder = await pickWorkspaceFolder();
  if (!folder) {
    if (vscode.workspace.workspaceFolders?.length) {
      return;
    }
    void vscode.window.showWarningMessage("Open a folder in VS Code to create a session in it.");
    return;
  }

  const api = SessionsApi.forTarget(target);
  try {
    const [hosts, agents, identity] = await Promise.all([
      api.listHosts(),
      api.listAgents(),
      readLocalHostIdentity(),
    ]);
    const host = hosts.find(
      (candidate) =>
        candidate.sandboxProvider === undefined && normalizeHostId(candidate.id) === identity?.id,
    );
    if (!host || host.status !== "online") {
      const connect = "Connect This Computer";
      const picked = await vscode.window.showInformationMessage(
        "This computer isn't an online Omnigent host on the connected server. Connect it to create sessions in this folder.",
        connect,
      );
      if (picked === connect) {
        await vscode.commands.executeCommand(HOST_HERE_COMMAND);
      }
      return;
    }

    const lastUsedAgentId = context.globalState.get<string>(LAST_AGENT_STATE_KEY);
    const choices = harnessChoices(agents, host, lastUsedAgentId);
    if (choices.length === 0) {
      void vscode.window.showErrorMessage("The server didn't return any coding agents.");
      return;
    }
    const picked = await vscode.window.showQuickPick(harnessPicks(choices, lastUsedAgentId), {
      title: `New Omnigent Session in ${folder.name}`,
      placeHolder: "Choose a coding agent",
      matchOnDescription: true,
    });
    if (!picked?.choice) {
      return;
    }
    const choice = picked.choice;
    if (!choice.available) {
      void vscode.window.showWarningMessage(
        `${choice.label} isn't ready on this computer: ${choice.unavailableReason}.`,
      );
      return;
    }
    if (connection.serverTarget?.baseUrl !== target.baseUrl) {
      void vscode.window.showWarningMessage("The Omnigent server changed. Choose a harness again.");
      return;
    }

    const id = await api.createSession({
      agentId: choice.agentId,
      hostId: host.id,
      workspace: folder.uri.fsPath,
    });
    await context.globalState.update(LAST_AGENT_STATE_KEY, choice.agentId);
    if (connection.serverTarget?.baseUrl !== target.baseUrl) {
      void sessions.refresh();
      void vscode.window.showInformationMessage(
        `The session was created on ${target.displayUrl ?? target.baseUrl}, but VS Code switched servers. Switch back to open it.`,
      );
      return;
    }
    controller.openPath(`/c/${encodeURIComponent(id)}`);
    void sessions.refresh();
  } catch (error) {
    if (error instanceof NetworkError && error.timedOut) {
      void sessions.refresh();
      void vscode.window.showWarningMessage(
        "The session launch timed out, but it may still complete. Refresh Sessions before retrying so you don't create a duplicate.",
      );
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Couldn't create the Omnigent session: ${detail}`);
  }
}

function harnessPicks(choices: readonly HarnessChoice[], lastUsedAgentId?: string): HarnessPick[] {
  const picks: HarnessPick[] = [];
  let previousAvailability: boolean | undefined;
  for (const choice of choices) {
    if (choice.available !== previousAvailability) {
      picks.push({
        label: choice.available ? "Available" : "Unavailable on this computer",
        kind: vscode.QuickPickItemKind.Separator,
      });
      previousAvailability = choice.available;
    }
    picks.push({
      label: `$(${choice.agentId === lastUsedAgentId ? "history" : "terminal"}) ${choice.label}`,
      description: choice.available
        ? [choice.agentId === lastUsedAgentId ? "Last used" : undefined, choice.warning]
            .filter((part) => part !== undefined)
            .join(" · ") || undefined
        : choice.unavailableReason,
      choice,
    });
  }
  return picks;
}

async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter(
    (folder) => folder.uri.scheme === "file",
  );
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const activeFolder = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
  const active = folders.find((folder) => folder.uri.toString() === activeFolder?.uri.toString());
  if (active) {
    return active;
  }
  if (folders.length <= 1) {
    return folders[0];
  }
  const picks: FolderPick[] = folders.map((folder) => ({
    label: `$(folder) ${folder.name}`,
    description: folder.uri.fsPath,
    folder,
  }));
  return (await vscode.window.showQuickPick(picks, { title: "Choose the session's folder" }))
    ?.folder;
}
