import { describe, expect, it } from "vitest";
import { rewriteIndexHtml } from "./indexRewrite";

const PREFIX = "/c2VjcmV0";

describe("rewriteIndexHtml", () => {
  it("prefixes a server-rebased page's base path and root-absolute refs", () => {
    const html =
      '<head><script>window.__OMNIGENT_BASE_PATH__ = "/team/";</script>' +
      '<link rel="icon" href="/team/favicon.svg"><script src="/team/assets/app.js"></script>' +
      '<script src="//cdn.example.com/x.js"></script><a href="https://example.com/">x</a></head>';
    const out = rewriteIndexHtml(html, PREFIX, "/team");
    expect(out).toContain(`window.__OMNIGENT_BASE_PATH__ = "${PREFIX}/team"`);
    expect(out).toContain(`href="${PREFIX}/team/favicon.svg"`);
    expect(out).toContain(`src="${PREFIX}/team/assets/app.js"`);
    expect(out).toContain('src="//cdn.example.com/x.js"');
    expect(out).toContain('href="https://example.com/"');
  });

  it("injects the prefix as the base path for a root deployment, which sets none", () => {
    // What _rewrite_web_ui_index emits with an empty base path.
    const html =
      '<html><head><script type="module" crossorigin src="/assets/index-abc.js"></script>' +
      '<link rel="stylesheet" href="/assets/index-abc.css"></head></html>';
    const out = rewriteIndexHtml(html, PREFIX, "");
    expect(out).toContain(`<head><script>window.__OMNIGENT_BASE_PATH__ = "${PREFIX}";</script>`);
    expect(out).toContain(`src="${PREFIX}/assets/index-abc.js"`);
    expect(out).toContain(`href="${PREFIX}/assets/index-abc.css"`);
  });

  it("handles older pages with ./ refs and a <base>, injecting the base path", () => {
    const html =
      '<html><head><base href="/"><script type="module" src="./assets/app.js"></script></head></html>';
    const out = rewriteIndexHtml(html, PREFIX, "/team");
    expect(out).not.toContain("<base");
    expect(out).toContain(`src="${PREFIX}/team/assets/app.js"`);
    expect(out).toContain(
      `<head><script>window.__OMNIGENT_BASE_PATH__ = "${PREFIX}/team";</script>`,
    );
  });

  it("can't be broken out of its script by the base path", () => {
    const out = rewriteIndexHtml("<head></head>", "/p", "/</script><script>alert(1)");
    expect(out).not.toContain("</script><script>alert(1)");
  });
});
