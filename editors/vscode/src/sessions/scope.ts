/**
 * Match sessions to VS Code folders. A repository's worktrees are one folder
 * scope because sessions created on another branch live outside the checkout.
 */
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { normalizeHostId } from "./hostIdentity";
import type { SessionSummary } from "./api";

export type GitRunner = (folder: string, args: readonly string[]) => Promise<string>;

/** Whether candidate is root itself or one of its descendants. */
export function pathWithin(root: string, candidate: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(candidate)) {
    return false;
  }
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  const outside = pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`);
  return pathFromRoot === "" || (!outside && !isAbsolute(pathFromRoot));
}

export function sessionInFolderScope(
  session: Pick<SessionSummary, "hostId" | "workspace">,
  roots: readonly string[],
  localHostId: string,
): boolean {
  const { workspace } = session;
  return (
    workspace !== undefined &&
    normalizeHostId(session.hostId) === normalizeHostId(localHostId) &&
    roots.some((root) => pathWithin(root, workspace))
  );
}

/** Paths after each `worktree` line in `git worktree list --porcelain`. */
export function parseWorktreeList(output: string): string[] {
  const paths: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      const path = line.slice("worktree ".length).trim();
      if (path !== "") {
        paths.push(path);
      }
    }
  }
  return paths;
}

/**
 * The opened folder and the same folder in every worktree of its repository,
 * as given and canonicalized: realpath can change letter case on macOS, while
 * sessions keep the path they were created with.
 */
export async function workspaceScopeRoots(
  folder: string,
  runGit: GitRunner = runGitCommand,
): Promise<string[]> {
  const canonicalFolder = await canonicalPath(folder);
  let worktreeFolders: string[] = [];
  try {
    const [prefix, worktrees] = await Promise.all([
      runGit(canonicalFolder, ["rev-parse", "--show-prefix"]),
      runGit(canonicalFolder, ["worktree", "list", "--porcelain"]),
    ]);
    // An opened subfolder, e.g. packages/web, maps to that subfolder of each worktree.
    const subfolder = prefix.trim();
    worktreeFolders = parseWorktreeList(worktrees).map((worktree) =>
      subfolder === "" ? worktree : join(worktree, subfolder),
    );
  } catch {
    // A plain directory has no worktree list; it is still a useful scope.
  }
  const canonicalWorktreeFolders = await Promise.all(worktreeFolders.map(canonicalPath));
  return [...new Set([resolve(folder), canonicalFolder, ...canonicalWorktreeFolders])];
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function runGitCommand(folder: string, args: readonly string[]): Promise<string> {
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
