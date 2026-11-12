import { describe, expect, it } from "vitest";
import { parseWorktreeList, pathWithin, sessionInFolderScope, workspaceScopeRoots } from "./scope";

const HOST_ID = "298917f54901428299dee608f20654c6";

describe("pathWithin", () => {
  it.each([
    ["/work/repo", "/work/repo", true],
    ["/work/repo", "/work/repo/src/file.ts", true],
    ["/work/repo", "/work/repo/..hidden/session", true],
    ["/work/repo", "/work/repo-other", false],
    ["/work/repo", "/work", false],
    ["/work/repo", "relative/path", false],
  ])("%s contains %s: %s", (root, candidate, expected) => {
    expect(pathWithin(root, candidate)).toBe(expected);
  });
});

describe("sessionInFolderScope", () => {
  it("requires this host and a workspace in one of the repository worktrees", () => {
    const roots = ["/work/repo", "/work/repo-worktrees/branch"];
    expect(
      sessionInFolderScope(
        { hostId: `host_${HOST_ID}`, workspace: "/work/repo-worktrees/branch/src" },
        roots,
        HOST_ID,
      ),
    ).toBe(true);
    expect(
      sessionInFolderScope({ hostId: HOST_ID, workspace: "/work/other" }, roots, HOST_ID),
    ).toBe(false);
    expect(
      sessionInFolderScope(
        { hostId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", workspace: "/work/repo" },
        roots,
        HOST_ID,
      ),
    ).toBe(false);
  });
});

describe("worktree discovery", () => {
  it("parses paths with spaces and ignores other porcelain records", () => {
    const output = `worktree /work/my repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /work/my repo-worktrees/feature one\nHEAD def456\ndetached\n`;
    expect(parseWorktreeList(output)).toEqual([
      "/work/my repo",
      "/work/my repo-worktrees/feature one",
    ]);
  });

  function git(prefix: string, worktrees: string) {
    return async (_folder: string, args: readonly string[]) =>
      args[0] === "rev-parse" ? `${prefix}\n` : worktrees;
  }

  it("includes every worktree and falls back to a plain folder", async () => {
    await expect(
      workspaceScopeRoots("/work/repo", git("", "worktree /work/repo\nworktree /work/wt\n")),
    ).resolves.toEqual(["/work/repo", "/work/wt"]);
    await expect(
      workspaceScopeRoots("/work/plain", async () => Promise.reject(new Error("not a repo"))),
    ).resolves.toEqual(["/work/plain"]);
  });

  it("scopes an opened subfolder to the same subfolder of each worktree", async () => {
    const roots = await workspaceScopeRoots(
      "/work/repo/packages/web",
      git("packages/web/", "worktree /work/repo\nworktree /work/wt\n"),
    );

    expect(roots).toEqual(["/work/repo/packages/web", "/work/wt/packages/web"]);
    expect(
      sessionInFolderScope({ hostId: HOST_ID, workspace: "/work/wt/packages/api" }, roots, HOST_ID),
    ).toBe(false);
  });
});
