/**
 * The activity-bar Sessions tree. Data comes from the panel's current server;
 * background refreshes run only while the view is visible and the window focused.
 */
import * as vscode from "vscode";
import { basename } from "node:path";
import type { ServerConnection } from "../servers/connection";
import type { ServerTarget } from "../config";
import {
  MAX_LISTED_SESSIONS,
  SessionsApi,
  type SessionStatus,
  type SessionSummary,
  type SessionsApiClient,
} from "./api";
import { readLocalHostId } from "./hostIdentity";
import { sessionInFolderScope, workspaceScopeRoots } from "./scope";
import { relativeTime, sessionHarnessLabel, sessionTitle } from "./harnesses";
import {
  NEW_SESSION_COMMAND,
  OPEN_SESSION_COMMAND,
  REFRESH_SESSIONS_COMMAND,
  SESSION_SCOPE_CONTEXT,
  SESSION_SCOPE_STATE_KEY,
  SHOW_ALL_SESSIONS_COMMAND,
} from "./constants";

export type SessionScope = "folder" | "all";

export interface SessionNode {
  kind: "session";
  session: SessionSummary;
  scope: SessionScope;
}

interface MessageNode {
  kind: "message";
  id: string;
  label: string;
  description?: string;
  icon: string;
  command?: vscode.Command;
}

type TreeNode = SessionNode | MessageNode;

export interface SessionsTreeProviderOptions {
  apiFactory?: (target: ServerTarget) => SessionsApiClient;
  hostIdReader?: () => Promise<string | undefined>;
  scopeRoots?: (folder: string) => Promise<string[]>;
  now?: () => number;
  pollIntervalMs?: number;
}

