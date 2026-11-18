/**
 * Carry a session across windows. "Go to Worktree" opens another folder's
 * window and writes a handoff first; the window that has that folder open
 * (on startup, or when it gains focus) consumes the file and opens the session.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

const HANDOFF_FILE = "session-handoff.json";
/** A stale handoff (a window that never opened) must not fire much later. */
const HANDOFF_TTL_MS = 60_000;

export interface SessionHandoff {
  /** The folder the target window opens. */
  folder: string;
  sessionId: string;
  createdAt: number;
}

export function handoffPath(storageDir: string): string {
  return join(storageDir, HANDOFF_FILE);
}

export async function writeHandoff(storageDir: string, handoff: SessionHandoff): Promise<void> {
  await mkdir(storageDir, { recursive: true });
  await writeFile(handoffPath(storageDir), JSON.stringify(handoff), "utf8");
}

/**
 * Read and delete the pending handoff if it targets one of these folders and
 * hasn't expired. Anything unreadable or stale is removed and ignored.
 */
export async function consumeHandoff(
  storageDir: string,
  openFolders: readonly string[],
  now: () => number = Date.now,
): Promise<SessionHandoff | undefined> {
  const path = handoffPath(storageDir);
  let handoff: SessionHandoff;
  try {
    handoff = JSON.parse(await readFile(path, "utf8")) as SessionHandoff;
  } catch {
    return undefined;
  }
  if (
    typeof handoff.sessionId !== "string" ||
    handoff.sessionId === "" ||
    typeof handoff.folder !== "string" ||
    typeof handoff.createdAt !== "number" ||
    now() - handoff.createdAt > HANDOFF_TTL_MS
  ) {
    await rm(path, { force: true });
    return undefined;
  }
  const targets = new Set(openFolders.flatMap((folder) => [resolve(folder), canonical(folder)]));
  if (!targets.has(resolve(handoff.folder)) && !targets.has(canonical(handoff.folder))) {
    // A different window's handoff: leave the file for that window to consume.
    return undefined;
  }
  await rm(path, { force: true });
  return handoff;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
