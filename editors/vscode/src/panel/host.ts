/**
 * Shared render helper for the Omnigent editor panel.
 *
 * The Omnigent UI renders in the editor-beside `WebviewPanel`
 * (EditorPanelController → ViewColumn.Beside) as a single <iframe>. This
 * module factors the render logic into a single `renderInto(webview, opts)` so
 * the controller stays thin.
 *
 * Render decision: the iframe only ever frames a LOOPBACK origin — a local
 * server directly, or the local credential proxy (proxy/ServerProxy.ts) for a
 * remote server — so no token ever lands in a navigable URL. Until a target
 * resolves, the controller shows renderResolvingHtml or renderMessageHtml.
 */
import * as vscode from "vscode";
import * as crypto from "node:crypto";
import { buildCsp } from "./csp";
import { buildIframeHtml } from "./iframeHtml";
import { hostTypeOf, type ServerTarget } from "../config";

/** Returns true when the iframe path should be used for this target. */
export function shouldUseIframe(target: ServerTarget): boolean {
  return hostTypeOf(target.origin) === "local";
}

export interface RenderIntoOptions {
  /** Resolved target whose origin is loopback. */
  target: ServerTarget;
  /** Optional diagnostic logger. */
  log?: (msg: string) => void;
}

/** Render the Omnigent iframe host into a webview. Sets `webview.html`. */
export function renderInto(webview: vscode.Webview, opts: RenderIntoOptions): void {
  if (!shouldUseIframe(opts.target)) {
    throw new Error(`refusing to frame non-loopback origin ${opts.target.origin}`);
  }
  const nonce = crypto.randomBytes(16).toString("base64url");
  const csp = buildCsp({
    serverOrigin: opts.target.origin,
    nonce,
    cspSource: webview.cspSource,
  });
  webview.html = buildIframeHtml({ baseUrl: opts.target.baseUrl, csp, nonce });
  opts.log?.(
    `[omnigent] iframe rendered (origin=${opts.target.origin}, nonce=${nonce.slice(0, 8)}...)`,
  );
}

/** Minimal placeholder HTML shown until the server target is resolved. Self-contained CSP. */
export function renderResolvingHtml(text = "Resolving Omnigent server…"): string {
  const csp = "default-src 'none'; style-src 'unsafe-inline'";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Omnigent</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; width: 100%; }
    body {
      display: flex; align-items: center; justify-content: center;
      font-family: var(--vscode-font-family, sans-serif);
      color: var(--vscode-descriptionForeground, #999);
      background: var(--vscode-editor-background, #1e1e1e);
    }
  </style>
</head>
<body>
  <p>${escapeHtml(text)}</p>
</body>
</html>`;
}

export interface MessageHtmlOptions {
  title: string;
  detail: string;
  /** Button labels; a click posts `{ type: "action", index }` to the extension. */
  actions: readonly string[];
  nonce: string;
  cspSource?: string;
}

/** A status page (e.g. "can't connect") with optional action buttons. */
export function renderMessageHtml(opts: MessageHtmlOptions): string {
  const styleSrc = opts.cspSource
    ? `'nonce-${opts.nonce}' ${opts.cspSource}`
    : `'nonce-${opts.nonce}'`;
  const csp = `default-src 'none'; style-src ${styleSrc}; script-src 'nonce-${opts.nonce}'`;
  const buttons = opts.actions
    .map(
      (label, index) =>
        `<button type="button" data-action="${index}"${index > 0 ? ' class="secondary"' : ""}>${escapeHtml(label)}</button>`,
    )
    .join("\n      ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Omnigent</title>
  <style nonce="${opts.nonce}">
    html, body { margin: 0; padding: 0; height: 100%; width: 100%; }
    body {
      display: flex; align-items: center; justify-content: center;
      font-family: var(--vscode-font-family, sans-serif);
      color: var(--vscode-foreground, #ccc);
      background: var(--vscode-editor-background, #1e1e1e);
    }
    main { max-width: 32rem; padding: 2rem; text-align: center; }
    h1 { font-size: 1.2em; font-weight: 600; margin: 0 0 0.5rem; }
    p { color: var(--vscode-descriptionForeground, #999); margin: 0 0 1rem; }
    button {
      margin: 0.25rem; padding: 0.4rem 0.9rem; border: 0; border-radius: 2px; cursor: pointer;
      font: inherit;
      color: var(--vscode-button-foreground, #fff);
      background: var(--vscode-button-background, #0e639c);
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground, #fff);
      background: var(--vscode-button-secondaryBackground, #3a3d41);
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(opts.title)}</h1>
    <p>${escapeHtml(opts.detail)}</p>
    <div>
      ${buttons}
    </div>
  </main>
  <script nonce="${opts.nonce}">
    const vscode = acquireVsCodeApi();
    for (const button of document.querySelectorAll("button[data-action]")) {
      button.addEventListener("click", () => {
        vscode.postMessage({ type: "action", index: Number(button.dataset.action) });
      });
    }
  </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
