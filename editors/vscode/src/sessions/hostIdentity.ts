/**
 * Read this machine's host identity without writing Omnigent's config. Both
 * current bare UUIDs and legacy `host_` ids normalize to the API's bare hex.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LocalHostIdentity {
  id: string;
  name?: string;
}

/** Normalize a UUID-shaped Omnigent host id, or return undefined. */
export function normalizeHostId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  let normalized = value.trim().replaceAll("-", "");
  if (normalized.includes("_")) {
    const separator = normalized.lastIndexOf("_");
    const prefix = normalized.slice(0, separator);
    const tail = normalized.slice(separator + 1);
    if (prefix === "host" && tail.length === 32) {
      normalized = tail;
    }
  }
  return /^[0-9a-fA-F]{32}$/.test(normalized) ? normalized.toLowerCase() : undefined;
}

/** Extract the host section from the block YAML written by the Omnigent CLI. */
export function hostIdentityFromConfig(contents: string): LocalHostIdentity | undefined {
  let inHostSection = false;
  let id: string | undefined;
  let name: string | undefined;
  for (const line of contents.split(/\r?\n/)) {
    if (/^host\s*:\s*(?:#.*)?$/.test(line)) {
      inHostSection = true;
      continue;
    }
    if (line.trim() !== "" && !/^\s/.test(line)) {
      inHostSection = false;
    }
    if (!inHostSection) {
      continue;
    }
    const match = /^\s+(host_id|name)\s*:\s*(.*?)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const value = yamlScalar(match[2]);
    if (match[1] === "host_id") {
      id = normalizeHostId(value);
    } else {
      name = value || undefined;
    }
  }
  return id ? { id, name } : undefined;
}

export async function readLocalHostIdentity(
  env: NodeJS.ProcessEnv = process.env,
  readText: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<LocalHostIdentity | undefined> {
  const envId = env.OMNIGENT_HOST_ID;
  const envName = env.OMNIGENT_HOST_NAME;
  if (envId !== undefined || envName !== undefined) {
    if (envId === undefined || envName === undefined) {
      return undefined;
    }
    const normalized = normalizeHostId(envId);
    return normalized ? { id: normalized, name: envName } : undefined;
  }
  try {
    const contents = await readText(configPath(env));
    return hostIdentityFromConfig(contents);
  } catch {
    return undefined;
  }
}

export async function readLocalHostId(): Promise<string | undefined> {
  return (await readLocalHostIdentity())?.id;
}

function configPath(env: NodeJS.ProcessEnv): string {
  const configuredHome = env.OMNIGENT_CONFIG_HOME?.trim();
  const home = configuredHome
    ? configuredHome.replace(/^~(?=$|[\\/])/, homedir())
    : join(homedir(), ".omnigent");
  return join(home, "config.yaml");
}

function yamlScalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "string" ? parsed : "";
    } catch {
      return "";
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value.replace(/\s+#.*$/, "").trim();
}
