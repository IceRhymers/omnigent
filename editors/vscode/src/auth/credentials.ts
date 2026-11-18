/**
 * Credentials for one remote server, in the order the proxy uses them:
 *  1. the extension's own session (SecretStorage), from a browser sign-in or a
 *     session cookie the server set in the panel;
 *  2. the CLI's `omnigent login` session (read-only);
 *  3. none — the server's 401 sends the panel to sign in.
 *
 * Sessions near expiry are renewed from their refresh grant. A sign-out stops
 * CLI reuse for the server until the next interactive sign-in, so signing out
 * in VS Code doesn't silently sign back in with the CLI's session.
 */
import type { SessionCredential } from "./cliTokens";
import type { RefreshOutcome } from "./omnigentSignIn";

/** Renew a session with less than this much life left. */
export const REFRESH_MARGIN_MS = 90_000;

/** How long a read of the CLI token file is reused. */
const CLI_CACHE_MS = 10_000;

/** Persistent store for the extension's own sessions, keyed by server URL. */
export interface SessionVault {
  load(serverUrl: string): Promise<SessionCredential | undefined>;
  save(serverUrl: string, session: SessionCredential): Promise<void>;
  delete(serverUrl: string): Promise<void>;
}

/** Remembers the servers whose CLI session must not be reused. */
export interface CliReuseGate {
  isBlocked(serverUrl: string): boolean;
  setBlocked(serverUrl: string, blocked: boolean): Promise<void>;
}

export interface SignInStatus {
  /** Increments on every new sign-in, so a waiting page knows when to continue. */
  generation: number;
  inProgress: boolean;
  error?: string;
  /** Code to confirm in the browser, when the server shows one. */
  userCode?: string;
}

/**
 * How a server refused a token: `sign-in` means the token is no longer valid;
 * `forbidden` can also mean the user lacks access, so the token isn't ruled out.
 */
export type TokenRejection = "sign-in" | "forbidden";

/** What the proxy needs from a credential source. */
export interface ProxyCredentials {
  bearerToken(): Promise<string | undefined>;
  acceptSessionCookie(token: string, maxAgeSeconds: number | undefined): void;
  sessionCookieCleared(): void;
  /** The server refused this token; don't reuse the cached copy. */
  tokenRejected(token: string, rejection: TokenRejection): void;
  startSignIn(): void;
  signOut(): Promise<void>;
  status(): SignInStatus;
}

export interface ServerCredentialsOptions {
  serverUrl: string;
  vault: SessionVault;
  cliGate: CliReuseGate;
  readCliSession(serverUrl: string): Promise<SessionCredential | undefined>;
  refresh(refreshToken: string): Promise<RefreshOutcome>;
  revoke(refreshToken: string): Promise<void>;
  /** Interactive browser sign-in; absent when the server signs in inside the panel. */
  signIn?(signal: AbortSignal, onUserCode: (code: string) => void): Promise<SessionCredential>;
  /** Told when the server refuses a token, so the CLI source can drop it too. */
  onTokenRejected?(token: string, rejection: TokenRejection): void;
  now?(): number;
  log?(message: string): void;
}

export class ServerCredentials implements ProxyCredentials {
  private readonly serverUrl: string;
  private readonly now: () => number;
  private readonly loaded: Promise<void>;
  private own: SessionCredential | undefined;
  private cliCache: { at: number; session: SessionCredential | undefined } | undefined;
  /** A CLI session this extension renewed; the token file stays untouched. */
  private cliRenewed: SessionCredential | undefined;
  /** CLI refresh grants the server rejected, so they aren't retried per request. */
  private readonly deadCliGrants = new Set<string>();
  private readonly refreshes = new Map<string, Promise<SessionCredential | undefined>>();
  private signInAbort: AbortController | undefined;
  private state: SignInStatus = { generation: 0, inProgress: false };

  constructor(private readonly options: ServerCredentialsOptions) {
    this.serverUrl = options.serverUrl;
    this.now = options.now ?? Date.now;
    this.loaded = options.vault.load(this.serverUrl).then(
      (session) => {
        this.own ??= session;
      },
      () => undefined,
    );
  }

  async bearerToken(): Promise<string | undefined> {
    await this.loaded;
    if (this.own) {
      const own = await this.usable(this.own, "own");
      if (own) {
        return own.token;
      }
    }
    if (this.options.cliGate.isBlocked(this.serverUrl)) {
      return undefined;
    }
    return (await this.cliSession())?.token;
  }

  acceptSessionCookie(token: string, maxAgeSeconds: number | undefined): void {
    if (this.own?.token === token) {
      return;
    }
    const expiresAt =
      maxAgeSeconds !== undefined ? this.now() + maxAgeSeconds * 1000 : jwtExpiry(token);
    this.adopt({ token, expiresAt });
  }

  sessionCookieCleared(): void {
    void this.forget();
  }

