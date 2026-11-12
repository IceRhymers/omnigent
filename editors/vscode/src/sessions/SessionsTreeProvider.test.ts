import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { ServerTarget } from "../config";
import type { ServerConnection } from "../servers/connection";
import type { SessionList, SessionsApiClient, SessionSummary } from "./api";
import { SessionsTreeProvider } from "./SessionsTreeProvider";

const HOST_ID = "298917f54901428299dee608f20654c6";
const OTHER_HOST_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TARGET: ServerTarget = {
  baseUrl: "http://127.0.0.1:6767",
  origin: "http://127.0.0.1:6767",
  hostType: "local",
  source: "discovered",
};
const OTHER_TARGET: ServerTarget = {
  baseUrl: "http://127.0.0.1:7000",
  origin: "http://127.0.0.1:7000",
  hostType: "local",
  source: "discovered",
};

function session(
  id: string,
  workspace: string,
  hostId = HOST_ID,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id,
    title: `Session ${id}`,
    agentName: "claude-native-ui",
    status: "idle",
    createdAt: 100,
    updatedAt: 100,
    hostId,
    workspace,
    pendingElicitationsCount: 0,
    backgroundWorkRunning: false,
    viewerUnread: false,
    ...overrides,
  };
}

const SESSIONS = [
  session("inside", "/work/repo/src"),
  session("worktree", "/work/repo-worktrees/feature"),
  session("outside", "/work/other"),
  session("other-host", "/work/repo", OTHER_HOST_ID),
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function makeProvider(
  target: ServerTarget | null = TARGET,
  options: { scope?: "folder" | "all"; listSessions?: () => Promise<SessionList> } = {},
) {
  const targetChanged = new vscode.EventEmitter<ServerTarget | undefined>();
  const connection = {
    serverTarget: target ?? undefined,
    onDidChangeTarget: targetChanged.event,
  } as { serverTarget: ServerTarget | undefined; onDidChangeTarget: unknown };
  const state = new Map<string, unknown>(
    options.scope ? [["omnigent.sessions.scope", options.scope]] : [],
  );
  const context = {
    workspaceState: {
      get: vi.fn((key: string, fallback: unknown) => state.get(key) ?? fallback),
      update: vi.fn(async (key: string, value: unknown) => {
        state.set(key, value);
      }),
    },
  } as unknown as vscode.ExtensionContext;
  const api: SessionsApiClient = {
    listSessions: vi.fn(
      options.listSessions ?? (async () => ({ sessions: SESSIONS, truncated: false })),
    ),
    listHosts: vi.fn(async () => []),
    listAgents: vi.fn(async () => []),
    createSession: vi.fn(async () => "new-session"),
  };
  const hostIdReader = vi.fn(async () => `host_${HOST_ID}`);
  const provider = new SessionsTreeProvider(
    context,
    connection as unknown as ServerConnection,
    { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    {
      apiFactory: () => api,
      hostIdReader,
      scopeRoots: async () => ["/work/repo", "/work/repo-worktrees/feature"],
      now: () => 200_000,
      pollIntervalMs: 10_000,
    },
  );
  // Each tree change, as the node ids VS Code would render.
  const renders: string[][] = [];
  provider.onDidChangeTreeData(() => renders.push(nodeIds(provider)));
  return { provider, connection, targetChanged, api, context, hostIdReader, renders };
}

function nodeIds(provider: SessionsTreeProvider): string[] {
  return provider
    .getChildren()
    .map((node) => (node.kind === "session" ? node.session.id : node.id));
}

function openRepoFolder(): void {
  (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = [
    { name: "repo", uri: { scheme: "file", fsPath: "/work/repo" } },
  ];
}

describe("SessionsTreeProvider", () => {
  afterEach(() => {
    (vscode.workspace as unknown as Record<string, unknown>).workspaceFolders = undefined;
    vi.useRealTimers();
  });

  it("defaults to this folder, includes its worktrees, and excludes other folders and hosts", async () => {
    openRepoFolder();
    const { provider } = makeProvider();
    try {
      await provider.refresh();
      const nodes = provider.getChildren();
      expect(nodeIds(provider)).toEqual(["inside", "worktree"]);
      expect(provider.scopeMode).toBe("folder");
      const first = nodes[0];
      expect(first.kind).toBe("session");
      if (first.kind === "session") {
        expect(provider.getTreeItem(first).command?.command).toBe("omnigent.openSession");
        expect(provider.getTreeItem(first).description).toContain("Claude Code");
      }
    } finally {
      provider.dispose();
    }
  });

  it("all scope shows every session and keeps the choice in workspace state", async () => {
    openRepoFolder();
    const { provider, context } = makeProvider();
    try {
      await provider.setScope("all");
      expect(provider.getChildren().filter((node) => node.kind === "session")).toHaveLength(4);
      expect(context.workspaceState.update).toHaveBeenCalledWith("omnigent.sessions.scope", "all");
      const first = provider.getChildren()[0];
      if (first.kind === "session") {
        expect(provider.getTreeItem(first).description).toContain("src");
      }
    } finally {
      provider.dispose();
    }
  });

  it("leaves the tree empty for viewsWelcome when no server is resolved", async () => {
    const { provider, api } = makeProvider(null);
    try {
      await provider.refresh();
      expect(provider.getChildren()).toEqual([]);
      expect(api.listSessions).not.toHaveBeenCalled();
    } finally {
      provider.dispose();
    }
  });

  it.each([
    ["a terminal prompt", { status: "running", blockedOn: "permission prompt" }, "Waiting", "bell"],
    ["a web prompt", { pendingElicitationsCount: 1 }, "Waiting", "bell"],
    ["background work", { backgroundWorkRunning: true }, "Running", "sync~spin"],
    [
      "activity since last seen",
      { updatedAt: 150, viewerLastSeen: 120 },
      "Claude Code",
      "circle-filled",
    ],
  ] as const)("shows %s like the web sidebar", async (_case, overrides, description, icon) => {
    const { provider } = makeProvider(TARGET, {
      scope: "all",
      listSessions: async () => ({
        sessions: [session("one", "/work/repo", HOST_ID, overrides)],
        truncated: false,
      }),
    });
    try {
      await provider.refresh();
      const [node] = provider.getChildren();
      const item = provider.getTreeItem(node);
      expect(String(item.description).split(" · ")[0]).toBe(description);
      expect((item.iconPath as vscode.ThemeIcon).id).toBe(icon);
    } finally {
      provider.dispose();
    }
  });

  it("drops a load whose scope changed mid-flight and settles on the new scope", async () => {
    openRepoFolder();
    const firstPage = deferred<SessionList>();
    let calls = 0;
    const { provider, renders, hostIdReader } = makeProvider(TARGET, {
      scope: "all",
      listSessions: () => {
        calls += 1;
        return calls === 1
          ? firstPage.promise
          : Promise.resolve({ sessions: SESSIONS, truncated: false });
      },
    });
    try {
      const initial = provider.refresh();
      const switched = provider.setScope("folder");
      firstPage.resolve({ sessions: SESSIONS, truncated: false });
      await Promise.all([initial, switched]);

      expect(nodeIds(provider)).toEqual(["inside", "worktree"]);
      expect(hostIdReader).toHaveBeenCalledTimes(1);
      expect(renders.flat()).not.toContain("no-host");
    } finally {
      provider.dispose();
    }
  });

  it("doesn't show the old server's failure after switching servers", async () => {
    const oldServer = deferred<SessionList>();
    let calls = 0;
    const { provider, connection, targetChanged, renders } = makeProvider(TARGET, {
      scope: "all",
      listSessions: () => {
        calls += 1;
        return calls === 1
          ? oldServer.promise
          : Promise.resolve({ sessions: SESSIONS, truncated: false });
      },
    });
    try {
      provider.setVisible(true);
      connection.serverTarget = OTHER_TARGET;
      targetChanged.fire(OTHER_TARGET);
      oldServer.reject(new Error("proxy closed"));
      await provider.refresh();

      expect(renders.flat()).not.toContain("sessions-error");
      expect(nodeIds(provider)).toHaveLength(4);
    } finally {
      provider.dispose();
    }
  });

  it("stops queued refreshes once disposed", async () => {
    const pending = deferred<SessionList>();
    const { provider, api } = makeProvider(TARGET, {
      scope: "all",
      listSessions: () => pending.promise,
    });
    const active = provider.refresh();
    void provider.refresh();
    provider.dispose();
    pending.resolve({ sessions: SESSIONS, truncated: false });
    await active;

    expect(api.listSessions).toHaveBeenCalledTimes(1);
  });

  it("polls only while visible and the window is focused", async () => {
    vi.useFakeTimers();
    const { provider, api } = makeProvider(TARGET, { scope: "all" });
    try {
      provider.setVisible(true);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(api.listSessions).toHaveBeenCalledTimes(2);

      provider.setWindowFocused(false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(api.listSessions).toHaveBeenCalledTimes(2);

      provider.setWindowFocused(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(api.listSessions).toHaveBeenCalledTimes(3);

      provider.setVisible(false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(api.listSessions).toHaveBeenCalledTimes(3);
    } finally {
      provider.dispose();
    }
  });

  it("says when older sessions were left out", async () => {
    const { provider } = makeProvider(TARGET, {
      scope: "all",
      listSessions: async () => ({ sessions: SESSIONS, truncated: true }),
    });
    try {
      await provider.refresh();
      expect(nodeIds(provider).at(-1)).toBe("truncated");
    } finally {
      provider.dispose();
    }
  });
});
