/**
 * Recognize what kind of Omnigent server a remote URL points at and how it
 * signs users in, before anything is framed.
 *
 * The URL alone separates Databricks-hosted servers from self-hosted ones; a
 * self-hosted server then describes itself through its unauthenticated
 * `/.well-known/omnigent.json` manifest, or (older servers) through the
 * `login_url` of an unauthenticated `GET /v1/me`.
 */
import {
  isDatabricksManagedServerUrl,
  parseManifestAuth,
  sanitizeServerName,
} from "../../../../web/electron/src/url.js";
import { NetworkError, requestJson, serverEndpoint } from "../net/request";

export type RemoteServerKind = "self-hosted" | "databricks-app" | "databricks-workspace";

export type ServerAuthMode = "oidc" | "accounts" | "header" | "custom" | "none";

/** The only session cookies an Omnigent server sets. */
export const SESSION_COOKIE_NAMES = ["__Host-ap_session", "ap_session"] as const;

export const MANIFEST_TIMEOUT_MS = 5_000;

const DATABRICKS_APPS_DOMAIN = "databricksapps.com";

/** Classify a remote server URL by host. Pure. */
export function remoteServerKind(serverUrl: string): RemoteServerKind {
  if (!isDatabricksManagedServerUrl(serverUrl)) {
    return "self-hosted";
  }
  const host = new URL(serverUrl).hostname.toLowerCase();
  return host === DATABRICKS_APPS_DOMAIN || host.endsWith(`.${DATABRICKS_APPS_DOMAIN}`)
    ? "databricks-app"
    : "databricks-workspace";
}

export interface ServerProfile {
  authMode: ServerAuthMode;
  /** Session cookie names to capture from the server's responses. */
  sessionCookies: readonly string[];
  /** Whether the server advertises the native loopback sign-in (`/auth/native-token`). */
  nativeSignIn: boolean;
  /** Operator-chosen display name, for display only. */
  serverName: string | null;
}

export type ProbeResult =
  | { status: "ok"; profile: ServerProfile }
  | { status: "unreachable"; detail: string }
  | { status: "not-omnigent" };

/** Probe a remote server's sign-in mode. Never throws. */
export async function probeServer(
  serverUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  try {
    const manifest = await requestJson(
      serverEndpoint(serverUrl, "/.well-known/omnigent.json"),
      { timeoutMs: MANIFEST_TIMEOUT_MS },
      fetchImpl,
    );
    const profile = profileFromManifest(manifest.status, manifest.body, serverUrl);
    if (profile) {
      return { status: "ok", profile };
    }
    const me = await requestJson(
      serverEndpoint(serverUrl, "/v1/me"),
      { timeoutMs: MANIFEST_TIMEOUT_MS },
      fetchImpl,
    );
    const legacy = profileFromIdentityProbe(me.status, me.body, serverUrl);
    return legacy ? { status: "ok", profile: legacy } : { status: "not-omnigent" };
  } catch (error) {
    const detail = error instanceof NetworkError ? error.message : String(error);
    return { status: "unreachable", detail };
  }
}

/** Read the sign-in mode from a manifest response. Pure. */
export function profileFromManifest(
  status: number,
  body: Record<string, unknown> | null,
  serverUrl: string,
): ServerProfile | null {
  if (status !== 200 || body === null || typeof body.manifest_version !== "number") {
    return null;
  }
  const auth = parseManifestAuth(body.auth, serverUrl);
  if (auth === null) {
    // Manifests that predate the `auth` block: learn the mode the old way.
    return null;
  }
  const mode = auth.mode as ServerAuthMode;
  const signsInWithCookie = mode === "oidc" || mode === "accounts";
  return {
    authMode: mode,
    sessionCookies: auth.sessionCookie
      ? [auth.sessionCookie]
      : signsInWithCookie
        ? cookieNamesFor(serverUrl)
        : [],
    nativeSignIn: mode === "oidc",
    serverName: sanitizeServerName(body.server_name),
  };
}

/**
 * Infer the sign-in mode from an unauthenticated `GET /v1/me`. Pure.
 *
 * 401 + `login_url` names the mode; a 200 means no sign-in step, and a
 * redirect means a login proxy sits in front (header mode).
 */
export function profileFromIdentityProbe(
  status: number,
  body: Record<string, unknown> | null,
  serverUrl: string,
): ServerProfile | null {
  const base = { nativeSignIn: false, serverName: null };
  if (status === 401 && body !== null) {
    if (body.login_url === "/auth/login") {
      return { ...base, authMode: "oidc", sessionCookies: cookieNamesFor(serverUrl) };
    }
    if (body.login_url === "/login") {
      return { ...base, authMode: "accounts", sessionCookies: cookieNamesFor(serverUrl) };
    }
    return null;
  }
  if (status >= 300 && status < 400) {
    return { ...base, authMode: "header", sessionCookies: [] };
  }
  if (status === 200 && body !== null && "user_id" in body) {
    // An anonymous caller with no identity is header mode without its proxy.
    const authMode = body.user_id === null ? "header" : "none";
    return { ...base, authMode, sessionCookies: [] };
  }
  return null;
}

function cookieNamesFor(serverUrl: string): string[] {
  // Browsers only accept a `__Host-` cookie over https.
  return new URL(serverUrl).protocol === "https:" ? [...SESSION_COOKIE_NAMES] : ["ap_session"];
}
