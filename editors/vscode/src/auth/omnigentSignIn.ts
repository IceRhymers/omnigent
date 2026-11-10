/**
 * Browser sign-in to an OIDC Omnigent server, plus the refresh and revoke
 * calls for the grant it returns. Mirrors the desktop shell
 * (web/electron/src/oidc-credentials.js) without its Electron dependencies.
 *
 * Servers that advertise native sign-in get the RFC 8252 loopback flow
 * (`/auth/login` native parameters + `POST /auth/native-token`). Older OIDC
 * servers get the CLI ticket flow (`/auth/cli-login` + `/auth/cli-poll`).
 */
import {
  LOOPBACK_TIMEOUT_MS,
  makePkce,
  runLoopbackAuthorization,
} from "../../../../web/electron/src/loopback-oauth.js";
import { requestJson, serverEndpoint } from "../net/request";
import type { SessionCredential } from "./cliTokens";

export interface BrowserSignInOptions {
  /** Open a URL in the system browser. */
  openExternal(url: string): Promise<unknown>;
  /** Whether the server advertises the native loopback sign-in. */
  nativeSignIn: boolean;
  signal?: AbortSignal;
  /** Called with the code the user confirms in the browser (ticket flow only). */
  onUserCode?(userCode: string): void;
  fetchImpl?: typeof fetch;
  /** Ticket-flow poll interval; tests shorten it. */
  pollIntervalMs?: number;
}

export class SignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInError";
  }
}

/** Sign in through the system browser and return the new session. */
export async function signInWithBrowser(
  serverUrl: string,
  options: BrowserSignInOptions,
  now: () => number = Date.now,
): Promise<SessionCredential> {
  return options.nativeSignIn
    ? nativeSignIn(serverUrl, options, now)
    : ticketSignIn(serverUrl, options, now);
}

async function nativeSignIn(
  serverUrl: string,
  options: BrowserSignInOptions,
  now: () => number,
): Promise<SessionCredential> {
  const { verifier, challenge } = makePkce();
  const loginUrl = serverEndpoint(serverUrl, "/auth/login");
  let callback: { params: URLSearchParams; redirectUri: string };
  try {
    callback = await runLoopbackAuthorization({
      // RFC 8252 §8.3: the IP literal, never `localhost`, which could resolve elsewhere.
      hostname: "127.0.0.1",
      callbackPath: "/callback",
      redirectUri: (port) => `http://127.0.0.1:${port}/callback`,
      authorizeUrl: (redirectUri, state) =>
        `${loginUrl}?${new URLSearchParams({
          native_redirect_uri: redirectUri,
          native_state: state,
          code_challenge: challenge,
          code_challenge_method: "S256",
        })}`,
      openExternal: options.openExternal,
      pages: {
        received: ["Signed in", "Return to VS Code, then close this tab."],
        failed: ["Sign-in was not completed", "Close this tab and try again in VS Code."],
        incomplete: ["Sign-in could not be completed", "Close this tab and try again in VS Code."],
      },
      signal: options.signal,
    });
  } catch (error) {
    throw describeLoopbackError(error, options.signal);
  }
  const exchange = await requestJson(
    serverEndpoint(serverUrl, "/auth/native-token"),
    {
      form: {
        code: callback.params.get("code") ?? "",
        code_verifier: verifier,
        redirect_uri: callback.redirectUri,
      },
      signal: options.signal,
    },
    options.fetchImpl,
  );
  const session = exchange.status === 200 ? sessionFrom(exchange.body, now) : undefined;
  if (!session) {
    throw new SignInError(`The server rejected the sign-in (HTTP ${exchange.status}).`);
  }
  return session;
}

