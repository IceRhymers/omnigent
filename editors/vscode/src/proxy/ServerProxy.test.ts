/**
 * ServerProxy against a real loopback "remote" server: admission checks,
 * header rewriting, cookie capture, HTML rebasing, streaming, the OIDC
 * sign-in intercepts, Databricks Apps token refusals, control endpoints, and
 * WebSocket tunnelling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as http from "node:http";
import * as zlib from "node:zlib";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { ProxyCredentials, SignInStatus } from "../auth/credentials";
import { LocalApp } from "./localApp";
import {
  CONTROL_PATH,
  ServerProxy,
  databricksTokenRejection,
  isNavigation,
  sessionCookieEvents,
  type ProxyAuthMode,
} from "./ServerProxy";
import type { SignInPrompt } from "./pages";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
type UpgradeHandler = (req: http.IncomingMessage, socket: Duplex) => void;

interface Upstream {
  url: string;
  received: http.IncomingMessage[];
  setHandler(handler: Handler): void;
  setUpgradeHandler(handler: UpgradeHandler): void;
  close(): Promise<void>;
}

async function startUpstream(): Promise<Upstream> {
  const received: http.IncomingMessage[] = [];
  let handler: Handler = (_req, res) =>
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
  let upgradeHandler: UpgradeHandler = (_req, socket) => socket.destroy();
  const sockets = new Set<Duplex>();
  const server = http.createServer((req, res) => {
    received.push(req);
    handler(req, res);
  });
  server.on("upgrade", (req: http.IncomingMessage, socket: Duplex) => {
    received.push(req);
    sockets.add(socket);
    upgradeHandler(req, socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    setHandler: (next) => (handler = next),
    setUpgradeHandler: (next) => (upgradeHandler = next),
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function fakeCredentials(token?: string) {
  let status: SignInStatus = { generation: 0, inProgress: false };
  const credentials = {
    bearerToken: vi.fn(async () => token),
    acceptSessionCookie: vi.fn(),
    sessionCookieCleared: vi.fn(),
    tokenRejected: vi.fn(),
    startSignIn: vi.fn(() => {
      status = { ...status, inProgress: true };
    }),
    signOut: vi.fn(async () => undefined),
    status: vi.fn(() => status),
  } satisfies ProxyCredentials;
  return credentials;
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  text: string;
}

function send(
  proxy: ServerProxy,
  path: string,
  options: { method?: string; headers?: http.OutgoingHttpHeaders; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${proxy.origin}${path}`, {
      method: options.method ?? "GET",
      headers: options.headers,
      agent: false,
    });
    req.on("error", reject);
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text: body.toString() });
      });
    });
    req.end(options.body);
  });
}

const NAVIGATE = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" };

let upstream: Upstream;
let proxy: ServerProxy | undefined;
let credentials: ReturnType<typeof fakeCredentials>;
const openExternal = vi.fn(async () => true);

async function startProxy(
  overrides: {
    path?: string;
    authMode?: ProxyAuthMode;
    token?: string;
    signInPrompt?: SignInPrompt;
    localApp?: LocalApp;
  } = {},
) {
  credentials = fakeCredentials(overrides.token);
  proxy = await ServerProxy.start({
    serverUrl: upstream.url + (overrides.path ?? ""),
    authMode: overrides.authMode ?? "accounts",
    sessionCookies: ["ap_session"],
    credentials,
    openExternal,
    signInPrompt: overrides.signInPrompt,
    localApp: overrides.localApp,
  });
  return proxy;
}

beforeEach(async () => {
  upstream = await startUpstream();
  openExternal.mockClear();
});

afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
  await upstream.close();
});

describe("ServerProxy admission", () => {
  it("refuses a foreign Host, a foreign Origin, or a missing secret without contacting the server", async () => {
    const p = await startProxy({ token: "t" });
    expect((await send(p, `${p.prefix}/`, { headers: { host: "evil.example" } })).status).toBe(403);
    expect(
      (await send(p, `${p.prefix}/`, { headers: { origin: "https://evil.example" } })).status,
    ).toBe(403);
    expect((await send(p, "/v1/sessions")).status).toBe(404);
    expect((await send(p, `${p.prefix}x/v1/sessions`)).status).toBe(404);
    expect(upstream.received).toHaveLength(0);
  });

  it("serves only under a fresh random prefix", async () => {
    const first = await startProxy();
    const second = await ServerProxy.start({
      serverUrl: upstream.url,
      authMode: "none",
      sessionCookies: [],
      credentials: fakeCredentials(),
      openExternal,
    });
    try {
      expect(first.prefix).toMatch(/^\/[A-Za-z0-9_-]{43}$/);
      expect(second.prefix).not.toBe(first.prefix);
      expect(first.entryUrl).toBe(`${first.origin}${first.prefix}/`);
    } finally {
      await second.close();
    }
  });
});

describe("ServerProxy forwarding", () => {
  it("maps the path, adds the bearer, and replaces browser-only headers", async () => {
    const p = await startProxy({ token: "tok-1" });
    await send(p, `${p.prefix}/v1/sessions?limit=5`, {
      headers: {
        origin: p.origin,
        referer: `${p.origin}${p.prefix}/c/1?x=2`,
        cookie: "ap_session=from-browser",
        authorization: "Bearer from-browser",
        "x-forwarded-for": "1.2.3.4",
        "accept-encoding": "gzip, zstd",
      },
    });
    const seen = upstream.received[0];
    expect(seen.url).toBe("/v1/sessions?limit=5");
    expect(seen.headers.host).toBe(new URL(upstream.url).host);
    expect(seen.headers.authorization).toBe("Bearer tok-1");
    expect(seen.headers.origin).toBe(upstream.url);
    expect(seen.headers.referer).toBe(`${upstream.url}/c/1?x=2`);
    expect(seen.headers.cookie).toBeUndefined();
    expect(seen.headers["x-forwarded-for"]).toBeUndefined();
    expect(seen.headers["accept-encoding"]).toBe("gzip");
  });

  it("sends no Authorization when there is no credential, so the server's 401 passes through", async () => {
    upstream.setHandler((_req, res) =>
      res
        .writeHead(401, { "content-type": "application/json" })
        .end(JSON.stringify({ user_id: null, login_url: "/login" })),
    );
    const p = await startProxy();
    const reply = await send(p, `${p.prefix}/v1/me`);
    expect(upstream.received[0].headers.authorization).toBeUndefined();
    expect(reply.status).toBe(401);
    expect(JSON.parse(reply.text)).toEqual({ user_id: null, login_url: "/login" });
  });

  it("forwards request bodies", async () => {
    let body = "";
    upstream.setHandler((req, res) => {
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => res.writeHead(204).end());
    });
    const p = await startProxy({ token: "t" });
    const reply = await send(p, `${p.prefix}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: p.origin },
      body: '{"title":"hi"}',
    });
    expect(reply.status).toBe(204);
    expect(body).toBe('{"title":"hi"}');
  });

  it("keeps cookies out of the browser and reports session cookie sets and clears", async () => {
    upstream.setHandler((req, res) => {
      const cookie =
        req.url === "/login"
          ? "ap_session=new-token; Max-Age=28800; Path=/; HttpOnly; SameSite=lax"
          : 'ap_session=""; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/';
      res.writeHead(200, { "set-cookie": [cookie, "other=1; Path=/"] }).end();
    });
    const p = await startProxy();
    const login = await send(p, `${p.prefix}/login`, { method: "POST" });
    expect(login.headers["set-cookie"]).toBeUndefined();
    expect(credentials.acceptSessionCookie).toHaveBeenCalledWith("new-token", 28800);

    await send(p, `${p.prefix}/logout`, { method: "POST" });
    expect(credentials.sessionCookieCleared).toHaveBeenCalledTimes(1);
  });

  it("keeps same-server redirects inside the proxy and leaves other sites alone for scripts", async () => {
    upstream.setHandler((req, res) => {
      const location =
        req.url === "/old" ? `${upstream.url}/new?a=1` : "https://github.com/login/oauth/authorize";
      res.writeHead(302, { location }).end();
    });
    const p = await startProxy();
    expect((await send(p, `${p.prefix}/old`)).headers.location).toBe(`${p.prefix}/new?a=1`);
    expect((await send(p, `${p.prefix}/connect`)).headers.location).toBe(
      "https://github.com/login/oauth/authorize",
    );
  });

  it("answers a navigation that leaves the server with the continue-in-browser page", async () => {
    upstream.setHandler((_req, res) =>
      res.writeHead(302, { location: "https://github.com/login/oauth/authorize?x=1" }).end(),
    );
    const p = await startProxy();
    const reply = await send(p, `${p.prefix}/v1/integrations/github/connect?next=%2F`, {
      headers: NAVIGATE,
    });
    expect(reply.status).toBe(200);
    expect(reply.text).toContain("Continue in your browser");
    expect(reply.text).toContain('"path":"/v1/integrations/github/connect?next=%2F"');
    expect(reply.text).not.toContain("github.com");
    expect(reply.headers["content-security-policy"]).toContain("script-src 'nonce-");
  });

  it("drops headers that block framing on a loopback origin, keeping the rest of the CSP", async () => {
    upstream.setHandler((_req, res) =>
      res
        .writeHead(200, {
          "content-type": "application/json",
          "x-frame-options": "DENY",
          "strict-transport-security": "max-age=63072000",
          "content-security-policy":
            "default-src 'self'; frame-ancestors 'none'; upgrade-insecure-requests; img-src *",
          "x-request-id": "r1",
        })
        .end("{}"),
    );
    const p = await startProxy();
    const reply = await send(p, `${p.prefix}/v1/me`);
    expect(reply.headers["x-frame-options"]).toBeUndefined();
    expect(reply.headers["strict-transport-security"]).toBeUndefined();
    expect(reply.headers["content-security-policy"]).toBe("default-src 'self'; img-src *");
    expect(reply.headers["x-request-id"]).toBe("r1");
  });

  it("rebases a compressed index.html under the prefix and stops it being cached", async () => {
    const index =
      '<html><head><script>window.__OMNIGENT_BASE_PATH__ = "/team";</script>' +
      '<script type="module" src="/team/assets/app.js"></script></head></html>';
    upstream.setHandler((_req, res) =>
      res
        .writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-encoding": "gzip",
          etag: '"abc"',
          "cache-control": "max-age=60",
        })
        .end(zlib.gzipSync(index)),
    );
    const p = await startProxy({ path: "/team" });
    const reply = await send(p, `${p.prefix}/team/`, {
      headers: { ...NAVIGATE, "accept-encoding": "gzip" },
    });
    expect(upstream.received[0].url).toBe("/team/");
    expect(reply.headers["content-encoding"]).toBeUndefined();
    expect(reply.headers.etag).toBeUndefined();
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(Number(reply.headers["content-length"])).toBe(reply.body.length);
    expect(reply.text).toContain(`window.__OMNIGENT_BASE_PATH__ = "${p.prefix}/team"`);
    expect(reply.text).toContain(`src="${p.prefix}/team/assets/app.js"`);
  });

  it("streams server-sent events without waiting for the response to end", async () => {
    let finish: () => void = () => undefined;
    upstream.setHandler((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      finish = () => res.end("data: last\n\n");
    });
    const p = await startProxy({ token: "t" });
    const first = await new Promise<string>((resolve, reject) => {
      const req = http.get(`${p.origin}${p.prefix}/v1/events`, { agent: false }, (res) => {
        res.once("data", (chunk: Buffer) => {
          resolve(chunk.toString());
          res.resume();
        });
      });
      req.on("error", reject);
    });
    expect(first).toBe("data: first\n\n");
    finish();
  });

  it("closes open streams on close()", async () => {
    const upstreamClosed = new Promise<void>((resolve) => {
      upstream.setHandler((req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: open\n\n");
        req.socket.on("close", () => resolve());
      });
    });
    const p = await startProxy({ token: "t" });
    const clientClosed = new Promise<void>((resolve) => {
      http.get(`${p.origin}${p.prefix}/v1/events`, { agent: false }, (res) => {
        res.on("data", () => undefined);
        res.on("close", () => resolve());
      });
    });
    await vi.waitFor(() => expect(upstream.received).toHaveLength(1));
    await p.close();
    await Promise.all([clientClosed, upstreamClosed]);
  });

  it("answers an unreachable server with an error page for navigations and a bare 502 otherwise", async () => {
    const p = await startProxy();
    await upstream.close();
    const page = await send(p, `${p.prefix}/`, { headers: NAVIGATE });
    expect(page.status).toBe(502);
    expect(page.text).toContain("Couldn&#39;t reach 127.0.0.1:");
    const fetchReply = await send(p, `${p.prefix}/v1/me`);
    expect(fetchReply.status).toBe(502);
    expect(fetchReply.headers["content-type"]).toBe("text/plain");
    // Restart something on a fresh port so afterEach can close it.
    upstream = await startUpstream();
  });
});

describe("ServerProxy OIDC sign-in", () => {
  it("serves its own sign-in page for /auth/login, returning only to safe paths", async () => {
    const p = await startProxy({ path: "/team", authMode: "oidc" });
    const returnTo = async (value: string) => {
      const reply = await send(
        p,
        `${p.prefix}/team/auth/login?${new URLSearchParams({ return_to: value })}`,
        { headers: NAVIGATE },
      );
      expect(reply.status).toBe(200);
      expect(reply.text).toContain("Sign in with browser");
      return /"returnTo":"([^"]*)"/.exec(reply.text)?.[1];
    };
    expect(await returnTo(`${p.prefix}/team/c/42?tab=1`)).toBe(`${p.prefix}/team/c/42?tab=1`);
    expect(await returnTo("/team/c/42")).toBe(`${p.prefix}/team/c/42`);
    expect(await returnTo("//evil.example/x")).toBe(`${p.prefix}/team/`);
    expect(await returnTo("https://evil.example/x")).toBe(`${p.prefix}/team/`);
    expect(await returnTo(`${p.prefix}/team/auth/logout`)).toBe(`${p.prefix}/team/`);
    expect(upstream.received).toHaveLength(0);
  });

  it("signs out on /auth/logout and lands on the signed-out page", async () => {
    const p = await startProxy({ path: "/team", authMode: "oidc", token: "t" });
    const reply = await send(p, `${p.prefix}/team/auth/logout`, { headers: NAVIGATE });
    expect(credentials.signOut).toHaveBeenCalledTimes(1);
    expect(reply.status).toBe(302);
    expect(reply.headers.location).toBe(`${p.prefix}/team/auth/login?signed_out=1`);
    const page = await send(p, reply.headers.location as string, { headers: NAVIGATE });
    expect(page.text).toContain("You&#39;re signed out");
    expect(upstream.received).toHaveLength(0);
  });

  it("forwards the auth routes in accounts mode", async () => {
    const p = await startProxy({ authMode: "accounts" });
    await send(p, `${p.prefix}/auth/login`);
    expect(upstream.received[0].url).toBe("/auth/login");
  });
});

describe("ServerProxy Databricks Apps", () => {
  const WORKSPACE_SIGN_IN = "https://dbc-1.cloud.databricks.com/oidc/oauth2/v2.0/authorize?x=1";
  const returnToOf = (html: string) => /"returnTo":"([^"]*)"/.exec(html)?.[1];

  it("asks for a sign-in without a token instead of contacting the app", async () => {
    const p = await startProxy({ authMode: "databricks-app" });
    const page = await send(p, `${p.prefix}/c/42?tab=1`, { headers: NAVIGATE });
    expect(page.status).toBe(200);
    expect(page.text).toContain("Sign in to continue");
    expect(returnToOf(page.text)).toBe(`${p.prefix}/c/42?tab=1`);
    const api = await send(p, `${p.prefix}/v1/me`);
    expect(api.status).toBe(401);
    expect(JSON.parse(api.text)).toMatchObject({ user_id: null, login_url: "/auth/login" });
    expect(upstream.received).toHaveLength(0);
  });

  it("serves the sign-in page at /auth/login with its prompt, and forwards /auth/logout", async () => {
    const p = await startProxy({
      authMode: "databricks-app",
      token: "t",
      signInPrompt: { detail: "Use your Databricks account.", button: "Sign in with Databricks" },
    });
    const page = await send(
      p,
      `${p.prefix}/auth/login?${new URLSearchParams({ return_to: `${p.prefix}/c/1` })}`,
      { headers: NAVIGATE },
    );
    expect(page.text).toContain("Use your Databricks account.");
    expect(page.text).toContain("Sign in with Databricks");
    expect(returnToOf(page.text)).toBe(`${p.prefix}/c/1`);
    expect(upstream.received).toHaveLength(0);
    await send(p, `${p.prefix}/auth/logout`, { headers: NAVIGATE });
    expect(upstream.received[0].url).toBe("/auth/logout");
    expect(credentials.signOut).not.toHaveBeenCalled();
  });

  it("retries once with a fresh token when the edge sends a request to the workspace sign-in", async () => {
    upstream.setHandler((req, res) => {
      if (req.headers.authorization === "Bearer stale") {
        res.writeHead(302, { location: WORKSPACE_SIGN_IN }).end();
      } else {
        res.writeHead(200, { "content-type": "text/plain" }).end("app");
      }
    });
    const p = await startProxy({ authMode: "databricks-app", token: "fresh" });
    credentials.bearerToken.mockResolvedValueOnce("stale");
    const reply = await send(p, `${p.prefix}/v1/sessions`);
    expect(reply.status).toBe(200);
    expect(reply.text).toBe("app");
    expect(credentials.tokenRejected).toHaveBeenCalledWith("stale", "sign-in");
    expect(upstream.received.map((req) => req.headers.authorization)).toEqual([
      "Bearer stale",
      "Bearer fresh",
    ]);
  });

  it("asks for a sign-in when the fresh token is refused too", async () => {
    upstream.setHandler((_req, res) => res.writeHead(401, { "content-type": "text/plain" }).end());
    const p = await startProxy({ authMode: "databricks-app", token: "dead" });
    const page = await send(p, `${p.prefix}/`, { headers: NAVIGATE });
    expect(page.status).toBe(200);
    expect(page.text).toContain("Sign in to continue");
    const api = await send(p, `${p.prefix}/v1/me`);
    expect(api.status).toBe(401);
    expect(JSON.parse(api.text)).toMatchObject({ login_url: "/auth/login" });
    expect(upstream.received).toHaveLength(4);
    expect(credentials.tokenRejected).toHaveBeenCalledTimes(4);
  });

  it("relays the edge's 403 after one retry, since it can mean the user lacks access", async () => {
    upstream.setHandler((_req, res) =>
      res.writeHead(403, { "content-type": "text/html" }).end("<p>no access</p>"),
    );
    const p = await startProxy({ authMode: "databricks-app", token: "valid" });
    const reply = await send(p, `${p.prefix}/`, { headers: NAVIGATE });
    expect(reply.status).toBe(403);
    expect(reply.text).toContain("no access");
    expect(upstream.received).toHaveLength(2);
    expect(credentials.tokenRejected).toHaveBeenCalledWith("valid", "forbidden");
  });

  it("passes the app's own JSON 403s and redirects through untouched", async () => {
    upstream.setHandler((req, res) => {
      if (req.url === "/v1/sessions/x") {
        res.writeHead(403, { "content-type": "application/json" }).end('{"detail":"not yours"}');
      } else {
        res.writeHead(302, { location: "/c/1" }).end();
      }
    });
    const p = await startProxy({ authMode: "databricks-app", token: "t" });
    expect((await send(p, `${p.prefix}/v1/sessions/x`)).status).toBe(403);
    const moved = await send(p, `${p.prefix}/old`, { headers: NAVIGATE });
    expect(moved.status).toBe(302);
    expect(moved.headers.location).toBe(`${p.prefix}/c/1`);
    expect(upstream.received).toHaveLength(2);
    expect(credentials.tokenRejected).not.toHaveBeenCalled();
  });

  it("doesn't resend a request body; the app gets a 401 that leads to the sign-in", async () => {
    upstream.setHandler((req, res) => {
      req.resume();
      res.writeHead(302, { location: WORKSPACE_SIGN_IN }).end();
    });
    const p = await startProxy({ authMode: "databricks-app", token: "t" });
    const reply = await send(p, `${p.prefix}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: p.origin },
      body: "{}",
    });
    expect(reply.status).toBe(401);
    expect(JSON.parse(reply.text)).toMatchObject({ login_url: "/auth/login" });
    expect(upstream.received).toHaveLength(1);
    expect(credentials.tokenRejected).toHaveBeenCalledWith("t", "sign-in");
  });
});

describe("ServerProxy Databricks workspace", () => {
  const API = "/api/2.0/omnigent";
  const INDEX =
    '<html><head><base href="/" /><script type="module" src="./assets/app-1.js"></script>' +
    "</head><body></body></html>";
  let appDir: string;
  let app: LocalApp;

  beforeEach(async () => {
    appDir = await mkdtemp(join(tmpdir(), "omnigent-proxy-app-"));
    await mkdir(join(appDir, "assets"));
    await writeFile(join(appDir, "index.html"), INDEX);
    await writeFile(join(appDir, "assets", "app-1.js"), "console.log(1);");
    await writeFile(join(appDir, "favicon.svg"), "<svg/>");
    app = (await LocalApp.load(appDir)) as LocalApp;
  });

  afterEach(async () => {
    await rm(appDir, { recursive: true, force: true });
  });

  const startWorkspace = (token?: string) =>
    startProxy({ path: API, authMode: "databricks-workspace", token, localApp: app });

  it("serves the bundled app shell under the API mount, rebased, for any page load", async () => {
    const p = await startWorkspace("t");
    expect(p.entryUrl).toBe(`${p.origin}${p.prefix}${API}/`);
    for (const page of [`${p.prefix}${API}/`, `${p.prefix}${API}/c/42?tab=1`]) {
      const reply = await send(p, page, { headers: NAVIGATE });
      expect(reply.status).toBe(200);
      expect(reply.headers["cache-control"]).toBe("no-store");
      expect(reply.text).toContain(`window.__OMNIGENT_BASE_PATH__ = "${p.prefix}${API}"`);
      expect(reply.text).toContain(`src="${p.prefix}${API}/assets/app-1.js"`);
      expect(reply.text).not.toContain("<base");
    }
    expect(upstream.received).toHaveLength(0);
  });

  it("serves bundle files, and 404s anything else that isn't the server's", async () => {
    const p = await startWorkspace("t");
    const asset = await send(p, `${p.prefix}${API}/assets/app-1.js`);
    expect(asset.status).toBe(200);
    expect(asset.text).toBe("console.log(1);");
    expect(asset.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(asset.headers["cache-control"]).toContain("immutable");
    const icon = await send(p, `${p.prefix}${API}/favicon.svg`, { method: "HEAD" });
    expect(icon.status).toBe(200);
    expect(icon.headers["content-length"]).toBe("6");
    expect(icon.headers["cache-control"]).toBe("no-cache");
    expect((await send(p, `${p.prefix}${API}/assets/gone.js`)).status).toBe(404);
    expect((await send(p, `${p.prefix}${API}/c/42`)).status).toBe(404);
    expect((await send(p, `${p.prefix}${API}/c/42`, { method: "POST" })).status).toBe(404);
    expect(upstream.received).toHaveLength(0);
  });

  it("sends only the API mount to the workspace, with the token", async () => {
    const p = await startWorkspace("ws-token");
    await send(p, `${p.prefix}${API}/v1/me`, { headers: { origin: p.origin } });
    const seen = upstream.received[0];
    expect(seen.url).toBe(`${API}/v1/me`);
    expect(seen.headers.authorization).toBe("Bearer ws-token");
    expect(seen.headers.origin).toBe(upstream.url);

    const outside = await send(p, `${p.prefix}/api/2.0/clusters/list`);
    expect(outside.status).toBe(404);
    const home = await send(p, `${p.prefix}/`, { headers: NAVIGATE });
    expect(home.status).toBe(302);
    expect(home.headers.location).toBe(`${p.prefix}${API}/`);
    expect(upstream.received).toHaveLength(1);
  });

  it("asks for a sign-in without a token, before the app loads", async () => {
    const p = await startWorkspace();
    const page = await send(p, `${p.prefix}${API}/c/42`, { headers: NAVIGATE });
    expect(page.status).toBe(200);
    expect(page.text).toContain("Sign in to continue");
    expect(/"returnTo":"([^"]*)"/.exec(page.text)?.[1]).toBe(`${p.prefix}${API}/c/42`);
    const api = await send(p, `${p.prefix}${API}/v1/me`);
    expect(api.status).toBe(401);
    expect(JSON.parse(api.text)).toMatchObject({ login_url: "/auth/login" });
    // Assets don't need a sign-in, so the sign-in page itself can load them.
    expect((await send(p, `${p.prefix}${API}/favicon.svg`)).status).toBe(200);
    expect(upstream.received).toHaveLength(0);
  });

  it("retries once with a fresh token when the workspace refuses one", async () => {
    upstream.setHandler((req, res) => {
      if (req.headers.authorization === "Bearer stale") {
        res
          .writeHead(401, { "www-authenticate": 'Bearer realm="DatabricksRealm"' })
          .end("Unauthorized");
      } else {
        res.writeHead(200, { "content-type": "application/json" }).end('{"user_id":"me"}');
      }
    });
    const p = await startWorkspace("fresh");
    credentials.bearerToken.mockResolvedValueOnce("stale");
    const reply = await send(p, `${p.prefix}${API}/v1/me`);
    expect(reply.status).toBe(200);
    expect(credentials.tokenRejected).toHaveBeenCalledWith("stale", "sign-in");
    expect(upstream.received.map((req) => req.headers.authorization)).toEqual([
      "Bearer stale",
      "Bearer fresh",
    ]);
  });

  it("serves the sign-in page and signs out locally", async () => {
    const p = await startWorkspace("t");
    const login = await send(p, `${p.prefix}${API}/auth/login`, { headers: NAVIGATE });
    expect(login.text).toContain("Sign in to continue");
    const logout = await send(p, `${p.prefix}${API}/auth/logout`, { headers: NAVIGATE });
    expect(credentials.signOut).toHaveBeenCalledTimes(1);
    expect(logout.status).toBe(302);
    expect(logout.headers.location).toBe(`${p.prefix}${API}/auth/login?signed_out=1`);
    expect(upstream.received).toHaveLength(0);
  });

  it("tunnels the API's WebSockets and refuses any other upgrade", async () => {
    upstream.setUpgradeHandler((_req, socket) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
    });
    const p = await startWorkspace("ws-token");
    const tunnel = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request(`${p.origin}${p.prefix}${API}/v1/sessions/s1/updates`, {
        agent: false,
        headers: { connection: "Upgrade", upgrade: "websocket", origin: p.origin },
      });
      req.on("error", reject);
      req.on("upgrade", (res, socket) => {
        socket.destroy();
        resolve(res);
      });
      req.on("response", resolve);
      req.end();
    });
    expect(tunnel.statusCode).toBe(101);
    expect(upstream.received[0].url).toBe(`${API}/v1/sessions/s1/updates`);
    expect(upstream.received[0].headers.authorization).toBe("Bearer ws-token");

    const refused = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request(`${p.origin}${p.prefix}${API}/c/1`, {
        agent: false,
        headers: { connection: "Upgrade", upgrade: "websocket" },
      });
      req.on("error", reject);
      req.on("response", resolve);
      req.end();
    });
    expect(refused.statusCode).toBe(404);
    expect(upstream.received).toHaveLength(1);
  });
});

describe("databricksTokenRejection", () => {
  it("reads 401s and redirects into the workspace sign-in as dead tokens", () => {
    expect(databricksTokenRejection(401, {}, false)).toBe("sign-in");
    const oidc = "https://dbc-1.cloud.databricks.com/oidc/oauth2/v2.0/authorize?x=1";
    expect(databricksTokenRejection(302, { location: oidc }, true)).toBe("sign-in");
    expect(databricksTokenRejection(307, { location: "/.auth/callback" }, false)).toBe("sign-in");
    expect(databricksTokenRejection(302, { location: "/c/1" }, true)).toBeUndefined();
    expect(databricksTokenRejection(200, {}, true)).toBeUndefined();
  });

  it("reads the edge's 403s as forbidden, but not the app's JSON 403s to its own requests", () => {
    expect(databricksTokenRejection(403, { "content-type": "text/plain" }, false)).toBe(
      "forbidden",
    );
    expect(databricksTokenRejection(403, { "content-type": "application/json" }, true)).toBe(
      "forbidden",
    );
    expect(
      databricksTokenRejection(403, { "content-type": "application/json" }, false),
    ).toBeUndefined();
  });
});

describe("ServerProxy control endpoints", () => {
  it("reports sign-in status and starts a sign-in", async () => {
    const p = await startProxy({ authMode: "oidc" });
    const control = `${p.prefix}${CONTROL_PATH}`;
    expect(JSON.parse((await send(p, `${control}/status`)).text)).toEqual({
      generation: 0,
      inProgress: false,
    });
    const started = await send(p, `${control}/sign-in`, {
      method: "POST",
      headers: { origin: p.origin },
    });
    expect(started.status).toBe(204);
    expect(credentials.startSignIn).toHaveBeenCalledTimes(1);
    expect((await send(p, `${control}/sign-in`)).status).toBe(404);
  });

  it("opens only same-server paths in the browser", async () => {
    const p = await startProxy();
    const open = (path: unknown) =>
      send(p, `${p.prefix}${CONTROL_PATH}/open-in-browser`, {
        method: "POST",
        headers: { origin: p.origin, "content-type": "application/json" },
        body: JSON.stringify({ path }),
      });
    expect((await open("/v1/integrations/github/connect")).status).toBe(204);
    expect(openExternal).toHaveBeenCalledWith(`${upstream.url}/v1/integrations/github/connect`);
    for (const bad of ["//evil.example", "https://evil.example", "/\\evil.example", 42]) {
      expect((await open(bad)).status).toBe(400);
    }
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it("refuses control calls from another origin", async () => {
    const p = await startProxy();
    const reply = await send(p, `${p.prefix}${CONTROL_PATH}/sign-in`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(reply.status).toBe(403);
    expect(credentials.startSignIn).not.toHaveBeenCalled();
  });
});

describe("ServerProxy WebSockets", () => {
  function upgrade(p: ServerProxy, path: string, headers: http.OutgoingHttpHeaders = {}) {
    return new Promise<
      | { kind: "upgraded"; res: http.IncomingMessage; socket: Duplex }
      | { kind: "refused"; res: http.IncomingMessage; body: string }
    >((resolve, reject) => {
      const req = http.request(`${p.origin}${path}`, {
        agent: false,
        headers: { connection: "Upgrade", upgrade: "websocket", ...headers },
      });
      req.on("error", reject);
      req.on("upgrade", (res, socket) => resolve({ kind: "upgraded", res, socket }));
      req.on("response", (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => resolve({ kind: "refused", res, body }));
      });
      req.end();
    });
  }

  it("tunnels an upgrade with the bearer and without the server's cookies", async () => {
    upstream.setUpgradeHandler((_req, socket) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          "Set-Cookie: ap_session=s; Path=/\r\nSec-WebSocket-Accept: abc\r\n\r\n",
      );
      socket.pipe(socket);
    });
    const p = await startProxy({ token: "ws-token" });
    const result = await upgrade(p, `${p.prefix}/v1/terminal?id=1`, { origin: p.origin });
    expect(result.kind).toBe("upgraded");
    if (result.kind !== "upgraded") return;
    expect(result.res.headers["sec-websocket-accept"]).toBe("abc");
    expect(result.res.headers["set-cookie"]).toBeUndefined();
    const seen = upstream.received[0];
    expect(seen.url).toBe("/v1/terminal?id=1");
    expect(seen.headers.authorization).toBe("Bearer ws-token");
    expect(seen.headers.origin).toBe(upstream.url);

    const echoed = new Promise<string>((resolve) =>
      result.socket.once("data", (chunk: Buffer) => resolve(chunk.toString())),
    );
    result.socket.write("ping");
    expect(await echoed).toBe("ping");
    result.socket.destroy();
  });

  it("relays a refused upgrade and closes", async () => {
    upstream.setUpgradeHandler((_req, socket) => {
      socket.end(
        "HTTP/1.1 403 Forbidden\r\nContent-Length: 6\r\nSet-Cookie: ap_session=s\r\n\r\ndenied",
      );
    });
    const p = await startProxy();
    const result = await upgrade(p, `${p.prefix}/v1/terminal`);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.res.statusCode).toBe(403);
    expect(result.res.headers["set-cookie"]).toBeUndefined();
    expect(result.body).toBe("denied");
  });

  it("refuses a Databricks App upgrade without a token before contacting the app", async () => {
    const p = await startProxy({ authMode: "databricks-app" });
    const result = await upgrade(p, `${p.prefix}/v1/terminal`, { origin: p.origin });
    expect(result.res.statusCode).toBe(401);
    expect(upstream.received).toHaveLength(0);
  });

  it("reports a Databricks App upgrade refused for its token, so the reconnect mints anew", async () => {
    upstream.setUpgradeHandler((_req, socket) => {
      socket.end(
        "HTTP/1.1 302 Found\r\nLocation: https://dbc-1.cloud.databricks.com/oidc/v1/authorize\r\n" +
          "Content-Length: 0\r\n\r\n",
      );
    });
    const p = await startProxy({ authMode: "databricks-app", token: "stale" });
    const result = await upgrade(p, `${p.prefix}/v1/terminal`, { origin: p.origin });
    expect(result.res.statusCode).toBe(302);
    expect(credentials.tokenRejected).toHaveBeenCalledWith("stale", "sign-in");
  });

  it("refuses an upgrade from another origin before contacting the server", async () => {
    const p = await startProxy();
    const result = await upgrade(p, `${p.prefix}/v1/terminal`, { origin: "https://evil.example" });
    expect(result.res.statusCode).toBe(403);
    expect(upstream.received).toHaveLength(0);
  });
});

describe("sessionCookieEvents", () => {
  const names = ["__Host-ap_session", "ap_session"];
  const now = Date.parse("2026-11-09T12:00:00Z");

  it("reads a set with its lifetime", () => {
    expect(sessionCookieEvents(["ap_session=abc; Max-Age=600; HttpOnly"], names, now)).toEqual([
      { type: "set", value: "abc", maxAgeSeconds: 600 },
    ]);
    expect(
      sessionCookieEvents(
        ['__Host-ap_session="q"; Expires=Mon, 09 Nov 2026 13:00:00 GMT; Secure'],
        names,
        now,
      ),
    ).toEqual([{ type: "set", value: "q", maxAgeSeconds: 3600 }]);
    expect(sessionCookieEvents(["ap_session=abc"], names, now)).toEqual([
      { type: "set", value: "abc", maxAgeSeconds: undefined },
    ]);
  });

  it("reads deletions as clears", () => {
    expect(
      sessionCookieEvents(
        [
          'ap_session=""; Max-Age=0; Path=/',
          "ap_session=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
          "ap_session=; Path=/",
        ],
        names,
        now,
      ),
    ).toEqual([{ type: "cleared" }, { type: "cleared" }, { type: "cleared" }]);
  });

  it("ignores other cookies", () => {
    expect(sessionCookieEvents(["ap_state=1", "ap_session_x=2", "junk"], names, now)).toEqual([]);
  });
});

describe("isNavigation", () => {
  it("trusts fetch metadata, then falls back to Accept", () => {
    expect(isNavigation({ "sec-fetch-mode": "navigate" })).toBe(true);
    expect(isNavigation({ "sec-fetch-mode": "cors", accept: "text/html" })).toBe(false);
    expect(isNavigation({ accept: "text/html,application/xhtml+xml" })).toBe(true);
    expect(isNavigation({ accept: "application/json" })).toBe(false);
  });
});
