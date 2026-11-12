/**
 * Sole owner of the editor-beside Omnigent `WebviewPanel` AND the state that
 * drives its render: resolving, a resolved server target, or a status message.
 *
 * The panel hosts the Omnigent app in a single static <iframe> (panel/host.ts)
 * pointed at a local server or the local proxy for a remote one. The framed
 * app owns its own navigation; the only messages are button clicks on the
 * status page. This is the ONLY `createWebviewPanel` call in the codebase.
 */
import * as vscode from "vscode";
import * as crypto from "node:crypto";
import { renderInto, renderMessageHtml, renderResolvingHtml } from "./host";
import type { ServerTarget } from "../config";

export interface PanelAction {
  label: string;
  run(): void;
}

export interface PanelMessage {
  title: string;
  detail: string;
  actions?: PanelAction[];
}

type PanelState =
  | { kind: "resolving"; text?: string }
  | { kind: "resolved"; target: ServerTarget }
  | { kind: "message"; message: PanelMessage };

export class EditorPanelController {
  private panel?: vscode.WebviewPanel;
  private state: PanelState = { kind: "resolving" };
  private routePath = "/";
  private targetBaseUrl: string | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly output: vscode.OutputChannel,
  ) {}

  /**
   * Store the resolved server target. If a panel is already open (e.g. opened
   * during the async discovery window), re-render it so it leaves the
   * "Resolving…" placeholder.
   */
  setResolved(target: ServerTarget): void {
    if (this.targetBaseUrl !== undefined && this.targetBaseUrl !== target.baseUrl) {
      this.routePath = "/";
    }
    this.targetBaseUrl = target.baseUrl;
    this.setState({ kind: "resolved", target });
  }

  /** Open an in-app route, such as `/c/<session-id>`, and reveal the panel. */
  openPath(path: string): void {
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new Error(`refusing to navigate to a non-app path: ${path}`);
    }
    this.routePath = path;
    this.ensure();
  }

  /** Show the placeholder, e.g. while connecting to a remote server. */
  setResolving(text?: string): void {
    this.routePath = "/";
    this.setState({ kind: "resolving", text });
  }

  /** Show a status page instead of the app. */
  setMessage(message: PanelMessage): void {
    this.setState({ kind: "message", message });
  }

  /** Reload the framed app (e.g. after signing out). */
  reload(): void {
    if (this.panel) {
      this.render(this.panel.webview);
    }
  }

  /** Create-or-reveal the editor-beside panel and render it. */
  ensure(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      this.render(this.panel.webview);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "omnigent",
      "Omnigent",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
      },
    );
    this.panel = panel;
    panel.webview.onDidReceiveMessage((message: unknown) => this.onMessage(message));
    panel.onDidDispose(() => {
      // Guard against a fire after the controller already dropped this panel.
      if (this.panel === panel) {
        this.panel = undefined;
      }
    });
    this.render(panel.webview);
    this.output.appendLine("[omnigent] opened editor-beside panel");
  }

  /** Whether the editor panel is currently open. */
  isOpen(): boolean {
    return this.panel !== undefined;
  }

  /** Dispose the panel and null the ref (idempotent). */
  dispose(): void {
    const panel = this.panel;
    this.panel = undefined;
    panel?.dispose();
  }

  private setState(state: PanelState): void {
    this.state = state;
    if (this.panel) {
      this.render(this.panel.webview);
    }
  }

  private onMessage(message: unknown): void {
    if (this.state.kind !== "message") {
      return;
    }
    const { type, index } = (message ?? {}) as { type?: unknown; index?: unknown };
    if (type === "action" && typeof index === "number") {
      this.state.message.actions?.[index]?.run();
    }
  }

  private render(webview: vscode.Webview): void {
    switch (this.state.kind) {
      case "resolving":
        webview.html = renderResolvingHtml(this.state.text);
        return;
      case "message":
        webview.html = renderMessageHtml({
          title: this.state.message.title,
          detail: this.state.message.detail,
          actions: (this.state.message.actions ?? []).map((action) => action.label),
          nonce: crypto.randomBytes(16).toString("base64url"),
          cspSource: webview.cspSource,
        });
        return;
      case "resolved":
        renderInto(webview, {
          target: this.state.target,
          path: this.routePath,
          log: (m) => this.output.appendLine(m),
        });
    }
  }
}
