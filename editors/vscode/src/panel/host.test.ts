/**
 * Unit tests for the pure helpers in panel/host.ts (render decision + placeholder).
 */
import { describe, it, expect } from "vitest";
import { shouldUseIframe, renderMessageHtml, renderResolvingHtml } from "./host";
import type { ServerTarget } from "../config";

function target(origin: string, hostType: ServerTarget["hostType"]): ServerTarget {
  return { baseUrl: `${origin}/`, origin, hostType, source: "discovered" };
}

describe("shouldUseIframe", () => {
  it("uses iframe for a local server", () => {
    expect(shouldUseIframe(target("http://127.0.0.1:6767", "local"))).toBe(true);
  });
  it("uses iframe for a remote server framed through the loopback proxy", () => {
    expect(shouldUseIframe(target("http://127.0.0.1:53001", "remote"))).toBe(true);
  });
  it("never frames a non-loopback origin directly", () => {
    expect(shouldUseIframe(target("https://omnigent.example.com", "remote"))).toBe(false);
  });
  it("does not use iframe for an unparseable origin", () => {
    expect(shouldUseIframe(target("not a url", "unknown"))).toBe(false);
  });
});

describe("renderResolvingHtml", () => {
  it("is a self-contained placeholder with a CSP and no scripts", () => {
    const html = renderResolvingHtml();
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("Resolving Omnigent server");
    expect(html).not.toContain("<script");
  });

  it("shows custom text, escaped", () => {
    expect(renderResolvingHtml("Connecting to <a>…")).toContain("Connecting to &#60;a&#62;…");
  });
});

describe("renderMessageHtml", () => {
  it("renders escaped text, one button per action, and a nonce'd script", () => {
    const html = renderMessageHtml({
      title: "Couldn't reach <host>",
      detail: 'Check "it"',
      actions: ["Retry", "Connect…"],
      nonce: "n0nce",
    });
    expect(html).toContain("Couldn&#39;t reach &#60;host&#62;");
    expect(html).toContain('data-action="0">Retry</button>');
    expect(html).toContain('data-action="1" class="secondary">Connect…</button>');
    expect(html).toContain("script-src 'nonce-n0nce'");
    expect(html).toContain('<script nonce="n0nce">');
  });
});
