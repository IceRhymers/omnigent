/**
 * Config + server-target + host-type resolution.
 *
 * Resolution order: manual override (serverUrl set) > auto-discovered local >
 * (caller prompts). A loopback override or discovered server resolves to a
 * direct target; a remote https override resolves to `remote`, which the
 * caller connects through the local credential proxy (servers/connection.ts).
 * All decision logic is pure and isolated from the VS Code API behind the
 * `Settings` interface so it is unit-testable without an IDE host. The thin
 * VS Code adapter lives in vscodeSettings.ts.
 */
import type { HealthOutcome } from "../discovery";
import { remoteServerKind, type RemoteServerKind } from "../servers/classify";

export type HostType = "local" | "remote" | "unknown";

export interface ServerTarget {
  /** URL the panel iframe loads (for a remote server, the local proxy's entry URL). */
  baseUrl: string;
  /** Origin the panel frames; always loopback. */
  origin: string;
  hostType: HostType;
  /** Where the target came from, for diagnostics. */
  source: "manual" | "discovered";
  /** The remote server the panel shows, for display. */
  displayUrl?: string;
}

/** Thin, stubbable settings surface (isolates the vscode API). */
export interface Settings {
  serverUrl: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Derive the origin (scheme://host[:port]) from a URL. Pure. */
export function originOf(url: string): string {
  const u = new URL(url);
  return u.origin;
}

/** Classify a URL's host as local (loopback) or remote. Pure. */
export function hostTypeOf(url: string): HostType {
  try {
    const u = new URL(url);
    if (LOOPBACK_HOSTS.has(u.hostname)) {
      return "local";
    }
    return "remote";
  } catch {
    return "unknown";
  }
}

/** Build a ServerTarget from a manual override URL. Pure. */
export function manualTarget(serverUrl: string): ServerTarget {
  const trimmed = serverUrl.replace(/\/$/, "");
  return {
    baseUrl: trimmed,
    origin: originOf(trimmed),
    hostType: hostTypeOf(trimmed),
    source: "manual",
  };
}

/** Build a ServerTarget from a discovered local baseUrl. Pure. */
export function discoveredTarget(baseUrl: string): ServerTarget {
  return {
    baseUrl,
    origin: originOf(baseUrl),
    hostType: "local",
    source: "discovered",
  };
}

export type ServerUrlCheck =
  | { ok: true; url: string; hostType: "local" | "remote" }
  | { ok: false; reason: "empty" | "invalid-url" | "insecure-remote" };

/**
 * Normalize a user-entered server URL. Pure.
 *
 * A missing scheme defaults to http:// for loopback hosts and https://
 * otherwise. Query, fragment, and trailing slashes are dropped; a path is kept
 * so servers mounted under a subpath work. Remote servers must use https.
 */
export function checkServerUrl(raw: string): ServerUrlCheck {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, reason: "empty" };
  }
  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `${defaultSchemeFor(trimmed)}://${trimmed}`);
  } catch {
    return { ok: false, reason: "invalid-url" };
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return { ok: false, reason: "invalid-url" };
  }
  const hostType = LOOPBACK_HOSTS.has(url.hostname) ? "local" : "remote";
  if (hostType === "remote" && url.protocol !== "https:") {
    return { ok: false, reason: "insecure-remote" };
  }
  return { ok: true, url: `${url.origin}${url.pathname.replace(/\/+$/, "")}`, hostType };
}

function defaultSchemeFor(schemeless: string): "http" | "https" {
  try {
    return LOOPBACK_HOSTS.has(new URL(`https://${schemeless}`).hostname) ? "http" : "https";
  } catch {
    return "https";
  }
}

/** The discovery summary the resolver needs (kept abstract for testability). */
export interface DiscoverySummary {
  found: boolean;
  baseUrl?: string;
  health?: HealthOutcome;
}

export type TargetResolution =
  | { status: "resolved"; target: ServerTarget }
  | { status: "remote"; serverUrl: string; kind: RemoteServerKind }
  | {
      status: "needs-prompt";
      reason: "no-manual-no-local" | "local-unhealthy" | "invalid-url" | "insecure-remote";
    };

/**
 * Resolve a server target purely from settings + a discovery summary.
 *  1. manual override (serverUrl non-empty) wins: a loopback URL resolves
 *     directly, a remote https URL resolves to `remote`, and a malformed or
 *     plain-http remote URL needs a prompt.
 *  2. else auto-discovered local with health === 'ok'
 *  3. else needs-prompt
 */
export function resolveServerTarget(
  settings: Pick<Settings, "serverUrl">,
  discovery: DiscoverySummary,
): TargetResolution {
  const manual = settings.serverUrl?.trim() ?? "";
  if (manual !== "") {
    const checked = checkServerUrl(manual);
    if (!checked.ok) {
      return {
        status: "needs-prompt",
        reason: checked.reason === "insecure-remote" ? "insecure-remote" : "invalid-url",
      };
    }
    if (checked.hostType === "local") {
      return { status: "resolved", target: manualTarget(checked.url) };
    }
    return { status: "remote", serverUrl: checked.url, kind: remoteServerKind(checked.url) };
  }
  if (discovery.found && discovery.baseUrl) {
    if (discovery.health === "ok") {
      return { status: "resolved", target: discoveredTarget(discovery.baseUrl) };
    }
    return { status: "needs-prompt", reason: "local-unhealthy" };
  }
  return { status: "needs-prompt", reason: "no-manual-no-local" };
}
