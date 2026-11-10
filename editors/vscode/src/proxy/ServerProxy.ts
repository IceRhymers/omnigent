/**
 * Loopback proxy that lets the panel frame a remote Omnigent server.
 *
 * The panel's iframe is cross-site to the VS Code webview, so the browser
 * won't send the server's SameSite=Lax session cookie, and the server has no
 * CORS for a token-carrying SPA. Instead the iframe loads this proxy, which
 * forwards every request (HTTP, SSE, WebSocket) to the server with the user's
 * credential as `Authorization: Bearer`. Cookies never reach the browser.
 *
 * Only `http://127.0.0.1:<port>/<secret>/…` is served, where the secret is
 * random per launch, and requests must carry that exact Host and (when sent)
 * the proxy's own Origin, so other local pages and DNS rebinding can't use it.
 */
import * as crypto from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import * as zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { ProxyCredentials, TokenRejection } from "../auth/credentials";
import type { ServerAuthMode } from "../servers/classify";
import { rewriteIndexHtml } from "./indexRewrite";
import {
  continueInBrowserPage,
  errorPage,
  signInPage,
  type ProxyPage,
  type SignInPrompt,
} from "./pages";

/** The proxy's own endpoints, under the secret prefix. */
export const CONTROL_PATH = "/__omnigent_vscode";

const MAX_HTML_BYTES = 20 * 1024 * 1024;
const MAX_CONTROL_BODY_BYTES = 8 * 1024;
const DECODABLE_ENCODINGS = new Set(["gzip", "deflate", "br"]);

/** Headers that describe one connection, not the message (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Request headers the proxy sets itself or must not pass on. */
const REQUEST_HEADERS_REPLACED = new Set([
  "host",
  "cookie",
  "authorization",
  "origin",
  "referer",
  "accept-encoding",
  "forwarded",
]);

/** Response headers that don't apply to a loopback http origin inside VS Code. */
const RESPONSE_HEADERS_DROPPED = new Set([
  "set-cookie",
  "strict-transport-security",
  "alt-svc",
  "x-frame-options",
]);

/**
 * A self-hosted server's sign-in mode, or `databricks-app`: an app behind the
 * Databricks Apps edge, which takes a workspace token and refuses to forward
 * requests without one.
 */
export type ProxyAuthMode = ServerAuthMode | "databricks-app";

export interface ServerProxyOptions {
  /** Remote server URL: https origin plus optional mount path, no trailing slash. */
  serverUrl: string;
  authMode: ProxyAuthMode;
  /** Session cookie names to capture (and strip) from the server's responses. */
  sessionCookies: readonly string[];
  credentials: ProxyCredentials;
  openExternal(url: string): Promise<unknown>;
  /** Shown on the proxy's own pages. Defaults to the server's host. */
  serverLabel?: string;
  /** The sign-in page's wording; defaults to a browser sign-in. */
  signInPrompt?: SignInPrompt;
  log?(message: string): void;
}

export type SessionCookieEvent =
  { type: "set"; value: string; maxAgeSeconds?: number } | { type: "cleared" };

export class ServerProxy {
  private readonly server: http.Server;
  private readonly remote: URL;
  private readonly serverOrigin: string;
  private readonly serverBasePath: string;
  private readonly transport: typeof http | typeof https;
  private readonly secret = crypto.randomBytes(32).toString("base64url");
  private readonly tunnels = new Set<Duplex>();
  private readonly upstreams = new Set<http.ClientRequest>();
  private port = 0;
  private closed = false;

