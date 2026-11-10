/**
 * ServerCredentials: which session the proxy sends, renewal near expiry, and
 * how sign-in, session cookies, and sign-out move between them.
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionCredential } from "./cliTokens";
import type { RefreshOutcome } from "./omnigentSignIn";
import {
  REFRESH_MARGIN_MS,
  ServerCredentials,
  jwtExpiry,
  type CliReuseGate,
  type ServerCredentialsOptions,
  type SessionVault,
} from "./credentials";

const SERVER = "https://omnigent.example.com";
const HOUR = 3_600_000;
const START = 1_000_000_000_000;

class MemoryVault implements SessionVault {
  readonly sessions = new Map<string, SessionCredential>();
  async load(serverUrl: string) {
    return this.sessions.get(serverUrl);
  }
  async save(serverUrl: string, session: SessionCredential) {
    this.sessions.set(serverUrl, session);
  }
  async delete(serverUrl: string) {
    this.sessions.delete(serverUrl);
  }
}

class MemoryGate implements CliReuseGate {
  readonly blocked = new Set<string>();
  isBlocked(serverUrl: string) {
    return this.blocked.has(serverUrl);
  }
  async setBlocked(serverUrl: string, blocked: boolean) {
    if (blocked) this.blocked.add(serverUrl);
    else this.blocked.delete(serverUrl);
  }
}

function setup(overrides: Partial<ServerCredentialsOptions> & { stored?: SessionCredential } = {}) {
  let clock = START;
  const vault = new MemoryVault();
  if (overrides.stored) vault.sessions.set(SERVER, overrides.stored);
  const gate = new MemoryGate();
  const options: ServerCredentialsOptions = {
    serverUrl: SERVER,
    vault,
    cliGate: gate,
    readCliSession: vi.fn(async () => undefined),
    refresh: vi.fn(async (): Promise<RefreshOutcome> => ({ status: "failed" })),
    revoke: vi.fn(async () => undefined),
    now: () => clock,
    ...overrides,
  };
  const credentials = new ServerCredentials(options);
  return {
    credentials,
    vault,
    gate,
    options,
    now: () => clock,
    advance: (ms: number) => (clock += ms),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("ServerCredentials precedence", () => {
  it("prefers its own stored session over the CLI's", async () => {
    const { credentials, options } = setup({
      stored: { token: "own" },
      readCliSession: vi.fn(async () => ({ token: "cli" })),
    });
    expect(await credentials.bearerToken()).toBe("own");
    expect(options.readCliSession).not.toHaveBeenCalled();
  });

  it("reuses the CLI session, re-reading the token file at most every 10 s", async () => {
    const readCliSession = vi.fn(async () => ({ token: "cli" }));
    const { credentials, advance } = setup({ readCliSession });
    expect(await credentials.bearerToken()).toBe("cli");
    expect(await credentials.bearerToken()).toBe("cli");
    expect(readCliSession).toHaveBeenCalledTimes(1);
    advance(10_001);
    await credentials.bearerToken();
    expect(readCliSession).toHaveBeenCalledTimes(2);
  });

  it("sends nothing when no session exists", async () => {
    const { credentials } = setup();
    expect(await credentials.bearerToken()).toBeUndefined();
  });
});

describe("ServerCredentials renewal", () => {
  it("renews its own session near expiry once, even for concurrent requests", async () => {
    let release: (outcome: RefreshOutcome) => void = () => undefined;
    const refresh = vi.fn(() => new Promise<RefreshOutcome>((resolve) => (release = resolve)));
    const { credentials, vault } = setup({
      refresh,
      stored: { token: "old", refreshToken: "grant", expiresAt: START + REFRESH_MARGIN_MS - 1 },
    });
    const first = credentials.bearerToken();
    const second = credentials.bearerToken();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    release({
      status: "refreshed",
      session: { token: "new", refreshToken: "grant", expiresAt: START + HOUR },
    });
    expect(await Promise.all([first, second])).toEqual(["new", "new"]);
    expect(vault.sessions.get(SERVER)?.token).toBe("new");
    expect(await credentials.bearerToken()).toBe("new");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps using a still-valid session when renewal fails transiently", async () => {
    const { credentials, options } = setup({
      stored: { token: "old", refreshToken: "grant", expiresAt: START + 30_000 },
    });
    expect(await credentials.bearerToken()).toBe("old");
    expect(options.refresh).toHaveBeenCalledWith("grant");
  });

  it("drops a rejected grant and falls back to the CLI session", async () => {
    const { credentials, vault } = setup({
      stored: { token: "old", refreshToken: "dead", expiresAt: 0 },
      refresh: vi.fn(async (): Promise<RefreshOutcome> => ({ status: "rejected" })),
      readCliSession: vi.fn(async () => ({ token: "cli" })),
    });
    expect(await credentials.bearerToken()).toBe("cli");
    await flush();
    expect(vault.sessions.has(SERVER)).toBe(false);
  });

  it("doesn't send an expired session that has no grant", async () => {
    const { credentials } = setup({ stored: { token: "old", expiresAt: 0 } });
    expect(await credentials.bearerToken()).toBeUndefined();
  });

  it("renews a CLI session in memory and stops retrying a rejected CLI grant", async () => {
    const refresh = vi.fn(async (grant: string): Promise<RefreshOutcome> =>
      grant === "cli-grant"
        ? { status: "refreshed", session: { token: "cli-new", expiresAt: START + HOUR } }
        : { status: "rejected" },
    );
    const renewing = setup({
      refresh,
      readCliSession: vi.fn(async () => ({
        token: "cli-old",
        refreshToken: "cli-grant",
        expiresAt: 0,
      })),
    });
    expect(await renewing.credentials.bearerToken()).toBe("cli-new");
    renewing.advance(20_000);
    expect(await renewing.credentials.bearerToken()).toBe("cli-new");
    expect(refresh).toHaveBeenCalledTimes(1);

    const rejected = setup({
      refresh,
      readCliSession: vi.fn(async () => ({
        token: "cli-old",
        refreshToken: "revoked",
        expiresAt: 0,
      })),
    });
    expect(await rejected.credentials.bearerToken()).toBeUndefined();
    rejected.advance(20_000);
    expect(await rejected.credentials.bearerToken()).toBeUndefined();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe("ServerCredentials session cookies and sign-out", () => {
  it("adopts a session cookie, bumping the generation once per new token", async () => {
    const { credentials, vault, now } = setup();
    await flush();
    credentials.acceptSessionCookie("cookie-token", 600);
    credentials.acceptSessionCookie("cookie-token", 600);
    expect(credentials.status().generation).toBe(1);
    await flush();
    expect(vault.sessions.get(SERVER)).toEqual({
      token: "cookie-token",
      expiresAt: now() + 600_000,
    });
    expect(await credentials.bearerToken()).toBe("cookie-token");
  });

  it("stops reusing the CLI session after sign-out, until the next sign-in", async () => {
    const { credentials, gate, options } = setup({
      stored: { token: "own", refreshToken: "own-grant" },
      readCliSession: vi.fn(async () => ({ token: "cli", refreshToken: "cli-grant" })),
    });
    await credentials.signOut();
    expect(options.revoke).toHaveBeenCalledWith("own-grant");
    expect(options.revoke).toHaveBeenCalledTimes(1);
    expect(gate.isBlocked(SERVER)).toBe(true);
    expect(await credentials.bearerToken()).toBeUndefined();

    credentials.acceptSessionCookie("fresh", undefined);
    await flush();
    expect(gate.isBlocked(SERVER)).toBe(false);
    expect(await credentials.bearerToken()).toBe("fresh");
  });

  it("treats a cleared session cookie as a sign-out without revoking", async () => {
    const { credentials, gate, options } = setup({
      stored: { token: "own" },
      readCliSession: vi.fn(async () => ({ token: "cli" })),
    });
    await flush();
    credentials.sessionCookieCleared();
    await flush();
    expect(await credentials.bearerToken()).toBeUndefined();
    expect(gate.isBlocked(SERVER)).toBe(true);
    expect(options.revoke).not.toHaveBeenCalled();
  });
});

describe("ServerCredentials browser sign-in", () => {
  it("reports progress and the user code, then adopts the new session", async () => {
    let finish: (session: SessionCredential) => void = () => undefined;
    const signIn = vi.fn((_signal: AbortSignal, onUserCode: (code: string) => void) => {
      onUserCode("ABCD-1234");
      return new Promise<SessionCredential>((resolve) => (finish = resolve));
    });
    const { credentials } = setup({ signIn });
    credentials.startSignIn();
    expect(credentials.status()).toEqual({
      generation: 0,
      inProgress: true,
      userCode: "ABCD-1234",
    });
    finish({ token: "signed-in" });
    await vi.waitFor(() => expect(credentials.status().generation).toBe(1));
    expect(credentials.status().inProgress).toBe(false);
    expect(await credentials.bearerToken()).toBe("signed-in");
  });

  it("reports a failed sign-in", async () => {
    const { credentials } = setup({
      signIn: vi.fn(async () => {
        throw new Error("Timed out waiting for the browser sign-in.");
      }),
    });
    credentials.startSignIn();
    await vi.waitFor(() =>
      expect(credentials.status()).toEqual({
        generation: 0,
        inProgress: false,
        error: "Timed out waiting for the browser sign-in.",
      }),
    );
  });

  it("abandons an in-flight sign-in on a restart or dispose", async () => {
    const signals: AbortSignal[] = [];
    const signIn = vi.fn(
      (signal: AbortSignal) =>
        new Promise<SessionCredential>((_resolve, reject) => {
          signals.push(signal);
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    const { credentials } = setup({ signIn });
    credentials.startSignIn();
    credentials.startSignIn();
    expect(signals[0].aborted).toBe(true);
    credentials.dispose();
    expect(signals[1].aborted).toBe(true);
    await flush();
    expect(credentials.status().error).toBeUndefined();
  });

  it("does nothing when the server signs in inside the panel", () => {
    const { credentials } = setup();
    credentials.startSignIn();
    expect(credentials.status().inProgress).toBe(false);
  });
});

describe("jwtExpiry", () => {
  it("reads exp without verifying", () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1_800_000_000 })).toString("base64url");
    expect(jwtExpiry(`h.${payload}.s`)).toBe(1_800_000_000_000);
    expect(jwtExpiry("opaque")).toBeUndefined();
    expect(jwtExpiry("h.!!!.s")).toBeUndefined();
  });
});
