/**
 * Find the `omnigent` CLI the extension drives to start servers and hosts,
 * mirroring the desktop app's lookup (web/electron/src/omnigent_cli.js): the
 * canonical name on PATH, then the `omni` alias, then well-known install
 * directories a minimal GUI PATH can miss.
 */
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Shown when the CLI is missing; the install line from the repo README. */
export const INSTALL_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/omnigent-ai/omnigent/main/scripts/install_oss.sh | sh";

const CLI_NAMES = ["omnigent", "omni"];

export interface LocateEnv {
  pathEnv: string | undefined;
  platform: NodeJS.Platform;
  home: string;
  isExecutable(path: string): boolean;
}

/** The paths to try, in order. Pure. */
export function cliCandidates(env: Omit<LocateEnv, "isExecutable">): string[] {
  const windows = env.platform === "win32";
  const suffixes = windows ? [".exe", ".cmd", ""] : [""];
  const pathDirs = (env.pathEnv ?? "").split(windows ? ";" : ":").filter((dir) => dir !== "");
  const wellKnownDirs = [
    join(env.home, ".local", "bin"),
    join(env.home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const named = (dir: string, name: string) => suffixes.map((suffix) => join(dir, name + suffix));
  const candidates = [
    ...CLI_NAMES.flatMap((name) => pathDirs.flatMap((dir) => named(dir, name))),
    ...wellKnownDirs.flatMap((dir) => CLI_NAMES.flatMap((name) => named(dir, name))),
  ];
  return [...new Set(candidates)];
}

/** The CLI's path, or undefined when it isn't installed. */
export function findCli(env: LocateEnv = processLocateEnv()): string | undefined {
  return cliCandidates(env).find((candidate) => env.isExecutable(candidate));
}

function processLocateEnv(): LocateEnv {
  return {
    pathEnv: process.env.PATH,
    platform: process.platform,
    home: homedir(),
    isExecutable: (path) => {
      try {
        if (!statSync(path).isFile()) {
          return false;
        }
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}
