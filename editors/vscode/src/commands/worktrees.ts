/**
 * Navigate between the worktrees of the opened repositories. All of this reads
 * local git, so it works without an Omnigent server; session status in the
 * picker comes from the Sessions tree's last load when there is one.
 */
import * as vscode from "vscode";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { repositoryWorktrees, worktreeForWorkspace } from "../sessions/worktrees";
import type { Worktree } from "../sessions/worktrees";
import type { SessionsTreeProvider, WorktreeNode } from "../sessions/SessionsTreeProvider";
import { effectiveStatus } from "../sessions/SessionsTreeProvider";
import {
  COPY_WORKTREE_PATH_COMMAND,
  OPEN_WORKTREE_COMMAND,
  OPEN_WORKTREE_CURRENT_COMMAND,
  REVEAL_WORKTREE_COMMAND,
  SWITCH_WORKTREE_COMMAND,
  WORKTREE_TERMINAL_COMMAND,
} from "../sessions/constants";

export interface WorktreeTarget {
  worktree: Worktree;
  /** The opened folder's path inside the worktree, preserved when navigating. */
  prefix: string;
}

interface WorktreePick extends vscode.QuickPickItem {
  target?: WorktreeTarget & { current: boolean };
}

export function registerWorktreeCommands(
  context: vscode.ExtensionContext,
  sessions: SessionsTreeProvider,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(SWITCH_WORKTREE_COMMAND, () => switchWorktree(sessions)),
    vscode.commands.registerCommand(OPEN_WORKTREE_COMMAND, (node?: WorktreeNode) =>
      openWorktree(node, "newWindow"),
    ),
    vscode.commands.registerCommand(OPEN_WORKTREE_CURRENT_COMMAND, (node?: WorktreeNode) =>
      openWorktree(node, "currentWindow"),
    ),
    vscode.commands.registerCommand(WORKTREE_TERMINAL_COMMAND, async (node?: WorktreeNode) => {
      if (!node) {
        return;
      }
      const terminal = vscode.window.createTerminal({
        name: node.worktree.branch ?? "Omnigent worktree",
        cwd: await targetFolder(node),
      });
      terminal.show();
    }),
    vscode.commands.registerCommand(COPY_WORKTREE_PATH_COMMAND, async (node?: WorktreeNode) => {
      if (node) {
        await vscode.env.clipboard.writeText(node.worktree.path);
      }
    }),
    vscode.commands.registerCommand(REVEAL_WORKTREE_COMMAND, (node?: WorktreeNode) => {
      if (node) {
        void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(node.worktree.path));
      }
    }),
  );
}

/** Open the worktree in a window, keeping the subfolder this window had open. */
async function openWorktree(
  node: WorktreeNode | undefined,
  fallback: "newWindow" | "currentWindow",
): Promise<void> {
  if (!node) {
    return;
  }
  if (node.current) {
    return;
  }
  const configured = vscode.workspace
    .getConfiguration("omnigent")
    .get<"newWindow" | "currentWindow">("worktrees.openIn", fallback);
  const newWindow = configured !== "currentWindow";
  await vscode.commands.executeCommand(
    "vscode.openFolder",
    vscode.Uri.file(await targetFolder(node)),
    { forceNewWindow: newWindow, forceReuseWindow: !newWindow },
  );
}

export async function targetFolder(target: WorktreeTarget): Promise<string> {
  const { worktree, prefix } = target;
  if (prefix === "") {
    return worktree.path;
  }
  const subfolder = join(worktree.path, prefix);
  try {
    if ((await stat(subfolder)).isDirectory()) {
      return subfolder;
    }
  } catch {
    // The worktree doesn't have this subfolder; open its root instead.
  }
  return worktree.path;
}

async function switchWorktree(sessions: SessionsTreeProvider): Promise<void> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter(
    (folder) => folder.uri.scheme === "file",
  );
  if (folders.length === 0) {
    void vscode.window.showInformationMessage("Open a folder to switch between its worktrees.");
    return;
  }
  const groups = sessions.worktreeGroups;
  const targets: Array<WorktreeTarget & { current: boolean; detail?: string }> = [];
  if (groups.length > 0) {
    for (const group of groups) {
      targets.push({
        worktree: group.worktree,
        prefix: group.prefix,
        current: group.current,
        detail: groupDetail(group),
      });
    }
  } else {
    for (const folder of folders) {
      const repository = await repositoryWorktrees(folder.uri.fsPath);
      const current = worktreeForWorkspace(repository.worktrees, repository.folder);
      for (const worktree of repository.worktrees) {
        targets.push({ worktree, prefix: repository.prefix, current: current === worktree });
      }
    }
  }
  if (targets.length === 0) {
    void vscode.window.showInformationMessage("This folder isn't a git repository.");
    return;
  }
  const picks: WorktreePick[] = [];
  let previousCurrent: boolean | undefined;
  for (const target of targets) {
    if (target.current !== previousCurrent) {
      picks.push({
        label: target.current ? "This window" : "Worktrees",
        kind: vscode.QuickPickItemKind.Separator,
      });
      previousCurrent = target.current;
    }
    picks.push({
      label: `$(${target.worktree.isMain ? "repo" : "git-branch"}) ${target.worktree.branch ?? target.worktree.path}`,
      description:
        [target.current ? "this window" : undefined, target.detail]
          .filter((part) => part !== undefined)
          .join(" · ") || undefined,
      detail: target.worktree.path,
      target,
    });
  }
  const picked = await vscode.window.showQuickPick(picks, {
    title: "Switch Worktree",
    placeHolder: "Open a worktree in a window",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked?.target) {
    return;
  }
  const node: WorktreeNode = {
    kind: "worktree",
    worktree: picked.target.worktree,
    prefix: picked.target.prefix,
    sessions: [],
    current: picked.target.current,
  };
  await openWorktree(node, "newWindow");
}

function groupDetail(group: WorktreeNode): string | undefined {
  const waiting = group.sessions.filter((session) => effectiveStatus(session) === "waiting").length;
  const running = group.sessions.filter((session) => effectiveStatus(session) === "running").length;
  const parts: string[] = [];
  if (waiting > 0) {
    parts.push(`${waiting} waiting`);
  }
  if (running > 0) {
    parts.push(`${running} running`);
  }
  if (parts.length === 0 && group.sessions.length > 0) {
    parts.push(`${group.sessions.length} session${group.sessions.length === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
