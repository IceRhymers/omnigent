/**
 * Databricks workspace sign-in for apps on Databricks Apps, used when the
 * Databricks CLI has no token: the RFC 8252 loopback flow with the public
 * `omnigent` OAuth client, as the desktop shell runs it
 * (web/electron/src/databricks-oauth.js), plus the refresh for its grant.
 */
import { makePkce, runLoopbackAuthorization } from "../../../../web/electron/src/loopback-oauth.js";
import { NetworkError, requestJson } from "../net/request";
import type { SessionCredential } from "./cliTokens";
import {
  SignInError,
  describeLoopbackError,
  sessionFrom,
  type RefreshOutcome,
} from "./omnigentSignIn";

export const DATABRICKS_OAUTH_CLIENT_ID = "omnigent";
const SCOPES = "all-apis offline_access";
/** The client's registered redirect; Databricks ignores the ephemeral port. */
const REDIRECT_BASE = "http://localhost";
const PREFLIGHT_TIMEOUT_MS = 8_000;

export interface DatabricksSignInOptions {
  openExternal(url: string): Promise<unknown>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** Sign in to a workspace (`https://<host>`) through the system browser. */
export async function signInWithDatabricks(
  workspaceOrigin: string,
  options: DatabricksSignInOptions,
  now: () => number = Date.now,
): Promise<SessionCredential> {
  const authorizeEndpoint = `${workspaceOrigin}/oidc/v1/authorize`;
  await requireClient(authorizeEndpoint, workspaceOrigin, options);
  const { verifier, challenge } = makePkce();
  let callback: { params: URLSearchParams; redirectUri: string };
  try {
    callback = await runLoopbackAuthorization({
      hostname: new URL(REDIRECT_BASE).hostname,
      callbackPath: "/",
      redirectUri: (port) => `${REDIRECT_BASE}:${port}`,
      authorizeUrl: (redirectUri, state) =>
        `${authorizeEndpoint}?${authorizeQuery(redirectUri, state, challenge)}`,
      openExternal: options.openExternal,
      pages: {
        received: ["Databricks sign-in received", "Return to VS Code, then close this tab."],
        failed: [
          "Databricks sign-in was not completed",
          "Close this tab and try again in VS Code.",
        ],
        incomplete: [
          "Databricks sign-in could not be completed",
          "Close this tab and try again in VS Code.",
        ],
      },
      signal: options.signal,
    });
  } catch (error) {
    throw describeLoopbackError(error, options.signal);
  }
  // RFC 9207: a code from another issuer would mint a token this workspace doesn't accept.
  const issuer = callback.params.get("iss");
  if (issuer !== null && originOf(issuer) !== workspaceOrigin) {
    throw new SignInError(`Sign in with your ${new URL(workspaceOrigin).host} account.`);
  }
  const exchange = await requestJson(
    `${workspaceOrigin}/oidc/v1/token`,
    {
      form: {
        grant_type: "authorization_code",
        code: callback.params.get("code") ?? "",
        redirect_uri: callback.redirectUri,
        client_id: DATABRICKS_OAUTH_CLIENT_ID,
        code_verifier: verifier,
      },
      signal: options.signal,
    },
    options.fetchImpl,
  );
  const session = exchange.status === 200 ? sessionFrom(exchange.body, now) : undefined;
  if (!session) {
    throw new SignInError(`Databricks rejected the sign-in (HTTP ${exchange.status}).`);
  }
  return session;
}

/** Mint a new access token from a refresh grant. Never throws. */
export async function refreshDatabricksGrant(
  workspaceOrigin: string,
  refreshToken: string,
  fetchImpl?: typeof fetch,
  now: () => number = Date.now,
): Promise<RefreshOutcome> {
  let response;
  try {
    response = await requestJson(
      `${workspaceOrigin}/oidc/v1/token`,
      {
        form: {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: DATABRICKS_OAUTH_CLIENT_ID,
        },
      },
      fetchImpl,
    );
  } catch {
    return { status: "failed" };
  }
  const session = response.status === 200 ? sessionFrom(response.body, now) : undefined;
  if (session) {
    // Rotating grants come back replaced; otherwise keep the one we hold.
    return { status: "refreshed", session: { refreshToken, ...session } };
  }
  // A revoked, expired, or already-spent grant: only a new sign-in helps.
  if (response.status === 400 || response.status === 401) {
    return { status: "rejected" };
  }
  return { status: "failed" };
}

/**
 * Fail before opening a browser that can't finish: a registered client gets a
 * redirect to the sign-in page, an unknown one an error.
 */
async function requireClient(
  authorizeEndpoint: string,
  workspaceOrigin: string,
  options: DatabricksSignInOptions,
): Promise<void> {
  const host = new URL(workspaceOrigin).host;
  let status: number;
  try {
    const { challenge } = makePkce();
    const response = await requestJson(
      `${authorizeEndpoint}?${authorizeQuery(REDIRECT_BASE, "preflight", challenge)}`,
      { headers: { Accept: "text/html" }, timeoutMs: PREFLIGHT_TIMEOUT_MS, signal: options.signal },
      options.fetchImpl,
    );
    status = response.status;
  } catch (error) {
    options.signal?.throwIfAborted();
    throw new SignInError(
      error instanceof NetworkError
        ? `Couldn't reach ${host}. Check your network connection, then try again.`
        : `Couldn't start the Databricks sign-in: ${String(error)}`,
    );
  }
  if (status < 300 || status >= 400) {
    throw new SignInError(
      `VS Code can't sign in to ${host} directly. Run \`databricks auth login --host ${workspaceOrigin}\` in a terminal, then try again.`,
    );
  }
}

function authorizeQuery(redirectUri: string, state: string, challenge: string): string {
  return new URLSearchParams({
    response_type: "code",
    client_id: DATABRICKS_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