export class SessionsTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly apiFactory: (target: ServerTarget) => SessionsApiClient;
  private readonly hostIdReader: () => Promise<string | undefined>;
  private readonly scopeRoots: (folder: string) => Promise<string[]>;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private nodes: TreeNode[] = [];
  private scope: SessionScope;
  private visible = false;
  private windowFocused = true;
  private hasLoaded = false;
  private disposed = false;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private activeRefresh: Promise<void> | undefined;
  private refreshAgain = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connection: ServerConnection,
    private readonly output: vscode.OutputChannel,
    options: SessionsTreeProviderOptions = {},
  ) {
    this.apiFactory = options.apiFactory ?? SessionsApi.forTarget;
    this.hostIdReader = options.hostIdReader ?? readLocalHostId;
    this.scopeRoots = options.scopeRoots ?? workspaceScopeRoots;
    this.now = options.now ?? Date.now;
    this.pollIntervalMs = options.pollIntervalMs ?? 10_000;
    this.scope = context.workspaceState.get<SessionScope>(SESSION_SCOPE_STATE_KEY, "folder");
    if (this.scope !== "folder" && this.scope !== "all") {
      this.scope = "folder";
    }
    this.disposables.push(
      connection.onDidChangeTarget(() => {
        this.hasLoaded = false;
        this.nodes = connection.serverTarget ? [loadingMessage()] : [];
        this.changed.fire();
        this.restartPolling();
        this.refreshIfVisible();
      }),
    );
    void this.setScopeContext();
  }

  get scopeMode(): SessionScope {
    return this.scope;
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === "message") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.id = node.id;
      item.description = node.description;
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.command = node.command;
      item.tooltip = node.description ?? node.label;
      return item;
    }
    const { session } = node;
    const status = effectiveStatus(session);
    const item = new vscode.TreeItem(sessionTitle(session), vscode.TreeItemCollapsibleState.None);
    item.id = session.id;
    item.contextValue = "omnigent.session";
    item.description = this.sessionDescription(node, status);
    item.tooltip = this.sessionTooltip(node, status);
    item.iconPath = statusIcon(status, sessionUnread(session));
    item.command = {
      command: OPEN_SESSION_COMMAND,
      title: "Open Omnigent Session",
      arguments: [node],
    };
    return item;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    return element ? [] : this.nodes;
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) {
      return;
    }
    this.visible = visible;
    this.restartPolling();
    this.refreshIfVisible();
  }

  /** Polling pauses while the window is in the background; regaining focus reloads. */
  setWindowFocused(focused: boolean): void {
    if (this.windowFocused === focused) {
      return;
    }
    this.windowFocused = focused;
    this.restartPolling();
    if (focused) {
      this.refreshIfVisible();
    }
  }

  async setScope(scope: SessionScope): Promise<void> {
    if (this.scope !== scope) {
      this.scope = scope;
      await this.context.workspaceState.update(SESSION_SCOPE_STATE_KEY, scope);
    }
    await this.setScopeContext();
    await this.refresh();
  }

  /** Reload now if the view is showing; a hidden view reloads when it is shown. */
  refreshIfVisible(): void {
    if (this.visible) {
      void this.refresh();
    }
  }

  /** Reload, resolving after the load that started after this call. */
  refresh(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    if (this.activeRefresh) {
      this.refreshAgain = true;
      return this.activeRefresh;
    }
    const run = async () => {
      do {
        this.refreshAgain = false;
        await this.load();
      } while (this.refreshAgain && !this.disposed);
    };
    const active = run().finally(() => {
      this.activeRefresh = undefined;
    });
    this.activeRefresh = active;
    return active;
  }

  dispose(): void {
    this.disposed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.changed.dispose();
  }

  private async load(): Promise<void> {
    const target = this.connection.serverTarget;
    if (!target) {
      this.nodes = [];
      this.hasLoaded = false;
      this.changed.fire();
      return;
    }
    if (!this.hasLoaded) {
      this.nodes = [loadingMessage()];
      this.changed.fire();
    }
    const baseUrl = target.baseUrl;
    const scope = this.scope;
    // Scope and server changes start their own load, so a result for the old ones is dropped.
    const superseded = () =>
      this.disposed || this.scope !== scope || this.connection.serverTarget?.baseUrl !== baseUrl;
    const folders = workspaceFolders();
    if (scope === "folder" && folders.length === 0) {
      this.nodes = [
        message("no-folder", "Open a folder to see its sessions", undefined, "folder-opened"),
        message("show-all", "Show All Sessions", undefined, "globe", {
          command: SHOW_ALL_SESSIONS_COMMAND,
          title: "Show All Sessions",
        }),
      ];
      this.hasLoaded = true;
      this.changed.fire();
      return;
    }
    try {
      const api = this.apiFactory(target);
      const [list, hostId, roots] = await Promise.all([
        api.listSessions(),
        scope === "folder" ? this.hostIdReader() : Promise.resolve(undefined),
        scope === "folder"
          ? Promise.all(folders.map((folder) => this.scopeRoots(folder))).then((groups) =>
              groups.flat(),
            )
          : Promise.resolve([]),
      ]);
      if (superseded()) {
        return;
      }
      if (scope === "folder" && !hostId) {
        this.nodes = [
          message(
            "no-host",
            "Connect this computer to see its sessions",
            "Omnigent needs this computer as a host to match sessions to this folder.",
            "plug",
            { command: "omnigent.hostHere", title: "Use This Computer as a Host" },
          ),
          message("show-all", "Show All Sessions", undefined, "globe", {
            command: SHOW_ALL_SESSIONS_COMMAND,
            title: "Show All Sessions",
          }),
        ];
      } else {
        const visibleSessions =
          scope === "folder" && hostId
            ? list.sessions.filter((session) => sessionInFolderScope(session, roots, hostId))
            : list.sessions;
        this.nodes = sessionNodes(visibleSessions, scope, folders, list.truncated);
      }
      this.hasLoaded = true;
      this.changed.fire();
    } catch (error) {
      if (superseded()) {
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[omnigent] couldn't load sessions: ${detail}`);
      if (!this.hasLoaded) {
        this.nodes = [
          message("sessions-error", "Couldn't load sessions", detail, "warning"),
          message("retry", "Retry", undefined, "refresh", {
            command: REFRESH_SESSIONS_COMMAND,
            title: "Refresh Sessions",
          }),
        ];
        this.changed.fire();
      }
    }
  }

  private sessionDescription(node: SessionNode, status: SessionStatus): string {
    const parts: string[] = [];
    if (status !== "idle") {
      parts.push(STATUS_LABELS[status]);
    }
    const harness = sessionHarnessLabel(node.session);
    if (harness) {
      parts.push(harness);
    }
    if (node.scope === "all" && node.session.workspace) {
      parts.push(basename(node.session.workspace) || node.session.workspace);
    }
    const updated = relativeTime(node.session.updatedAt, this.now());
    if (updated) {
      parts.push(updated);
    }
    return parts.join(" · ");
  }

  private sessionTooltip(node: SessionNode, status: SessionStatus): string {
    const lines = [sessionTitle(node.session), `Status: ${STATUS_LABELS[status]}`];
    if (status === "waiting" && node.session.blockedOn) {
      lines.push(`Waiting on: ${node.session.blockedOn}`);
    } else if (node.session.status !== "running" && node.session.backgroundWorkRunning) {
      lines.push("Background work is running");
    }
    const harness = sessionHarnessLabel(node.session);
    if (harness) {
      lines.push(`Harness: ${harness}`);
    }
    if (node.session.workspace) {
      lines.push(`Folder: ${node.session.workspace}`);
    }
    if (node.session.gitBranch) {
      lines.push(`Branch: ${node.session.gitBranch}`);
    }
    if (node.session.updatedAt > 0) {
      lines.push(`Updated: ${new Date(node.session.updatedAt * 1000).toLocaleString()}`);
    }
    return lines.join("\n");
  }

  private async setScopeContext(): Promise<void> {
    await vscode.commands.executeCommand("setContext", SESSION_SCOPE_CONTEXT, this.scope);
  }

  private restartPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.disposed || !this.visible || !this.windowFocused || !this.connection.serverTarget) {
      return;
    }
    this.pollTimer = setInterval(() => void this.refresh(), this.pollIntervalMs);
  }
}

