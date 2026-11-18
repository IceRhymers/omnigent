/**
 * Recently connected remote servers, newest first, for the Connect picker.
 * Stored in the extension's globalState; these helpers are pure.
 */
import { checkServerUrl } from "../config";

export const RECENT_SERVERS_KEY = "omnigent.recentServers";
export const MAX_RECENT_SERVERS = 5;

/** Read a stored list, dropping malformed, local, and duplicate entries. */
export function readRecentServers(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const recents: string[] = [];
  for (const candidate of raw) {
    if (typeof candidate !== "string") {
      continue;
    }
    const checked = checkServerUrl(candidate);
    if (checked.ok && checked.hostType === "remote" && !recents.includes(checked.url)) {
      recents.push(checked.url);
    }
  }
  return recents.slice(0, MAX_RECENT_SERVERS);
}

/** Move `serverUrl` to the front of the list. */
export function addRecentServer(raw: unknown, serverUrl: string): string[] {
  const recents = readRecentServers(raw).filter((url) => url !== serverUrl);
  return readRecentServers([serverUrl, ...recents]);
}
