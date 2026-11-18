/**
 * Rebase a remote server's HTML under the proxy's secret path prefix.
 *
 * The server already rebases its built `index.html` for its own deployment
 * base path (`_rewrite_web_ui_index` in omnigent/server/app.py): asset refs
 * become root-absolute and `window.__OMNIGENT_BASE_PATH__` names the base. The
 * proxy serves that page under `/<secret>`, so it prefixes both again. Older
 * servers that leave `./` refs and a `<base href="/">` are handled too.
 */

const BASE_PATH_ASSIGNMENT = /window\.__OMNIGENT_BASE_PATH__\s*=\s*("(?:[^"\\]|\\.)*")/;
const ATTRIBUTE_REF = /(\s(?:src|href)=)(["'])(\.\/|\/(?![/\\]))/g;

/**
 * @param html The server's HTML.
 * @param prefix The proxy prefix, e.g. `/Zm9v…`.
 * @param serverBasePath The server URL's path (`""` or `/omnigent`), used for
 *   `./` refs from servers that don't rewrite them.
 */
export function rewriteIndexHtml(html: string, prefix: string, serverBasePath: string): string {
  let serverBase = "";
  let rewritten = html.replace(BASE_PATH_ASSIGNMENT, (_match, literal: string) => {
    try {
      const value = JSON.parse(literal) as unknown;
      serverBase = typeof value === "string" ? value.replace(/\/+$/, "") : "";
    } catch {
      serverBase = "";
    }
    return `window.__OMNIGENT_BASE_PATH__ = ${scriptString(prefix + serverBase)}`;
  });
  const rewroteBase = rewritten !== html;
  rewritten = rewritten
    .replace(/<base\b[^>]*>/gi, "")
    .replace(ATTRIBUTE_REF, (_match, attribute: string, quote: string, ref: string) =>
      ref === "./"
        ? `${attribute}${quote}${prefix}${serverBasePath}/`
        : `${attribute}${quote}${prefix}/`,
    );
  if (!rewroteBase) {
    const injection = `<script>window.__OMNIGENT_BASE_PATH__ = ${scriptString(prefix + serverBasePath)};</script>`;
    rewritten = /<head\b[^>]*>/i.test(rewritten)
      ? rewritten.replace(/<head\b[^>]*>/i, (head) => `${head}${injection}`)
      : `${injection}${rewritten}`;
  }
  return rewritten;
}

/** JSON-encode for an inline script, neutralizing any `</`. */
function scriptString(value: string): string {
  return JSON.stringify(value).replace(/<\//g, "<\\/");
}
