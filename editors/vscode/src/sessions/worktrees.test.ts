import { describe, expect, it } from "vitest";
import { parseWorktrees, repositoryWorktrees, worktreeForWorkspace } from "./worktrees";

const PORCELAIN = `worktree /work/my repo
HEAD abc123
branch refs/heads/main

worktree /work/my repo-worktrees/feature one
HEAD def456
branch refs/heads/feature/one
locked reason

worktree /work/my repo-worktrees/detached
HEAD 999999
detached
`;

function git(prefix: string, worktrees: string) {
  return async (_folder: string, args: readonly string[]) =>
    args[0] === "rev-parse" ? `${prefix}\n` : worktrees;
}

describe("parseWorktrees", () => {
  it("parses paths with spaces, branches, locked and detached flags", () => {
    expect(parseWorktrees(PORCELAIN)).toEqual([
      { path: "/work/my repo", branch: "main", detached: false, locked: false, isMain: true },
      {
        path: "/work/my repo-worktrees/feature one",
        branch: "feature/one",
        detached: false,
        locked: true,
        isMain: false,
      },
      {
        path: "/work/my repo-worktrees/detached",
        branch: undefined,
        detached: true,
        locked: false,
        isMain: false,
      },
    ]);
  });
});

describe("worktreeForWorkspace", () => {
  const worktrees = parseWorktrees(PORCELAIN);

  it("matches the deepest worktree containing the workspace", () => {
    expect(worktreeForWorkspace(worktrees, "/work/my repo-worktrees/feature one/src")?.branch).toBe(
      "feature/one",
    );
    expect(worktreeForWorkspace(worktrees, "/work/my repo/src")?.isMain).toBe(true);
  });

  it("ignores sibling prefixes and sessions outside every worktree", () => {
    expect(worktreeForWorkspace(worktrees, "/work/my repo-other")).toBeUndefined();
    expect(worktreeForWorkspace(worktrees, "/elsewhere")).toBeUndefined();
    expect(worktreeForWorkspace(worktrees, undefined)).toBeUndefined();
  });
});

describe("repositoryWorktrees", () => {
  it("lists worktrees and includes each root in the scope", async () => {
    const repo = await repositoryWorktrees(
      "/work/repo",
      git("", "worktree /work/repo\nworktree /work/wt\n"),
    );

    expect(repo.worktrees.map((worktree) => worktree.path)).toEqual(["/work/repo", "/work/wt"]);
    expect(repo.roots).toEqual(["/work/repo", "/work/wt"]);
  });

  it("falls back to a plain folder when git fails", async () => {
    const repo = await repositoryWorktrees("/work/plain", async () => {
      throw new Error("not a repo");
    });

    expect(repo.worktrees).toEqual([]);
    expect(repo.roots).toEqual(["/work/plain"]);
  });

  it("scopes an opened subfolder to the same subfolder of each worktree", async () => {
    const repo = await repositoryWorktrees(
      "/work/repo/packages/web",
      git("packages/web/", "worktree /work/repo\nworktree /work/wt\n"),
    );

    expect(repo.prefix).toBe("packages/web");
    expect(repo.roots).toEqual(["/work/repo/packages/web", "/work/wt/packages/web"]);
  });
});
