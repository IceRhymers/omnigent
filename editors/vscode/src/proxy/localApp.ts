/**
 * The Omnigent web app the proxy serves itself, for a server that has no
 * standalone app to frame: a Databricks workspace serves only the Omnigent API
 * (its `/omnigent` page is the Databricks web app embedding Omnigent). The
 * extension bundles its own build (scripts/build-web-ui.js), and the proxy
 * sends only the server's own paths on, as the web dev server does
 * (web/vite.config.ts).
 */
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type * as http from "node:http";

/** The server's paths inside its mount; web/vite.config.ts's dev proxy forwards the same. */
const SERVER_PATH_PREFIXES = ["/v1", "/api", "/auth", "/health", "/.well-known"];

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".mjs": "text/javascript; charset=utf-8",
  ".otf": "font/otf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export interface LocalAppFile {
  /** Absolute path on disk. */
  path: string;
  size: number;
  contentType: string;
}

export type LocalAppRoute = "server" | "file" | "index" | "not-found";

export class LocalApp {
  private constructor(
    /** The build's `index.html`, before it is rebased under the proxy. */
    readonly indexHtml: string,
    private readonly files: ReadonlyMap<string, LocalAppFile>,
  ) {}

  /**
   * Index a built app directory. Only the files found here are ever served,
   * so a request path can't reach outside it. Undefined without an `index.html`.
   */
  static async load(root: string): Promise<LocalApp | undefined> {
    let indexHtml: string;
    try {
      indexHtml = await readFile(join(root, "index.html"), "utf8");
    } catch {
      return undefined;
    }
    const files = new Map<string, LocalAppFile>();
    await collectFiles(root, "", files);
    // Served only rebased, as the app shell.
    files.delete("/index.html");
    return new LocalApp(indexHtml, files);
  }

  get fileCount(): number {
    return this.files.size;
  }

  file(appPath: string): LocalAppFile | undefined {
    return this.files.get(appPath);
  }

  /** How to answer a request for a path inside the server's mount. */
  route(appPath: string, method: string | undefined, navigation: boolean): LocalAppRoute {
    return routeLocalApp(appPath, method, navigation, (path) => this.files.has(path));
  }
}

/**
 * The server's paths go to it; bundle files are served; any other page load
 * gets the app shell (client-side routes like `/c/<id>`); the rest is a 404,
 * so the user's token only ever goes to the server's API. Pure.
 */
export function routeLocalApp(
  appPath: string,
  method: string | undefined,
  navigation: boolean,
  hasFile: (appPath: string) => boolean,
): LocalAppRoute {
  if (forwardsToServer(appPath)) {
    return "server";
  }
  if (method !== "GET" && method !== "HEAD") {
    return "not-found";
  }
  if (hasFile(appPath)) {
    return "file";
  }
  return navigation ? "index" : "not-found";
}

/** Whether a path inside the mount is one of the server's own. Pure. */
export function forwardsToServer(appPath: string): boolean {
  return SERVER_PATH_PREFIXES.some(
    (prefix) => appPath === prefix || appPath.startsWith(`${prefix}/`),
  );
}

/** Send a bundle file; content-hashed assets may be cached for good. */
export function sendLocalFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  appPath: string,
  file: LocalAppFile,
  onError: (error: unknown) => void,
): void {
  res.writeHead(200, {
    "content-type": file.contentType,
    "content-length": file.size,
    "cache-control": appPath.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(file.path);
  stream.on("error", (error) => {
    onError(error);
    res.destroy();
  });
  stream.pipe(res);
}

async function collectFiles(
  dir: string,
  urlPath: string,
  files: Map<string, LocalAppFile>,
): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const entryUrlPath = `${urlPath}/${entry.name}`;
    if (entry.isDirectory()) {
      await collectFiles(path, entryUrlPath, files);
    } else if (entry.isFile()) {
      const { size } = await stat(path);
      files.set(entryUrlPath, {
        path,
        size,
        contentType: CONTENT_TYPES[extname(entry.name).toLowerCase()] ?? "application/octet-stream",
      });
    }
  }
}
