/** Commands behind the Sessions tree: open, create, refresh, and change scope. */
import * as vscode from "vscode";
import type { EditorPanelController } from "../panel/EditorPanelController";
import type { ServerConnection } from "../servers/connection";
import type { ServerTarget } from "../config";
import { HOST_HERE_COMMAND } from "./localHost";
import { NetworkError } from "../net/request";
import { SessionsApi, type HostSummary } from "../sessions/api";
import { harnessChoices, type HarnessChoice } from "../sessions/harnesses";
import { normalizeHostId, readLocalHostIdentity } from "../sessions/hostIdentity";
import { repositoryWorktrees, worktreeForWorkspace } from "../sessions/worktrees";
import type { RepositoryWorktrees } from "../sessions/worktrees";
import type {
  SessionNode,
  SessionsTreeProvider,
  WorktreeNode,
} from "../sessions/SessionsTreeProvider";
import { targetFolder } from "./worktrees";
import {
  LAST_AGENT_STATE_KEY,
  NEW_SESSION_COMMAND,
  NEW_SESSION_HERE_COMMAND,
  NEW_WORKTREE_SESSION_COMMAND,
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

interface HarnessSelection {
  api: SessionsApi;
  target: ServerTarget;
  host: HostSummary;
  choice: HarnessChoice;
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
    vscode.commands.registerCommand(NEW_WORKTREE_SESSION_COMMAND, async () => {
      await newWorktreeSession(context, connection, controller, sessions);
    }),
    vscode.commands.registerCommand(NEW_SESSION_HERE_COMMAND, async (node?: WorktreeNode) => {
      if (!node) {
        return;
      }
      const workspace = await targetFolder(node);
      await createInFolder(context, connection, controller, sessions, {
        workspace,
        folderName: node.worktree.branch ?? workspace,
      });
    }),
    vscode.commands.registerCommand(REFRESH_SESSIONS_COMMAND, () => sessions.refresh()),
    vscode.commands.registerCommand(SHOW_FOLDER_SESSIONS_COMMAND, () =>
      sessions.setScope("folder"),
    ),
    vscode.commands.registerCommand(SHOW_ALL_SESSIONS_COMMAND, () => sessions.setScope("all")),
  );
}

interface CreateTarget {
  workspace: string;
  folderName: string;
  git?: { branchName: string; baseBranch?: string };
}

async function newSession(
  context: vscode.ExtensionContext,
  connection: ServerConnection,
  controller: EditorPanelController,
  sessions: SessionsTreeProvider,
): Promise<void> {
  const folder = await pickWorkspaceFolder();
  if (!folder) {
    if (!vscode.workspace.workspaceFolders?.length) {
      void vscode.window.showWarningMessage("Open a folder in VS Code to create a session in it.");
    }
    return;
  }
  await createInFolder(context, connection, controller, sessions, {
    workspace: folder.uri.fsPath,
    folderName: folder.name,
  });
}

/** Create a session whose host checks out a new worktree off the main checkout. */
async function newWorktreeSession(
  context: vscode.ExtensionContext,
  connection: ServerConnection,
  controller: EditorPanelController,
  sessions: SessionsTreeProvider,
): Promise<void> {
  const folder = await pickWorkspaceFolder();
  if (!folder) {
    if (!vscode.workspace.workspaceFolders?.length) {
      void vscode.window.showWarningMessage("Open a folder in VS Code to create a session in it.");
    }
    return;
  }
  const repository = await repositoryWorktrees(folder.uri.fsPath);
  if (repository.worktrees.length === 0) {
    void vscode.window.showWarningMessage(
      `${folder.name} isn't a git repository. Create a session in this folder instead.`,
    );
    return;
  }
  const git = await pickWorktreeBranch(repository);
  if (!git) {
    return;
  }
  await createInFolder(context, connection, controller, sessions, {
    workspace: folder.uri.fsPath,
    folderName: folder.name,
    git,
  });
}