  private constructor(private readonly options: ServerProxyOptions) {
    this.remote = new URL(options.serverUrl);
    this.serverOrigin = this.remote.origin;
    this.serverBasePath = this.remote.pathname.replace(/\/+$/, "");
    this.transport = this.remote.protocol === "https:" ? https : http;
    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res).catch((error: unknown) => this.failRequest(res, error));
    });
    this.server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      void this.handleUpgrade(req, socket, head).catch((error: unknown) => {
        this.log(`websocket failed: ${describe(error)}`);
        socket.destroy();
      });
    });
    this.server.on("clientError", (_error, socket) => socket.destroy());
  }

  /** Listen on a random loopback port. */
  static async start(options: ServerProxyOptions): Promise<ServerProxy> {
    const proxy = new ServerProxy(options);
    await new Promise<void>((resolve, reject) => {
      proxy.server.once("error", reject);
      proxy.server.listen(0, "127.0.0.1", () => {
        proxy.server.off("error", reject);
        resolve();
      });
    });
    proxy.port = (proxy.server.address() as AddressInfo).port;
    return proxy;
  }

  /** `http://127.0.0.1:<port>`, the origin the panel frames. */
  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** `/<secret>`; every proxied URL starts with it. */
  get prefix(): string {
    return `/${this.secret}`;
  }

  /** The URL that opens the server's app in the panel. */
  get entryUrl(): string {
    return `${this.origin}${this.homePath}`;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const stopped = new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections();
    for (const socket of this.tunnels) {
      socket.destroy();
    }
    for (const upstream of this.upstreams) {
      upstream.destroy();
    }
    await stopped;
  }

  private get homePath(): string {
    return `${this.prefix}${this.serverBasePath}/`;
  }

  /** The request's server path (after the secret prefix), or an HTTP status to refuse with. */
  private admit(req: http.IncomingMessage): { path: string } | { refuse: 403 | 404 } {
    if (req.headers.host !== `127.0.0.1:${this.port}`) {
      return { refuse: 403 };
    }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== this.origin) {
      return { refuse: 403 };
    }
    const url = req.url ?? "";
    if (!url.startsWith(this.prefix)) {
      return { refuse: 404 };
    }
    const rest = url.slice(this.prefix.length);
    if (rest === "") {
      return { path: "/" };
    }
    if (rest.startsWith("?")) {
      return { path: `/${rest}` };
    }
    return rest.startsWith("/") ? { path: rest } : { refuse: 404 };
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const admitted = this.admit(req);
    if ("refuse" in admitted) {
      res.writeHead(admitted.refuse, { "content-type": "text/plain" }).end();
      req.resume();
      return;
    }
    const path = admitted.path;
    const url = new URL(path, "http://proxy.invalid");
    if (url.pathname.startsWith(`${CONTROL_PATH}/`)) {
      await this.handleControl(req, res, url.pathname.slice(CONTROL_PATH.length));
      return;
    }
    const appPath = this.appPathOf(url.pathname);
    const authMode = this.options.authMode;
    if ((authMode === "oidc" || authMode === "databricks-app") && req.method === "GET") {
      if (appPath === "/auth/login") {
        req.resume();
        this.sendPage(
          res,
          200,
          this.signInPageFor(url.searchParams.get("return_to"), url.searchParams.has("signed_out")),
        );
        return;
      }
      if (authMode === "oidc" && appPath === "/auth/logout") {
        req.resume();
        await this.options.credentials.signOut();
        res
          .writeHead(302, {
            location: `${this.prefix}${this.serverBasePath}/auth/login?signed_out=1`,
            "cache-control": "no-store",
          })
          .end();
        return;
      }
    }
    await this.forward(req, res, path);
  }

  private async handleControl(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: string,
  ): Promise<void> {
    const headers = { "cache-control": "no-store" };
    if (route === "/status" && req.method === "GET") {
      req.resume();
      res
        .writeHead(200, { ...headers, "content-type": "application/json" })
        .end(JSON.stringify(this.options.credentials.status()));
      return;
    }
    if (route === "/sign-in" && req.method === "POST") {
      req.resume();
      this.options.credentials.startSignIn();
      res.writeHead(204, headers).end();
      return;
    }
    if (route === "/open-in-browser" && req.method === "POST") {
      const body = await readSmallBody(req, MAX_CONTROL_BODY_BYTES);
      const target = typeof body?.path === "string" ? body.path : "";
      if (!isServerPath(target)) {
        res.writeHead(400, headers).end();
        return;
      }
      await this.options.openExternal(this.serverOrigin + target);
      res.writeHead(204, headers).end();
      return;
    }
    req.resume();
    res.writeHead(404, headers).end();
  }

  /** Send a request to the server; `replay` resends a bodiless one whose token was refused. */
  private async forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    path: string,
    replay = false,
  ): Promise<void> {
    const navigation = isNavigation(req.headers);
    const token = await this.options.credentials.bearerToken().catch(() => undefined);
    if (res.destroyed || this.closed) {
      return;
    }
    const databricksApp = this.options.authMode === "databricks-app";
    if (databricksApp && !token) {
      // The Apps edge would only redirect to a sign-in the panel can't show.
      req.resume();
      this.sendSignInRequired(res, path, navigation);
      return;
    }
    let superseded = false;
    let upstream: http.ClientRequest;
    try {
      upstream = this.upstreamRequest(
        req.method,
        path,
        this.upstreamHeaders(req.headers, token, false),
      );
    } catch (error) {
      req.resume();
      this.log(`invalid request path: ${describe(error)}`);
      res.writeHead(400, { "content-type": "text/plain" }).end();
      return;
    }
    this.upstreams.add(upstream);
    upstream.on("close", () => this.upstreams.delete(upstream));
    res.on("close", () => {
      if (!res.writableFinished) {
        upstream.destroy();
      }
    });
    upstream.on("error", (error) => {
      if (res.destroyed || superseded) {
        return;
      }
      this.log(`upstream error for ${req.method} ${redactQuery(path)}: ${describe(error)}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (navigation) {
        this.sendPage(
          res,
          502,
          errorPage(
            `Couldn't reach ${this.serverLabel}`,
            "Check your network connection, then reload the panel.",
            nonce(),
          ),
        );
      } else {
        res.writeHead(502, { "content-type": "text/plain" }).end();
      }
    });
    upstream.on("response", (upstreamRes) => {
      const rejection =
        databricksApp && token
          ? databricksTokenRejection(upstreamRes.statusCode ?? 502, upstreamRes.headers, navigation)
          : undefined;
      if (token && rejection) {
        this.options.credentials.tokenRejected(token, rejection);
        if (!replay && (req.method === "GET" || req.method === "HEAD")) {
          superseded = true;
          upstreamRes.resume();
          void this.forward(req, res, path, true).catch((error: unknown) =>
            this.failRequest(res, error),
          );
          return;
        }
        if (rejection === "sign-in") {
          upstreamRes.resume();
          this.sendSignInRequired(res, path, navigation);
          return;
        }
      }
      this.relayResponse(req, res, upstreamRes, path, navigation);
    });
    if (replay) {
      upstream.end();
    } else {
      req.pipe(upstream);
    }
  }

  /** A navigation gets the sign-in page; the app's own requests get a 401 that leads there. */
  private sendSignInRequired(res: http.ServerResponse, path: string, navigation: boolean): void {
    if (navigation) {
      this.sendPage(res, 200, this.signInPageFor(path, false));
      return;
    }
    res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" }).end(
      JSON.stringify({
        detail: "Sign in again from the Omnigent panel.",
        user_id: null,
        login_url: "/auth/login",
      }),
    );
  }

  private signInPageFor(returnTo: string | null, signedOut: boolean): ProxyPage {
    return signInPage({
      serverLabel: this.serverLabel,
      controlPath: this.prefix + CONTROL_PATH,
      returnTo: this.safeReturnTo(returnTo),
      generation: this.options.credentials.status().generation,
      signedOut,
      prompt: this.options.signInPrompt,
      nonce: nonce(),
    });
  }

  private failRequest(res: http.ServerResponse, error: unknown): void {
    this.log(`request failed: ${describe(error)}`);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain" }).end("Proxy error");
    } else {
      res.destroy();
    }
  }

  private relayResponse(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    upstreamRes: http.IncomingMessage,
    path: string,
    navigation: boolean,
  ): void {
    this.captureSessionCookies(upstreamRes.headers["set-cookie"]);
    const status = upstreamRes.statusCode ?? 502;
    const location = upstreamRes.headers.location;
    if (
      navigation &&
      status >= 300 &&
      status < 400 &&
      location &&
      this.isExternal(location, path)
    ) {
      upstreamRes.resume();
      this.sendPage(
        res,
        200,
        continueInBrowserPage({
          serverLabel: this.serverLabel,
          controlPath: this.prefix + CONTROL_PATH,
          path,
          homePath: this.homePath,
          nonce: nonce(),
        }),
      );
      return;
    }
    const headers = this.responseHeaders(upstreamRes.headers, path);
    const contentType = String(upstreamRes.headers["content-type"] ?? "").toLowerCase();
    if (req.method === "GET" && status === 200 && contentType.startsWith("text/html")) {
      this.relayRewrittenHtml(res, upstreamRes, headers);
      return;
    }
    res.writeHead(status, headers);
    if (contentType.startsWith("text/event-stream")) {
      res.socket?.setNoDelay(true);
      res.flushHeaders();
    }
    upstreamRes.pipe(res);
  }

  private relayRewrittenHtml(
    res: http.ServerResponse,
    upstreamRes: http.IncomingMessage,
    headers: http.OutgoingHttpHeaders,
  ): void {
    const encoding = String(upstreamRes.headers["content-encoding"] ?? "identity").toLowerCase();
    if (encoding !== "identity" && !DECODABLE_ENCODINGS.has(encoding)) {
      res.writeHead(200, headers);
      upstreamRes.pipe(res);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    upstreamRes.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_HTML_BYTES) {
        upstreamRes.destroy();
        res.destroy();
        return;
      }
      chunks.push(chunk);
    });
    upstreamRes.on("end", () => {
      let text: string;
      try {
        text = decodeBody(Buffer.concat(chunks), encoding).toString("utf8");
      } catch (error) {
        this.log(`couldn't decode HTML: ${describe(error)}`);
        res.writeHead(502, { "content-type": "text/plain" }).end();
        return;
      }
      const body = Buffer.from(rewriteIndexHtml(text, this.prefix, this.serverBasePath), "utf8");
      const rewritten = { ...headers };
      for (const name of ["content-encoding", "content-length", "etag", "last-modified"]) {
        delete rewritten[name];
      }
      rewritten["content-length"] = body.length;
      rewritten["cache-control"] = "no-store";
      res.writeHead(200, rewritten).end(body);
    });
    upstreamRes.on("error", () => res.destroy());
  }

  private async handleUpgrade(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    socket.on("error", () => socket.destroy());
    const admitted = this.admit(req);
    if ("refuse" in admitted) {
      const reason = admitted.refuse === 403 ? "Forbidden" : "Not Found";
      socket.end(`HTTP/1.1 ${admitted.refuse} ${reason}\r\nConnection: close\r\n\r\n`);
      return;
    }
    this.tunnels.add(socket);
    socket.on("close", () => this.tunnels.delete(socket));
    const token = await this.options.credentials.bearerToken().catch(() => undefined);
    if (socket.destroyed || this.closed) {
      socket.destroy();
      return;
    }
    const databricksApp = this.options.authMode === "databricks-app";
    if (databricksApp && !token) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    let upstream: http.ClientRequest;
    try {
      upstream = this.upstreamRequest(
        req.method,
        admitted.path,
        this.upstreamHeaders(req.headers, token, true),
      );
    } catch (error) {
      this.log(`invalid websocket path: ${describe(error)}`);
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    this.upstreams.add(upstream);
    upstream.on("close", () => this.upstreams.delete(upstream));
    socket.on("close", () => upstream.destroy());
    upstream.on("error", (error) => {
      this.log(`websocket upstream error: ${describe(error)}`);
      socket.destroy();
    });
    upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
      this.captureSessionCookies(upstreamRes.headers["set-cookie"]);
      this.tunnels.add(upstreamSocket);
      upstreamSocket.on("close", () => {
        this.tunnels.delete(upstreamSocket);
        socket.destroy();
      });
      upstreamSocket.on("error", () => upstreamSocket.destroy());
      socket.on("close", () => upstreamSocket.destroy());
      socket.write(statusLine(upstreamRes) + rawHeaderLines(upstreamRes.rawHeaders, true) + "\r\n");
      if (upstreamHead.length > 0) {
        socket.write(upstreamHead);
      }
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    upstream.on("response", (upstreamRes) => {
      // Refused upgrade: relay the answer and close, since the body framing was dropped.
      this.captureSessionCookies(upstreamRes.headers["set-cookie"]);
      const rejection =
        databricksApp && token
          ? databricksTokenRejection(upstreamRes.statusCode ?? 502, upstreamRes.headers, false)
          : undefined;
      if (token && rejection) {
        // The app reconnects on its own, by then with a fresh token.
        this.options.credentials.tokenRejected(token, rejection);
      }
      socket.write(
        statusLine(upstreamRes) +
          rawHeaderLines(upstreamRes.rawHeaders, false) +
          "Connection: close\r\n\r\n",
      );
      upstreamRes.pipe(socket);
    });
    upstream.end();
  }

  /** A request to the server. The default agent keeps VS Code's proxy and CA settings. */
  private upstreamRequest(
    method: string | undefined,
    path: string,
    headers: http.OutgoingHttpHeaders,
  ): http.ClientRequest {
    return this.transport.request({
      protocol: this.remote.protocol,
      hostname: this.remote.hostname.replace(/^\[(.*)\]$/, "$1"),
      port: this.remote.port || undefined,
      method,
      path,
      headers,
    });
  }

  private upstreamHeaders(
    incoming: http.IncomingHttpHeaders,
    token: string | undefined,
    upgrade: boolean,
  ): http.OutgoingHttpHeaders {
    const connectionTokens = String(incoming.connection ?? "")
      .toLowerCase()
      .split(",")
      .map((name) => name.trim());
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(incoming)) {
      if (
        value === undefined ||
        HOP_BY_HOP.has(name) ||
        REQUEST_HEADERS_REPLACED.has(name) ||
        connectionTokens.includes(name) ||
        name.startsWith("x-forwarded-")
      ) {
        continue;
      }
      headers[name] = value;
    }
    if (upgrade) {
      headers.connection = "Upgrade";
      headers.upgrade = incoming.upgrade;
    }
    if (incoming.origin !== undefined) {
      headers.origin = this.serverOrigin;
    }
    const referer = this.upstreamReferer(incoming.referer);
    if (referer) {
      headers.referer = referer;
    }
    const encodings = String(incoming["accept-encoding"] ?? "")
      .split(",")
      .map((entry) => entry.split(";")[0].trim().toLowerCase())
      .filter((entry) => DECODABLE_ENCODINGS.has(entry));
    if (encodings.length > 0) {
      headers["accept-encoding"] = encodings.join(", ");
    }
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }
    return headers;
  }

  private upstreamReferer(referer: string | undefined): string | undefined {
    if (!referer) {
      return undefined;
    }
    try {
      const url = new URL(referer);
      if (url.origin !== this.origin || !url.pathname.startsWith(`${this.prefix}/`)) {
        return undefined;
      }
      return `${this.serverOrigin}${url.pathname.slice(this.prefix.length)}${url.search}`;
    } catch {
      return undefined;
    }
  }

  private responseHeaders(
    incoming: http.IncomingHttpHeaders,
    path: string,
  ): http.OutgoingHttpHeaders {
    const connectionTokens = String(incoming.connection ?? "")
      .toLowerCase()
      .split(",")
      .map((name) => name.trim());
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(incoming)) {
      if (
        value === undefined ||
        HOP_BY_HOP.has(name) ||
        RESPONSE_HEADERS_DROPPED.has(name) ||
        connectionTokens.includes(name)
      ) {
        continue;
      }
      headers[name] = value;
    }
    if (typeof incoming.location === "string") {
      headers.location = this.proxiedLocation(incoming.location, path);
    }
    const csp = incoming["content-security-policy"];
    if (csp !== undefined) {
      const kept = withoutFramingDirectives(Array.isArray(csp) ? csp.join(", ") : csp);
      if (kept) {
        headers["content-security-policy"] = kept;
      } else {
        delete headers["content-security-policy"];
      }
    }
    return headers;
  }

  /** Map a server redirect target onto the proxy; other sites are left alone. */
  private proxiedLocation(location: string, path: string): string {
    let resolved: URL;
    try {
      resolved = new URL(location, this.serverOrigin + path);
    } catch {
      return location;
    }
    if (resolved.origin !== this.serverOrigin) {
      return location;
    }
    return `${this.prefix}${resolved.pathname}${resolved.search}${resolved.hash}`;
  }

  private isExternal(location: string, path: string): boolean {
    try {
      return new URL(location, this.serverOrigin + path).origin !== this.serverOrigin;
    } catch {
      return false;
    }
  }

  private captureSessionCookies(setCookie: string[] | undefined): void {
    if (!setCookie || this.options.sessionCookies.length === 0) {
      return;
    }
    for (const event of sessionCookieEvents(setCookie, this.options.sessionCookies)) {
      if (event.type === "set") {
        this.options.credentials.acceptSessionCookie(event.value, event.maxAgeSeconds);
      } else {
        this.options.credentials.sessionCookieCleared();
      }
    }
  }

  /** The path inside the server's mount, or null when outside it. */
  private appPathOf(pathname: string): string | null {
    if (this.serverBasePath === "") {
      return pathname;
    }
    if (pathname === this.serverBasePath) {
      return "/";
    }
    return pathname.startsWith(`${this.serverBasePath}/`)
      ? pathname.slice(this.serverBasePath.length)
      : null;
  }

  /**
   * Where to go after signing in. The app passes its own location (already
   * under the prefix); server redirects pass a server path.
   */
  private safeReturnTo(raw: string | null): string {
    if (!raw || !isServerPath(raw)) {
      return this.homePath;
    }
    const underPrefix =
      raw === this.prefix || raw.startsWith(`${this.prefix}/`) || raw.startsWith(`${this.prefix}?`);
    const proxied = underPrefix ? raw : this.prefix + raw;
    const serverPath = new URL(proxied.slice(this.prefix.length) || "/", "http://proxy.invalid");
    const appPath = this.appPathOf(serverPath.pathname);
    if (appPath === "/auth/login" || appPath === "/auth/logout") {
      return this.homePath;
    }
    return proxied;
  }

  private get serverLabel(): string {
    return this.options.serverLabel ?? new URL(this.serverOrigin).host;
  }

  private sendPage(res: http.ServerResponse, status: number, page: ProxyPage): void {
    res
      .writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": page.csp,
        "cache-control": "no-store",
      })
      .end(page.html);
  }

  private log(message: string): void {
    this.options.log?.(`[omnigent] proxy: ${message}`);
  }
}

