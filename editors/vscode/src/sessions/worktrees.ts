/**
 * Git worktrees of the repositories opened in VS Code. Grouping and navigation
 * read local git, so they work without a server; the same worktree list feeds
 * the folder scope, because sessions created on another branch live outside
 * the checkout.
 */
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type GitRunner = (folder: string, args: readonly string[]) => Promise<string>;

export interface Worktree {
  path: string;
  /** Short ref name, e.g. "feature/x"; absent on a detached HEAD. */
  branch?: string;
  detached: boolean;
  locked: boolean;
  /** The main checkout is the first entry git prints; it isn't marked otherwise. */
  isMain: boolean;
}

export interface RepositoryWorktrees {
  /** Canonical path of the opened folder this list belongs to. */
  folder: string;
  /** The folder's path relative to its checkout root, without a trailing slash. */
  prefix: string;
  /** Every worktree of the repository, main checkout first. */
  worktrees: Worktree[];
  /** The same folder in every worktree, canonicalized where possible. */
  roots: string[];
}

export interface SessionPlacement {
  workspace?: string;
}

/** Parse `git worktree list --porcelain`, including branch, detached and locked flags. */
export function parseWorktrees(output: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let current: Worktree | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      const path = line.slice("worktree ".length).trim();
      if (path !== "") {
        current = { path, detached: false, locked: false, isMain: worktrees.length === 0 };
        worktrees.push(current);
      }
    } else if (current) {
      if (line.startsWith("branch ")) {
        current.branch = line
          .slice("branch ".length)
          .trim()
          .replace(/^refs\/heads\//, "");
      } else if (line === "detached") {
        current.detached = true;
      } else if (line.startsWith("locked")) {
        current.locked = true;
      }
    }
  }
  return worktrees;
}

/** The deepest worktree containing a session's workspace; subfolders stay in their worktree. */
export function worktreeForWorkspace(
  worktrees: readonly Worktree[],
  workspace: string | undefined,
): Worktree | undefined {
  if (!workspace || !isAbsolute(workspace)) {
    return undefined;
  }
  let match: Worktree | undefined;
  for (const worktree of worktrees) {
    if (pathWithin(worktree.path, workspace)) {
      if (!match || worktree.path.length > match.path.length) {
        match = worktree;
      }
    }
  }
  return match;
}

/** Whether candidate is root itself or one of its descendants. */
export function pathWithin(root: string, candidate: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(candidate)) {
    return false;
  }
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  const outside = pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`);
  return pathFromRoot === "" || (!outside && !isAbsolute(pathFromRoot));
}

/**
 * The opened folder, the same folder in every worktree of its repository, and
 * the worktrees themselves. A plain directory is a scope of one root with no
 * worktrees. Paths are kept as given as well as canonicalized, because sessions
 * keep the path they were created with while realpath can change letter case.
 */
export async function repositoryWorktrees(
  folder: string,
  runGit: GitRunner = runGitCommand,
): Promise<RepositoryWorktrees> {
  const canonicalFolder = await canonicalPath(folder);
  const base: RepositoryWorktrees = {
    folder: canonicalFolder,
    prefix: "",
    worktrees: [],
    roots: [...new Set([resolve(folder), canonicalFolder])],
  };
  let prefix: string;
  let worktrees: Worktree[];
  try {
    const [prefixOutput, worktreeOutput] = await Promise.all([
      runGit(canonicalFolder, ["rev-parse", "--show-prefix"]),
      runGit(canonicalFolder, ["worktree", "list", "--porcelain"]),
    ]);
    prefix = prefixOutput.trim().replace(/\/+$/, "");
    worktrees = parseWorktrees(worktreeOutput);
  } catch {
    // Not a git repository, or git isn't installed: the folder is still a useful scope.
    return base;
  }
  const canonicalWorktrees = await Promise.all(
    worktrees.map(async (worktree) => ({ ...worktree, path: await canonicalPath(worktree.path) })),
  );
  const roots = new Set(base.roots);
  for (const worktree of canonicalWorktrees) {
    roots.add(prefix === "" ? worktree.path : join(worktree.path, prefix));
  }
  return { ...base, prefix, worktrees: canonicalWorktrees, roots: [...roots] };
}

export function runGitCommand(folder: string, args: readonly string[]): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(
      "git",
      ["-C", folder, ...args],
      { encoding: "utf8", timeout: 5_000 },
      (error, stdout) => {
        if (error) {
          reject(error);
        } else {
          resolveOutput(stdout);
        }
      },
    );
  });
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}
