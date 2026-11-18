/**
 * Databricks workspace sign-in against a fake workspace. The loopback listener
 * is real; a fake "browser" follows the authorize URL straight to its redirect.
 */
import { describe, expect, it, vi } from "vitest";
import * as crypto from "node:crypto";
import { refreshDatabricksGrant, signInWithDatabricks } from "./databricksSignIn";

const WORKSPACE = "https://dbc-1.cloud.databricks.com";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const signInChallenge = () =>
  new Response(null, { status: 302, headers: { location: `${WORKSPACE}/login.html` } });

function fakeWorkspace(route: (url: URL, body: URLSearchParams) => Response) {
  const calls: URL[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push(url);
    return route(url, new URLSearchParams(String(init.body ?? "")));
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

/** A browser that signs in at once and lands on the loopback redirect with `params`. */
function fakeBrowser(params: (authorize: URL) => Record<string, string>) {
  const opened: URL[] = [];
  const openExternal = vi.fn(async (url: string) => {
    const authorize = new URL(url);
    opened.push(authorize);
    const redirect = new URL(authorize.searchParams.get("redirect_uri") ?? "");
    for (const [name, value] of Object.entries(params(authorize))) {
      redirect.searchParams.set(name, value);
    }
    void fetch(redirect).then((response) => response.text());
    return true;
  });
  return { opened, openExternal };
}

describe("signInWithDatabricks", () => {
  it("checks the client, completes PKCE through the loopback redirect, and exchanges the code", async () => {
    let challenge = "";
    const browser = fakeBrowser((authorize) => {
      challenge = authorize.searchParams.get("code_challenge") ?? "";
      return {
        code: "auth-code",
        state: authorize.searchParams.get("state") ?? "",
        iss: WORKSPACE,
      };
    });
    let exchange: URLSearchParams | undefined;
    const workspace = fakeWorkspace((url, body) => {
      if (url.pathname === "/oidc/v1/authorize") {
        return signInChallenge();
      }
      expect(url.href).toBe(`${WORKSPACE}/oidc/v1/token`);
      exchange = body;
      const verifierHash = crypto
        .createHash("sha256")
        .update(body.get("code_verifier") ?? "")
        .digest("base64url");
      if (body.get("code") !== "auth-code" || verifierHash !== challenge) {
        return json(400, { error: "invalid_grant" });
      }
      return json(200, { access_token: "ws-token", refresh_token: "grant", expires_in: 3600 });
    });

    const session = await signInWithDatabricks(
      WORKSPACE,
      { openExternal: browser.openExternal, fetchImpl: workspace.fetchImpl },
      () => 1_000,
    );

    expect(session).toEqual({ token: "ws-token", refreshToken: "grant", expiresAt: 3_601_000 });
    expect(workspace.calls[0].searchParams.get("client_id")).toBe("omnigent");
    const authorize = browser.opened[0];
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${WORKSPACE}/oidc/v1/authorize`);
    expect(authorize.searchParams.get("scope")).toBe("all-apis offline_access");
    expect(authorize.searchParams.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+$/);
    expect(exchange?.get("grant_type")).toBe("authorization_code");
    expect(exchange?.get("client_id")).toBe("omnigent");
    expect(exchange?.get("redirect_uri")).toBe(authorize.searchParams.get("redirect_uri"));
  });

  it("refuses a code from another issuer without exchanging it", async () => {
    const browser = fakeBrowser((authorize) => ({
      code: "auth-code",
      state: authorize.searchParams.get("state") ?? "",
      iss: "https://dbc-2.cloud.databricks.com",
    }));
    const workspace = fakeWorkspace(() => signInChallenge());
    await expect(
      signInWithDatabricks(WORKSPACE, {
        openExternal: browser.openExternal,
        fetchImpl: workspace.fetchImpl,
      }),
    ).rejects.toThrow("Sign in with your dbc-1.cloud.databricks.com account.");
    expect(workspace.calls.map((url) => url.pathname)).toEqual(["/oidc/v1/authorize"]);
  });

  it("points to the Databricks CLI without opening a browser when the workspace lacks the client", async () => {
    const openExternal = vi.fn(async () => true);
    const workspace = fakeWorkspace(() => json(400, { error: "invalid_client" }));
    await expect(
      signInWithDatabricks(WORKSPACE, { openExternal, fetchImpl: workspace.fetchImpl }),
    ).rejects.toThrow(`databricks auth login --host ${WORKSPACE}`);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("reports an unreachable workspace as a network problem", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(
      signInWithDatabricks(WORKSPACE, { openExternal: async () => true, fetchImpl }),
    ).rejects.toThrow("Couldn't reach dbc-1.cloud.databricks.com");
  });
});

describe("refreshDatabricksGrant", () => {
  it("returns the new token, keeping the grant unless the workspace rotated it", async () => {
    const rotated = fakeWorkspace((_url, body) => {
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("grant");
      expect(body.get("client_id")).toBe("omnigent");
      return json(200, { access_token: "new", refresh_token: "grant-2", expires_in: 60 });
    });
    expect(await refreshDatabricksGrant(WORKSPACE, "grant", rotated.fetchImpl, () => 0)).toEqual({
      status: "refreshed",
      session: { token: "new", refreshToken: "grant-2", expiresAt: 60_000 },
    });
    const kept = fakeWorkspace(() => json(200, { access_token: "new" }));
    expect(await refreshDatabricksGrant(WORKSPACE, "grant", kept.fetchImpl)).toEqual({
      status: "refreshed",
      session: { token: "new", refreshToken: "grant" },
    });
  });

  it("tells a dead grant from a transient failure", async () => {
    const answer = (status: number) =>
      refreshDatabricksGrant(
        WORKSPACE,
        "grant",
        fakeWorkspace(() => json(status, { error: "x" })).fetchImpl,
      );
    expect(await answer(400)).toEqual({ status: "rejected" });
    expect(await answer(401)).toEqual({ status: "rejected" });
    expect(await answer(503)).toEqual({ status: "failed" });
    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await refreshDatabricksGrant(WORKSPACE, "grant", offline)).toEqual({
      status: "failed",
    });
  });
});
