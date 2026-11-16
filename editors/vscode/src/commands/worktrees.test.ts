import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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

function registeredCommands() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  vi.spyOn(vscode.commands, "registerCommand").mockImplementation((id: string, fn: unknown) => {
    handlers.set(id, fn as (...args: unknown[]) => unknown);
    return { dispose: () => {} };
  });
  const context = { subscriptions: [] as Array<{ dispose: () => void }> };
  registerWorktreeCommands(
    context as unknown as vscode.ExtensionContext,
    {
      worktreeGroups: [],
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
