/**
 * Read-only reuse of `omnigent login` sessions from the CLI's token file
 * (`<data-dir>/auth_tokens.json`, see omnigent/cli_auth.py). The extension
 * never writes this file: the CLI owns it, and a refresh here stays in memory.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

export interface SessionCredential {
  token: string;
  /** Epoch milliseconds; absent when unknown. */
  expiresAt?: number;
  refreshToken?: string;
  userId?: string;
}

/** `<OMNIGENT_DATA_DIR or ~/.omnigent>/auth_tokens.json`. */
export function cliTokensPath(env: NodeJS.ProcessEnv = process.env): string {
  const dataDir = env.OMNIGENT_DATA_DIR?.trim();
  const root = dataDir ? dataDir.replace(/^~(?=$|[\\/])/, homedir()) : join(homedir(), ".omnigent");
  return join(root, "auth_tokens.json");
}

/**
 * Pick a server's session from the parsed token file. Pure.
 *
 * Entries are keyed by server URL with trailing slashes stripped. Databricks
 * pointer records hold no token and read as nothing stored.
 */
export function cliSessionFrom(data: unknown, serverUrl: string): SessionCredential | undefined {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }
  const entry = (data as Record<string, unknown>)[serverUrl.replace(/\/+$/, "")];
  if (entry === null || typeof entry !== "object") {
    return undefined;
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.token !== "string" || record.token === "") {
    return undefined;
  }
  return {
    token: record.token,
    expiresAt:
      typeof record.expires_at === "number" && Number.isFinite(record.expires_at)
        ? record.expires_at * 1000
        : undefined,
    refreshToken:
      typeof record.refresh_token === "string" && record.refresh_token !== ""
        ? record.refresh_token
        : undefined,
    userId: typeof record.user_id === "string" ? record.user_id : undefined,
  };
}

/** Read a server's CLI session, or undefined when none is stored or readable. */
export async function readCliSession(
  serverUrl: string,
  path: string = cliTokensPath(),
): Promise<SessionCredential | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return cliSessionFrom(JSON.parse(text), serverUrl);
  } catch {
    return undefined;
  }
}