/** Read session-cookie sets and clears from `Set-Cookie` values. Pure. */
export function sessionCookieEvents(
  setCookie: readonly string[],
  names: readonly string[],
  now: number = Date.now(),
): SessionCookieEvent[] {
  const events: SessionCookieEvent[] = [];
  for (const header of setCookie) {
    const [pair, ...attributes] = header.split(";");
    const separator = pair.indexOf("=");
    if (separator < 0 || !names.includes(pair.slice(0, separator).trim())) {
      continue;
    }
    let value = pair.slice(separator + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    let maxAgeSeconds: number | undefined;
    let expiresAt: number | undefined;
    for (const attribute of attributes) {
      const [rawKey, ...rest] = attribute.split("=");
      const key = rawKey.trim().toLowerCase();
      const attributeValue = rest.join("=").trim();
      if (key === "max-age" && /^-?\d+$/.test(attributeValue)) {
        maxAgeSeconds = Number(attributeValue);
      } else if (key === "expires") {
        const parsed = Date.parse(attributeValue);
        expiresAt = Number.isNaN(parsed) ? undefined : parsed;
      }
    }
    if (maxAgeSeconds === undefined && expiresAt !== undefined) {
      maxAgeSeconds = Math.floor((expiresAt - now) / 1000);
    }
    if (value === "" || (maxAgeSeconds !== undefined && maxAgeSeconds <= 0)) {
      events.push({ type: "cleared" });
    } else {
      events.push({ type: "set", value, maxAgeSeconds });
    }
  }
  return events;
}

/** Whether a request is a document load rather than a script's fetch. */
export function isNavigation(headers: http.IncomingHttpHeaders): boolean {
  const mode = headers["sec-fetch-mode"];
  if (mode !== undefined) {
    return mode === "navigate";
  }
  return String(headers.accept ?? "").includes("text/html");
}

/**
 * Whether the Databricks Apps edge refused a request's token. Pure.
 *
 * A 401, or a redirect into the workspace's OAuth flow (`/oidc/…`, the edge's
 * `/.auth/…`), means the token no longer signs in. The edge's 403 answers both
 * a dead token and a user without access to the app; the app's own 403s are
 * JSON, and never answer a page load.
 */
export function databricksTokenRejection(
  status: number,
  headers: http.IncomingHttpHeaders,
  navigation: boolean,
): TokenRejection | undefined {
  if (status === 401) {
    return "sign-in";
  }
  if (status === 403) {
    const json = String(headers["content-type"] ?? "")
      .toLowerCase()
      .includes("json");
    return navigation || !json ? "forbidden" : undefined;
  }
  if (status >= 300 && status < 400 && typeof headers.location === "string") {
    let target: URL;
    try {
      target = new URL(headers.location, "https://app.invalid");
    } catch {
      return undefined;
    }
    return target.pathname.startsWith("/oidc/") || target.pathname.startsWith("/.auth/")
      ? "sign-in"
      : undefined;
  }
  return undefined;
}

/** A root-absolute path on the same origin (not `//host` or `/\host`). */
function isServerPath(value: string): boolean {
  return (
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.startsWith("/\\") &&
    value.length <= 4096 &&
    !/[\s\u0000-\u001f]/.test(value)
  );
}

/** Drop the CSP directives that would block framing or break a loopback http origin. */
function withoutFramingDirectives(policy: string): string {
  return policy
    .split(",")
    .map((single) =>
      single
        .split(";")
        .map((directive) => directive.trim())
        .filter((directive) => {
          const name = directive.split(/\s+/)[0]?.toLowerCase();
          return (
            directive !== "" && name !== "frame-ancestors" && name !== "upgrade-insecure-requests"
          );
        })
        .join("; "),
    )
    .filter((single) => single !== "")
    .join(", ");
}

function decodeBody(body: Buffer, encoding: string): Buffer {
  switch (encoding) {
    case "gzip":
      return zlib.gunzipSync(body);
    case "deflate":
      return zlib.inflateSync(body);
    case "br":
      return zlib.brotliDecompressSync(body);
    default:
      return body;
  }
}

function statusLine(res: http.IncomingMessage): string {
  return `HTTP/1.1 ${res.statusCode ?? 502} ${res.statusMessage ?? ""}\r\n`;
}

/** Response header lines for a raw socket, without cookies (and framing, unless upgrading). */
function rawHeaderLines(rawHeaders: string[], upgrade: boolean): string {
  let lines = "";
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const lower = name.toLowerCase();
    if (lower === "set-cookie" || lower === "strict-transport-security") {
      continue;
    }
    if (!upgrade && (HOP_BY_HOP.has(lower) || lower === "content-length")) {
      continue;
    }
    lines += `${name}: ${rawHeaders[index + 1]}\r\n`;
  }
  return lines;
}

async function readSmallBody(
  req: http.IncomingMessage,
  limit: number,
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      return null;
    }
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function nonce(): string {
  return crypto.randomBytes(16).toString("base64");
}

function redactQuery(path: string): string {
  const query = path.indexOf("?");
  return query < 0 ? path : `${path.slice(0, query)}?…`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
