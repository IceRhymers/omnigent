/**
 * Pages the proxy serves inside the panel itself: the browser sign-in prompt,
 * the "continue in your browser" stop for flows that leave the server, and
 * connection errors. Pure HTML builders; each page gets its own nonce CSP.
 */

export interface ProxyPage {
  html: string;
  csp: string;
}

const STYLE = `
  :root { color-scheme: light dark; }
  html, body { margin: 0; height: 100%; }
  body {
    display: flex; align-items: center; justify-content: center;
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #fff; color: #1f2328;
  }
  main { max-width: 28rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 0.5rem; }
  p { margin: 0.5rem 0; color: #59636e; }
  .server { font-family: ui-monospace, Menlo, monospace; word-break: break-all; }
  .error { color: #cf222e; }
  .code { font-family: ui-monospace, Menlo, monospace; font-size: 1.1rem; letter-spacing: 0.1em; }
  button {
    margin-top: 1rem; padding: 0.5rem 1rem; border-radius: 6px; border: 0;
    background: #0969da; color: #fff; font: inherit; cursor: pointer;
  }
  button:disabled { opacity: 0.6; cursor: default; }
  a { color: #0969da; }
  @media (prefers-color-scheme: dark) {
    body { background: #0d1218; color: #e6edf3; }
    p { color: #9198a1; }
    .error { color: #ff7b72; }
    button { background: #1f6feb; }
    a { color: #4493f8; }
  }
`;

/** The sign-in page's wording for one kind of server. */
export interface SignInPrompt {
  detail: string;
  button: string;
}

export const BROWSER_SIGN_IN_PROMPT: SignInPrompt = {
  detail: "This server signs you in through your web browser.",
  button: "Sign in with browser",
};

export interface SignInPageOptions {
  serverLabel: string;
  /** Absolute path of the proxy's control endpoints. */
  controlPath: string;
  /** Where to go once signed in. */
  returnTo: string;
  /** The sign-in generation this page waits to see increase. */
  generation: number;
  signedOut?: boolean;
  prompt?: SignInPrompt;
  nonce: string;
}

/** "Sign in with your browser" — polls the proxy until a new sign-in lands. */
export function signInPage(options: SignInPageOptions): ProxyPage {
  const heading = options.signedOut ? "You're signed out" : "Sign in to continue";
  const prompt = options.prompt ?? BROWSER_SIGN_IN_PROMPT;
  const config = scriptJson({
    control: options.controlPath,
    returnTo: options.returnTo,
    generation: options.generation,
  });
  return page({
    nonce: options.nonce,
    connect: true,
    title: heading,
    body: `
    <h1>${escapeHtml(heading)}</h1>
    <p class="server">${escapeHtml(options.serverLabel)}</p>
    <p id="status">${escapeHtml(prompt.detail)}</p>
    <p id="code" class="code" hidden></p>
    <p id="error" class="error" hidden></p>
    <button id="sign-in" type="button">${escapeHtml(prompt.button)}</button>`,
    script: `
    const config = ${config};
    const button = document.getElementById("sign-in");
    const status = document.getElementById("status");
    const code = document.getElementById("code");
    const error = document.getElementById("error");
    button.addEventListener("click", () => {
      button.disabled = true;
      fetch(config.control + "/sign-in", { method: "POST" }).finally(() => { button.disabled = false; });
    });
    function render(state) {
      if (state.inProgress) {
        status.textContent = "Finish signing in in your browser. This page continues on its own.";
        button.textContent = "Open the sign-in page again";
      }
      code.hidden = !state.userCode;
      code.textContent = state.userCode ? "Confirm code " + state.userCode : "";
      error.hidden = !state.error;
      error.textContent = state.error || "";
      if (state.error) button.textContent = "Try again";
    }
    async function poll() {
      try {
        const response = await fetch(config.control + "/status", { cache: "no-store" });
        const state = await response.json();
        if (state.generation > config.generation) {
          location.replace(config.returnTo);
          return;
        }
        render(state);
      } catch {}
      setTimeout(poll, 1000);
    }
    poll();`,
  });
}

export interface ContinueInBrowserPageOptions {
  serverLabel: string;
  controlPath: string;
  /** The server path to open in the system browser. */
  path: string;
  /** Where "Back to Omnigent" goes. */
  homePath: string;
  nonce: string;
}

/** For steps that redirect to another site, which can't load in the panel. */
export function continueInBrowserPage(options: ContinueInBrowserPageOptions): ProxyPage {
  const config = scriptJson({ control: options.controlPath, path: options.path });
  return page({
    nonce: options.nonce,
    connect: true,
    title: "Continue in your browser",
    body: `
    <h1>Continue in your browser</h1>
    <p>This step opens another website, which can't load inside VS Code.</p>
    <p class="server">${escapeHtml(options.serverLabel)}</p>
    <button id="open" type="button">Open in browser</button>
    <p><a href="${escapeHtml(options.homePath)}">Back to Omnigent</a></p>`,
    script: `
    const config = ${config};
    const button = document.getElementById("open");
    button.addEventListener("click", () => {
      fetch(config.control + "/open-in-browser", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: config.path }),
      });
    });`,
  });
}

/** A static error page (no script). */
export function errorPage(title: string, detail: string, nonce: string): ProxyPage {
  return page({
    nonce,
    connect: false,
    title,
    body: `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>`,
  });
}

function page(options: {
  nonce: string;
  connect: boolean;
  title: string;
  body: string;
  script?: string;
}): ProxyPage {
  const directives = [
    "default-src 'none'",
    `style-src 'nonce-${options.nonce}'`,
    "base-uri 'none'",
    "form-action 'none'",
  ];
  if (options.script) {
    directives.push(`script-src 'nonce-${options.nonce}'`);
  }
  if (options.connect) {
    directives.push("connect-src 'self'");
  }
  const script = options.script
    ? `<script nonce="${options.nonce}">${options.script}</script>`
    : "";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(options.title)}</title>
  <style nonce="${options.nonce}">${STYLE}</style>
</head>
<body>
  <main>${options.body}
  </main>
  ${script}
</body>
</html>`;
  return { html, csp: directives.join("; ") };
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