async function ticketSignIn(
  serverUrl: string,
  options: BrowserSignInOptions,
  now: () => number,
): Promise<SessionCredential> {
  const { verifier, challenge } = makePkce();
  const created = await requestJson(
    serverEndpoint(serverUrl, "/auth/cli-login"),
    { json: { code_challenge: challenge, code_challenge_method: "S256" }, signal: options.signal },
    options.fetchImpl,
  );
  const ticket = created.body?.ticket;
  const loginPath = created.body?.login_url;
  if (
    created.status !== 200 ||
    typeof ticket !== "string" ||
    typeof loginPath !== "string" ||
    !loginPath.startsWith("/auth/login")
  ) {
    throw new SignInError("This server can't sign in from VS Code. Update the server and retry.");
  }
  if (typeof created.body?.user_code === "string") {
    options.onUserCode?.(created.body.user_code);
  }
  try {
    await options.openExternal(serverEndpoint(serverUrl, loginPath));
  } catch (error) {
    throw new SignInError(`Couldn't open your browser: ${errorMessage(error)}`);
  }

  const deadline = now() + LOOPBACK_TIMEOUT_MS;
  const pollUrl = `${serverEndpoint(serverUrl, "/auth/cli-poll")}?${new URLSearchParams({ ticket })}`;
  while (now() < deadline) {
    await delay(options.pollIntervalMs ?? 2_000, options.signal);
    const poll = await requestJson(
      pollUrl,
      { headers: { "X-Omnigent-Code-Verifier": verifier }, signal: options.signal },
      options.fetchImpl,
    );
    if (poll.status === 202) {
      continue;
    }
    const session = poll.status === 200 ? sessionFrom(poll.body, now) : undefined;
    if (session) {
      return session;
    }
    const reason = typeof poll.body?.error === "string" ? poll.body.error : `HTTP ${poll.status}`;
    throw new SignInError(`Sign-in was not completed (${reason}).`);
  }
  throw new SignInError("Timed out waiting for the browser sign-in.");
}

export type RefreshOutcome =
  | { status: "refreshed"; session: SessionCredential }
  /** The grant is dead (revoked, expired) or the server has no refresh route. */
  | { status: "rejected" }
  /** A transient failure; the grant may still work later. */
  | { status: "failed" };

/** Mint a new session from a refresh grant. Never throws. */
export async function refreshSession(
  serverUrl: string,
  refreshToken: string,
  fetchImpl?: typeof fetch,
  now: () => number = Date.now,
): Promise<RefreshOutcome> {
  let response;
  try {
    response = await requestJson(
      serverEndpoint(serverUrl, "/oauth/token"),
      { form: { grant_type: "refresh_token", refresh_token: refreshToken } },
      fetchImpl,
    );
  } catch {
    return { status: "failed" };
  }
  const session = response.status === 200 ? sessionFrom(response.body, now) : undefined;
  if (session) {
    // Login grants do not rotate; keep the one we hold when none comes back.
    return { status: "refreshed", session: { refreshToken, ...session } };
  }
  const error = response.body?.error;
  if (response.status === 404 || error === "invalid_grant" || error === "expired_token") {
    return { status: "rejected" };
  }
  return { status: "failed" };
}

/** Revoke a refresh grant. Best effort: never throws. */
export async function revokeGrant(
  serverUrl: string,
  refreshToken: string,
  fetchImpl?: typeof fetch,
): Promise<void> {
  try {
    await requestJson(
      serverEndpoint(serverUrl, "/oauth/revoke"),
      { form: { refresh_token: refreshToken } },
      fetchImpl,
    );
  } catch {
    // The local copy is already gone; the grant expires on its own.
  }
}

/** Read `{token | access_token, expires_in, refresh_token, user_id}`. Pure. */
export function sessionFrom(
  body: Record<string, unknown> | null,
  now: () => number = Date.now,
): SessionCredential | undefined {
  const token = body?.token ?? body?.access_token;
  if (typeof token !== "string" || token === "") {
    return undefined;
  }
  const expiresIn = body?.expires_in;
  const session: SessionCredential = { token };
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
    session.expiresAt = now() + expiresIn * 1000;
  }
  if (typeof body?.refresh_token === "string" && body.refresh_token !== "") {
    session.refreshToken = body.refresh_token;
  }
  if (typeof body?.user_id === "string") {
    session.userId = body.user_id;
  }
  return session;
}

/** A loopback sign-in failure as a message for the panel; an abort passes through. */
export function describeLoopbackError(error: unknown, signal: AbortSignal | undefined): unknown {
  if (signal?.aborted) {
    return error;
  }
  const code = (error as { code?: string } | null)?.code;
  if (code === "LOOPBACK_TIMEOUT") {
    return new SignInError("Timed out waiting for the browser sign-in.");
  }
  if (code === "BROWSER_UNAVAILABLE") {
    return new SignInError("Couldn't open your browser.");
  }
  const description = (error as { errorDescription?: string } | null)?.errorDescription;
  return new SignInError(
    description ? `Sign-in failed: ${description}` : `Sign-in failed: ${errorMessage(error)}`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
