import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWorktreeCommands, targetFolder } from "./worktrees";
import type { WorktreeNode } from "../sessions/SessionsTreeProvider";

const WORKTREE = {
  path: "/work/repo-worktrees/feature",
  branch: "feature",
  detached: false,
  locked: false,
  isMain: false,
};

function node(overrides: Partial<WorktreeNode> = {}): WorktreeNode {
  return {
    kind: "worktree",
    worktree: WORKTREE,
    prefix: "",
    sessions: [],
    current: false,
    ...overrides,
  };
}

function registeredCommands(options: { storageDir?: string; groups?: WorktreeNode[] } = {}) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  vi.spyOn(vscode.commands, "registerCommand").mockImplementation((id: string, fn: unknown) => {
    handlers.set(id, fn as (...args: unknown[]) => unknown);
    return { dispose: () => {} };
  });
  const context = {
    subscriptions: [] as Array<{ dispose: () => void }>,
    globalStorageUri: { fsPath: options.storageDir ?? "/nonexistent-storage" },
  };
  registerWorktreeCommands(
    context as unknown as vscode.ExtensionContext,
    {
      worktreeGroups: options.groups ?? [],
    } as unknown as import("../sessions/SessionsTreeProvider").SessionsTreeProvider,
  );
  return handlers;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("targetFolder", () => {
  it("keeps the opened subfolder when the worktree has it, else opens the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnigent-worktree-"));
    try {
      await mkdir(join(root, "packages/web"), { recursive: true });
      await expect(
        targetFolder({ worktree: { ...WORKTREE, path: root }, prefix: "packages/web" }),
      ).resolves.toBe(join(root, "packages/web"));
      await expect(
        targetFolder({ worktree: { ...WORKTREE, path: root }, prefix: "packages/api" }),
      ).resolves.toBe(root);
      await expect(
        targetFolder({ worktree: { ...WORKTREE, path: root }, prefix: "" }),
      ).resolves.toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("open worktree commands", () => {
  it("opens a new window by default", async () => {
    const handlers = registeredCommands();
    const execute = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);

    await handlers.get("omnigent.openWorktree")?.(node());

    expect(execute).toHaveBeenCalledWith(
      "vscode.openFolder",
      expect.objectContaining({ fsPath: WORKTREE.path }),
      { forceNewWindow: true, forceReuseWindow: false },
    );
  });

  it("reuses this window when the setting says so or the command asks for it", async () => {
    const handlers = registeredCommands();
    const execute = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: () => "currentWindow",
    } as never);

    await handlers.get("omnigent.openWorktree")?.(node({ prefix: "src" }));
    expect(execute).toHaveBeenLastCalledWith(
      "vscode.openFolder",
      expect.objectContaining({ fsPath: WORKTREE.path }),
      { forceNewWindow: false, forceReuseWindow: true },
    );

    await handlers.get("omnigent.openWorktreeInCurrentWindow")?.(node());
    expect(execute).toHaveBeenLastCalledWith("vscode.openFolder", expect.anything(), {
      forceNewWindow: false,
      forceReuseWindow: true,
    });
  });

  it("does nothing for the worktree this window already has open", async () => {
    const handlers = registeredCommands();
    const execute = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);

    await handlers.get("omnigent.openWorktree")?.(node({ current: true }));

    expect(execute).not.toHaveBeenCalledWith(
      "vscode.openFolder",
      expect.anything(),
      expect.anything(),
    );
  });
});

describe("go to worktree", () => {
  it("writes a handoff and opens the session's worktree in a new window", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "omnigent-goto-"));
    try {
      const group = node({ sessions: [{ id: "s1" } as never] });
      const handlers = registeredCommands({ storageDir, groups: [group] });
      const execute = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);

      await handlers.get("omnigent.goToWorktree")?.({
        kind: "session",
        session: { id: "s1" },
        scope: "folder",
        otherWorktree: true,
      });

      expect(execute).toHaveBeenCalledWith(
        "vscode.openFolder",
        expect.objectContaining({ fsPath: WORKTREE.path }),
        { forceNewWindow: true, forceReuseWindow: false },
      );
      const handoff = JSON.parse(await readFile(join(storageDir, "session-handoff.json"), "utf8"));
      expect(handoff).toMatchObject({ folder: WORKTREE.path, sessionId: "s1" });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  it("opens the session in this window when it isn't in another worktree", async () => {
    const group = node({ current: true, sessions: [{ id: "s1" } as never] });
    const handlers = registeredCommands({ groups: [group] });
    const execute = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);

    await handlers.get("omnigent.goToWorktree")?.({
      kind: "session",
      session: { id: "s1" },
      scope: "folder",
    });

    expect(execute).toHaveBeenCalledWith("omnigent.openSession", expect.anything());
    expect(execute).not.toHaveBeenCalledWith(
      "vscode.openFolder",
      expect.anything(),
      expect.anything(),
    );
  });
});
