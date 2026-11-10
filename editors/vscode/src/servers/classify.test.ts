import { describe, expect, it, vi } from "vitest";
import {
  probeServer,
  profileFromIdentityProbe,
  profileFromManifest,
  remoteServerKind,
} from "./classify";

const SERVER = "https://omnigent.example.com";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("remoteServerKind", () => {
  it.each([
    ["https://omnigent.example.com", "self-hosted"],
    ["https://my-app-1.aws.databricksapps.com", "databricks-app"],
    ["https://dbc-abc.cloud.databricks.com/omnigent", "databricks-workspace"],
  ])("%s is %s", (url, kind) => {
    expect(remoteServerKind(url)).toBe(kind);
  });
});

describe("profileFromManifest", () => {
  it("reads the auth block, keeping only the named session cookie", () => {
    expect(
      profileFromManifest(
        200,
        {
          manifest_version: 1,
          server_name: "Team",
          auth: { mode: "oidc", session_cookie: "__Host-ap_session" },
        },
        SERVER,
      ),
    ).toEqual({
      authMode: "oidc",
      sessionCookies: ["__Host-ap_session"],
      nativeSignIn: true,
      serverName: "Team",
    });
  });

  it("falls back to the known cookie names when the manifest omits one", () => {
    expect(
      profileFromManifest(200, { manifest_version: 1, auth: { mode: "accounts" } }, SERVER)
        ?.sessionCookies,
    ).toEqual(["__Host-ap_session", "ap_session"]);
  });

  it("returns null without a trusted auth block", () => {
    expect(profileFromManifest(200, { manifest_version: 1 }, SERVER)).toBeNull();
    expect(
      profileFromManifest(200, { manifest_version: 1, auth: { mode: "magic" } }, SERVER),
    ).toBeNull();
    expect(profileFromManifest(404, null, SERVER)).toBeNull();
  });
});

describe("profileFromIdentityProbe", () => {
  it.each([
    [401, { user_id: null, login_url: "/auth/login" }, "oidc"],
    [401, { user_id: null, login_url: "/login" }, "accounts"],
    [302, null, "header"],
    [200, { user_id: null }, "header"],
    [200, { user_id: "local" }, "none"],
  ])("%i %j is %s", (status, body, mode) => {
    expect(profileFromIdentityProbe(status, body, SERVER)?.authMode).toBe(mode);
  });

  it("returns null for answers that aren't an Omnigent server's", () => {
    expect(profileFromIdentityProbe(401, { detail: "no" }, SERVER)).toBeNull();
    expect(profileFromIdentityProbe(200, null, SERVER)).toBeNull();
  });
});

describe("probeServer", () => {
  it("falls back to /v1/me when the manifest has no auth block", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith("/.well-known/omnigent.json")
        ? json(200, { manifest_version: 1 })
        : json(401, { user_id: null, login_url: "/login" }),
    ) as unknown as typeof fetch;
    const result = await probeServer(`${SERVER}/team`, fetchImpl);
    expect(result).toMatchObject({ status: "ok", profile: { authMode: "accounts" } });
    expect(vi.mocked(fetchImpl).mock.calls.map(([url]) => String(url))).toEqual([
      `${SERVER}/team/.well-known/omnigent.json`,
      `${SERVER}/team/v1/me`,
    ]);
  });

  it("reports unreachable servers and non-Omnigent answers", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await probeServer(SERVER, down)).toMatchObject({ status: "unreachable" });
    const other = vi.fn(
      async () => new Response("<html>", { status: 404 }),
    ) as unknown as typeof fetch;
    expect(await probeServer(SERVER, other)).toEqual({ status: "not-omnigent" });
  });
});