/** A new branch name in the web app's style, plus which commit to start from. */
async function pickWorktreeBranch(
  repository: RepositoryWorktrees,
): Promise<{ branchName: string; baseBranch?: string } | undefined> {
  const branchName = await vscode.window.showInputBox({
    title: "New Session in a New Worktree",
    prompt: "Branch to create for the worktree",
    value: `worktree-${Math.random().toString(16).slice(2, 10)}`,
    validateInput: (value) => (value.trim() === "" ? "Enter a branch name." : undefined),
  });
  if (!branchName) {
    return undefined;
  }
  const mainBranch = repository.worktrees.find((worktree) => worktree.isMain)?.branch;
  const currentBranch = worktreeForWorkspace(repository.worktrees, repository.folder)?.branch;
  interface BasePick extends vscode.QuickPickItem {
    baseBranch?: string;
  }
  const picks: BasePick[] = [
    {
      label: "$(repo) Main checkout",
      description: mainBranch ? `Start from ${mainBranch}` : "Start from the main checkout's HEAD",
      baseBranch: undefined,
    },
  ];
  if (currentBranch && currentBranch !== mainBranch) {
    picks.push({
      label: "$(git-branch) This window's branch",
      description: `Start from ${currentBranch}`,
      baseBranch: currentBranch,
    });
  }
  const base =
    picks.length === 1
      ? picks[0]
      : await vscode.window.showQuickPick(picks, { title: `Base for ${branchName}` });
  if (!base) {
    return undefined;
  }
  return { branchName: branchName.trim(), baseBranch: base.baseBranch };
}

async function createInFolder(
  context: vscode.ExtensionContext,
  connection: ServerConnection,
  controller: EditorPanelController,
  sessions: SessionsTreeProvider,
  target: CreateTarget,
): Promise<void> {
  const selection = await pickHostAndHarness(
    context,
    connection,
    controller,
    sessions,
    target.folderName,
  );
  if (!selection) {
    return;
  }
  await createAndOpen(context, connection, controller, sessions, selection, target);
}

/** The server, this computer as an online host, and the harness to launch. */
async function pickHostAndHarness(
  context: vscode.ExtensionContext,
  connection: ServerConnection,
  controller: EditorPanelController,
  sessions: SessionsTreeProvider,
  folderName: string,
): Promise<HarnessSelection | undefined> {
  const target = connection.serverTarget;
  if (!target) {
    controller.ensure();
    void vscode.window.showWarningMessage(
      "Start or connect to an Omnigent server before creating a session.",
    );
    return undefined;
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
      return undefined;
    }

    const lastUsedAgentId = context.globalState.get<string>(LAST_AGENT_STATE_KEY);
    const choices = harnessChoices(agents, host, lastUsedAgentId);
    if (choices.length === 0) {
      void vscode.window.showErrorMessage("The server didn't return any coding agents.");
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(harnessPicks(choices, lastUsedAgentId), {
      title: `New Omnigent Session in ${folderName}`,
      placeHolder: "Choose a coding agent",
      matchOnDescription: true,
    });
    if (!picked?.choice) {
      return undefined;
    }
    const choice = picked.choice;
    if (!choice.available) {
      void vscode.window.showWarningMessage(
        `${choice.label} isn't ready on this computer: ${choice.unavailableReason}.`,
      );
      return undefined;
    }
    if (connection.serverTarget?.baseUrl !== target.baseUrl) {
      void vscode.window.showWarningMessage("The Omnigent server changed. Choose a harness again.");
      return undefined;
    }
    return { api, target, host, choice };
  } catch (error) {
    reportCreateError(error, sessions);
    return undefined;
  }
}

async function createAndOpen(
  context: vscode.ExtensionContext,
  connection: ServerConnection,
  controller: EditorPanelController,
  sessions: SessionsTreeProvider,
  selection: HarnessSelection,
  target: CreateTarget,
): Promise<void> {
  const { api, target: server, host, choice } = selection;
  try {
    const created = await api.createSession({
      agentId: choice.agentId,
      hostId: host.id,
      workspace: target.workspace,
      git: target.git,
    });
    await context.globalState.update(LAST_AGENT_STATE_KEY, choice.agentId);
    if (target.git && !created.gitBranch) {
      void vscode.window.showWarningMessage(
        "The server didn't report a new worktree. It may be too old to create one; check where the session is running before relying on it.",
      );
    }
    if (connection.serverTarget?.baseUrl !== server.baseUrl) {
      void sessions.refresh();
      void vscode.window.showInformationMessage(
        `The session was created on ${server.displayUrl ?? server.baseUrl}, but VS Code switched servers. Switch back to open it.`,
      );
      return;
    }
    controller.openPath(`/c/${encodeURIComponent(created.id)}`);
    void sessions.refresh();
  } catch (error) {
    reportCreateError(error, sessions);
  }
}

function reportCreateError(error: unknown, sessions: SessionsTreeProvider): void {
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