  tokenRejected(token: string, rejection: TokenRejection): void {
    const own = this.own;
    if (own?.token === token) {
      if (own.refreshToken) {
        // Renew on next use; a dead grant then clears the session.
        this.own = { ...own, expiresAt: this.now() };
      } else {
        this.own = undefined;
        void this.options.vault.delete(this.serverUrl).catch(() => undefined);
      }
    }
    if (this.cliCache?.session?.token === token) {
      this.cliCache = undefined;
    }
    if (this.cliRenewed?.token === token) {
      this.cliRenewed = undefined;
    }
    this.options.onTokenRejected?.(token, rejection);
  }

  startSignIn(): void {
    const signIn = this.options.signIn;
    if (!signIn) {
      return;
    }
    this.signInAbort?.abort();
    const controller = new AbortController();
    this.signInAbort = controller;
    this.state = { generation: this.state.generation, inProgress: true };
    signIn(controller.signal, (userCode) => {
      if (this.signInAbort === controller) {
        this.state = { ...this.state, userCode };
      }
    }).then(
      (session) => {
        if (this.signInAbort === controller) {
          this.signInAbort = undefined;
          this.adopt(session);
        }
      },
      (error: unknown) => {
        if (this.signInAbort !== controller) {
          return;
        }
        this.signInAbort = undefined;
        const message = error instanceof Error ? error.message : String(error);
        this.state = { generation: this.state.generation, inProgress: false, error: message };
        this.options.log?.(`[omnigent] sign-in failed: ${message}`);
      },
    );
  }

  async signOut(): Promise<void> {
    this.signInAbort?.abort();
    this.signInAbort = undefined;
    this.state = { generation: this.state.generation, inProgress: false };
    await this.loaded;
    const own = this.own;
    await this.forget();
    // Only the extension's own grant is revoked; the CLI's stays usable by the CLI.
    if (own?.refreshToken) {
      await this.options.revoke(own.refreshToken);
    }
  }

  status(): SignInStatus {
    return { ...this.state };
  }

  /** Abandon any sign-in in progress (its loopback listener closes). */
  dispose(): void {
    this.signInAbort?.abort();
    this.signInAbort = undefined;
  }

  private adopt(session: SessionCredential): void {
    this.own = session;
    this.state = { generation: this.state.generation + 1, inProgress: false };
    void this.options.vault.save(this.serverUrl, session).catch(() => undefined);
    void this.options.cliGate.setBlocked(this.serverUrl, false).catch(() => undefined);
  }

  private async forget(): Promise<void> {
    this.own = undefined;
    this.cliRenewed = undefined;
    this.cliCache = undefined;
    await Promise.all([
      this.options.vault.delete(this.serverUrl).catch(() => undefined),
      this.options.cliGate.setBlocked(this.serverUrl, true).catch(() => undefined),
    ]);
  }

  private async cliSession(): Promise<SessionCredential | undefined> {
    if (!this.cliCache || this.now() - this.cliCache.at > CLI_CACHE_MS) {
      const session = await this.options.readCliSession(this.serverUrl).catch(() => undefined);
      this.cliCache = { at: this.now(), session };
    }
    let candidate = this.cliCache.session;
    if (
      this.cliRenewed &&
      (!candidate || (this.cliRenewed.expiresAt ?? 0) > (candidate.expiresAt ?? 0))
    ) {
      candidate = this.cliRenewed;
    }
    return candidate ? this.usable(candidate, "cli") : undefined;
  }

  /** The session itself, a renewed one, or undefined when it can't be used. */
  private async usable(
    session: SessionCredential,
    source: "own" | "cli",
  ): Promise<SessionCredential | undefined> {
    const remaining = session.expiresAt === undefined ? Infinity : session.expiresAt - this.now();
    if (remaining > REFRESH_MARGIN_MS) {
      return session;
    }
    const grant = session.refreshToken;
    if (!grant || (source === "cli" && this.deadCliGrants.has(grant))) {
      return remaining > 0 ? session : undefined;
    }
    let pending = this.refreshes.get(grant);
    if (!pending) {
      pending = this.renew(session, grant, source).finally(() => this.refreshes.delete(grant));
      this.refreshes.set(grant, pending);
    }
    const renewed = await pending;
    if (renewed) {
      return renewed;
    }
    return remaining > 0 ? session : undefined;
  }

  private async renew(
    session: SessionCredential,
    grant: string,
    source: "own" | "cli",
  ): Promise<SessionCredential | undefined> {
    const outcome = await this.options.refresh(grant);
    if (outcome.status === "refreshed") {
      const renewed = { userId: session.userId, ...outcome.session };
      if (source === "own") {
        if (this.own === session) {
          this.own = renewed;
          void this.options.vault.save(this.serverUrl, renewed).catch(() => undefined);
        }
      } else {
        this.cliRenewed = renewed;
      }
      return renewed;
    }
    if (outcome.status === "rejected") {
      this.options.log?.(`[omnigent] stored session for ${this.serverUrl} can no longer renew`);
      if (source === "own") {
        if (this.own === session) {
          this.own = undefined;
          void this.options.vault.delete(this.serverUrl).catch(() => undefined);
        }
      } else {
        this.deadCliGrants.add(grant);
      }
    }
    return undefined;
  }
}

/** A JWT's `exp` claim in epoch milliseconds, read without verifying. */
export function jwtExpiry(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) {
    return undefined;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    const exp = (claims as { exp?: unknown } | null)?.exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}