const STATUS_LABELS: Record<SessionStatus, string> = {
  idle: "Idle",
  running: "Running",
  waiting: "Waiting",
  failed: "Failed",
};

function workspaceFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === "file")
    .map((folder) => folder.uri.fsPath);
}

function sessionNodes(
  sessions: readonly SessionSummary[],
  scope: SessionScope,
  folders: readonly string[],
  truncated: boolean,
): TreeNode[] {
  const nodes: TreeNode[] = sessions.map((session) => ({ kind: "session", session, scope }));
  if (nodes.length === 0) {
    nodes.push(
      message(
        "no-sessions",
        scope === "folder" ? "No sessions in this folder" : "No sessions yet",
        scope === "folder" ? folders.map((folder) => basename(folder)).join(", ") : undefined,
        "comment-discussion",
      ),
    );
    if (folders.length > 0) {
      nodes.push(
        message("new-session", "New Session in This Folder", undefined, "add", {
          command: NEW_SESSION_COMMAND,
          title: "New Omnigent Session",
        }),
      );
    }
  }
  if (truncated) {
    nodes.push(
      message(
        "truncated",
        "Older sessions aren't listed",
        `Only the ${MAX_LISTED_SESSIONS.toLocaleString("en-US")} most recently updated sessions are checked.`,
        "info",
      ),
    );
  }
  return nodes;
}

/** The web sidebar's status: prompts (web or terminal) first, then running, failed, background work. */
function effectiveStatus(session: SessionSummary): SessionStatus {
  if (session.pendingElicitationsCount > 0) {
    return "waiting";
  }
  if (session.status === "running") {
    return session.blockedOn ? "waiting" : "running";
  }
  if (session.status === "idle" && session.backgroundWorkRunning) {
    return "running";
  }
  return session.status;
}

/** Server read state only; the web app's per-browser read state isn't visible here. */
function sessionUnread(session: SessionSummary): boolean {
  if (session.viewerUnread) {
    return true;
  }
  return (
    session.status !== "running" &&
    session.viewerLastSeen !== undefined &&
    session.updatedAt > session.viewerLastSeen
  );
}

function loadingMessage(): MessageNode {
  return message("loading", "Loading sessions…", undefined, "loading~spin");
}

function statusIcon(status: SessionStatus, unread: boolean): vscode.ThemeIcon {
  switch (status) {
    case "running":
      return new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("testing.iconQueued"));
    case "waiting":
      return new vscode.ThemeIcon("bell", new vscode.ThemeColor("editorWarning.foreground"));
    case "failed":
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
    case "idle":
      return new vscode.ThemeIcon(unread ? "circle-filled" : "comment-discussion");
  }
}

function message(
  id: string,
  label: string,
  description: string | undefined,
  icon: string,
  command?: vscode.Command,
): MessageNode {
  return { kind: "message", id, label, description, icon, command };
}
