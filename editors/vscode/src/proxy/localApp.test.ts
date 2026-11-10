import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalApp, forwardsToServer, routeLocalApp } from "./localApp";

const dirs: string[] = [];

async function appDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omnigent-local-app-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("forwardsToServer", () => {
  it.each([
    ["/v1", true],
    ["/v1/sessions", true],
    ["/auth/login", true],
    ["/api/version", true],
    ["/health", true],
    ["/.well-known/omnigent.json", true],
    ["/", false],
    ["/c/42", false],
    ["/v10", false],
    ["/healthz", false],
    ["/assets/app.js", false],
  ])("%s → %s", (path, expected) => {
    expect(forwardsToServer(path)).toBe(expected);
  });
});

describe("routeLocalApp", () => {
  const hasFile = (path: string) => path === "/assets/app.js" || path === "/favicon.svg";

  it("sends the server's paths on, whatever the method", () => {
    expect(routeLocalApp("/v1/sessions", "POST", false, hasFile)).toBe("server");
    expect(routeLocalApp("/v1/integrations/github/connect", "GET", true, hasFile)).toBe("server");
  });

  it("serves bundle files, and the app shell for any other page load", () => {
    expect(routeLocalApp("/assets/app.js", "GET", false, hasFile)).toBe("file");
    expect(routeLocalApp("/favicon.svg", "HEAD", false, hasFile)).toBe("file");
    expect(routeLocalApp("/", "GET", true, hasFile)).toBe("index");
    expect(routeLocalApp("/c/42", "GET", true, hasFile)).toBe("index");
  });

  it("answers anything else locally with a 404", () => {
    expect(routeLocalApp("/assets/gone.js", "GET", false, hasFile)).toBe("not-found");
    expect(routeLocalApp("/c/42", "GET", false, hasFile)).toBe("not-found");
    expect(routeLocalApp("/assets/app.js", "POST", false, hasFile)).toBe("not-found");
    expect(routeLocalApp("/c/42", "POST", true, hasFile)).toBe("not-found");
  });
});

describe("LocalApp.load", () => {
  it("indexes the build's files with their types, keeping index.html as the shell", async () => {
    const dir = await appDir({
      "index.html": "<html></html>",
      "favicon.svg": "<svg/>",
      "assets/app-1a2b.js": "export {};",
      "assets/fonts/inter.woff2": "font",
    });
    const app = await LocalApp.load(dir);
    expect(app).toBeDefined();
    if (!app) return;
    expect(app.indexHtml).toBe("<html></html>");
    expect(app.fileCount).toBe(3);
    expect(app.file("/index.html")).toBeUndefined();
    expect(app.file("/assets/app-1a2b.js")).toEqual({
      path: join(dir, "assets/app-1a2b.js"),
      size: 10,
      contentType: "text/javascript; charset=utf-8",
    });
    expect(app.file("/assets/fonts/inter.woff2")?.contentType).toBe("font/woff2");
    expect(app.file("/favicon.svg")?.contentType).toBe("image/svg+xml");
  });

  it("never resolves a path outside what it indexed", async () => {
    const app = await LocalApp.load(await appDir({ "index.html": "", "assets/a.js": "" }));
    for (const path of ["/assets/../index.html", "/../package.json", "/assets/%2e%2e/a.js", ""]) {
      expect(app?.file(path)).toBeUndefined();
    }
  });

  it("is undefined for a directory without an index.html", async () => {
    expect(await LocalApp.load(await appDir({ "assets/a.js": "" }))).toBeUndefined();
    expect(await LocalApp.load(join(tmpdir(), "omnigent-no-such-dir"))).toBeUndefined();
  });
});
