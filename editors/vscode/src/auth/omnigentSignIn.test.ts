/**
 * Browser sign-in against a fake OIDC server. The loopback listener is real; a
 * fake "browser" follows the authorize URL straight to its redirect.
 */
import { describe, expect, it, vi } from "vitest";
import * as crypto from "node:crypto";
import { refreshSession, revokeGrant, sessionFrom, signInWithBrowser } from "./omnigentSignIn";

const SERVER = "https://omnigent.example.com/team";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Call {
  url: string;
  init: RequestInit;
}

function fakeServer(route: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return route(call);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function form(call: Call): URLSearchParams {
  return new URLSearchParams(String(call.init.body));
}

describe("signInWithBrowser (native loopback)", () => {
  it("completes PKCE through the loopback redirect and exchanges the code", async () => {
    let challenge = "";
    const opened: string[] = [];
    const browser = vi.fn(async (url: string) => {
      opened.push(url);
      const authorize = new URL(url);
      challenge = authorize.searchParams.get("code_challenge") ?? "";
      const redirect = new URL(authorize.searchParams.get("native_redirect_uri") ?? "");
      redirect.searchParams.set("code", "auth-code");
      redirect.searchParams.set("state", authorize.searchParams.get("native_state") ?? "");
      // The browser lands on the loopback listener after the user signs in.
      void fetch(redirect).then((response) => response.text());
      return true;
    });
    const server = fakeServer((call) => {
      expect(call.url).toBe(`${SERVER}/auth/native-token`);
      const body = form(call);
      const verifierHash = crypto
        .createHash("sha256")
        .update(body.get("code_verifier") ?? "")
        .digest("base64url");
      if (body.get("code") !== "auth-code" || verifierHash !== challenge) {
        return json(400, { error: "invalid_grant" });
      }
      return json(200, {
        token: "session-jwt",
        expires_in: 3600,
        refresh_token: "grant",
        user_id: "u1",
      });
    });

    const session = await signInWithBrowser(
      SERVER,
      { openExternal: browser, nativeSignIn: true, fetchImpl: server.fetchImpl },
      () => 1_000,
    );

    expect(session).toEqual({
      token: "session-jwt",
      expiresAt: 1_000 + 3_600_000,
      refreshToken: "grant",
      userId: "u1",
    });
    const authorize = new URL(opened[0]);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${SERVER}/auth/login`);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("native_redirect_uri")).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    );
    expect(form(server.calls[0]).get("redirect_uri")).toBe(
      authorize.searchParams.get("native_redirect_uri"),
    );
  });

  it("reports the server's refusal from the browser", async () => {
    const browser = vi.fn(async (url: string) => {
      const authorize = new URL(url);
      const redirect = new URL(authorize.searchParams.get("native_redirect_uri") ?? "");
      redirect.searchParams.set("error", "access_denied");
      redirect.searchParams.set("error_description", "Not allowed");
      redirect.searchParams.set("state", authorize.searchParams.get("native_state") ?? "");
      void fetch(redirect).then((response) => response.text());
      return true;
    });
    const server = fakeServer(() => json(500, {}));
    await expect(
      signInWithBrowser(SERVER, {
        openExternal: browser,
        nativeSignIn: true,
        fetchImpl: server.fetchImpl,
      }),
    ).rejects.toThrow("Sign-in failed: Not allowed");
    expect(server.calls).toHaveLength(0);
  });

  it("stops waiting when aborted", async () => {
    const abort = new AbortController();
    const promise = signInWithBrowser(SERVER, {
      openExternal: async () => {
        abort.abort(new Error("cancelled"));
        return true;
      },
      nativeSignIn: true,
      signal: abort.signal,
    });
    await expect(promise).rejects.toThrow("cancelled");
  });
});

describe("signInWithBrowser (ticket flow)", () => {
  it("opens the ticket's login page and polls until the session is ready", async () => {
    let polls = 0;
    const server = fakeServer((call) => {
      if (call.url === `${SERVER}/auth/cli-login`) {
        expect(JSON.parse(String(call.init.body))).toMatchObject({ code_challenge_method: "S256" });
        return json(200, { ticket: "t1", login_url: "/auth/login?ticket=t1", user_code: "WXYZ" });
      }
      expect(call.url).toBe(`${SERVER}/auth/cli-poll?ticket=t1`);
      expect((call.init.headers as Record<string, string>)["X-Omnigent-Code-Verifier"]).toMatch(
        /^[A-Za-z0-9_-]{43,}$/,
      );
      polls += 1;
      return polls < 2 ? json(202, {}) : json(200, { token: "ticket-jwt" });
    });
    const openExternal = vi.fn(async () => true);
    const onUserCode = vi.fn();

    const session = await signInWithBrowser(SERVER, {
      openExternal,
      nativeSignIn: false,
      onUserCode,
      fetchImpl: server.fetchImpl,
      pollIntervalMs: 1,
    });

    expect(session).toEqual({ token: "ticket-jwt" });
    expect(openExternal).toHaveBeenCalledWith(`${SERVER}/auth/login?ticket=t1`);
    expect(onUserCode).toHaveBeenCalledWith("WXYZ");
    expect(polls).toBe(2);
  });

  it("refuses a login URL that isn't the server's own sign-in page", async () => {
    const server = fakeServer(() =>
      json(200, { ticket: "t1", login_url: "https://evil.example/login" }),
    );
    const openExternal = vi.fn(async () => true);
    await expect(
      signInWithBrowser(SERVER, {
        openExternal,
        nativeSignIn: false,
        fetchImpl: server.fetchImpl,
      }),
    ).rejects.toThrow("can't sign in from VS Code");
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe("refreshSession", () => {
  it("returns the new session, keeping a grant that didn't rotate", async () => {
    const server = fakeServer((call) => {
      expect(call.url).toBe(`${SERVER}/oauth/token`);
      expect(Object.fromEntries(form(call))).toEqual({
        grant_type: "refresh_token",
        refresh_token: "grant",
      });
      return json(200, { access_token: "fresh", expires_in: 60 });
    });
    expect(await refreshSession(SERVER, "grant", server.fetchImpl, () => 0)).toEqual({
      status: "refreshed",
      session: { token: "fresh", expiresAt: 60_000, refreshToken: "grant" },
    });
  });

  it.each([
    ["invalid_grant", "rejected", 400, { error: "invalid_grant" }],
    ["expired_token", "rejected", 400, { error: "expired_token" }],
    ["no refresh route", "rejected", 404, {}],
    ["a server error", "failed", 503, {}],
  ])("maps %s to %s", async (_label, status, httpStatus, body) => {
    const server = fakeServer(() => json(httpStatus, body));
    expect(await refreshSession(SERVER, "grant", server.fetchImpl)).toEqual({ status });
  });

  it("reports a network failure as transient", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await refreshSession(SERVER, "grant", fetchImpl)).toEqual({ status: "failed" });
  });
});

describe("revokeGrant", () => {
  it("posts the grant and never throws", async () => {
    const server = fakeServer(() => json(200, {}));
    await revokeGrant(SERVER, "grant", server.fetchImpl);
    expect(server.calls[0].url).toBe(`${SERVER}/oauth/revoke`);
    expect(form(server.calls[0]).get("refresh_token")).toBe("grant");
    const failing = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(revokeGrant(SERVER, "grant", failing)).resolves.toBeUndefined();
  });
});

describe("sessionFrom", () => {
  it("reads token responses and rejects ones without a token", () => {
    expect(sessionFrom({ token: "a", expires_in: 0 })).toEqual({ token: "a" });
    expect(sessionFrom({ token: "" })).toBeUndefined();
    expect(sessionFrom(null)).toBeUndefined();
  });
});
