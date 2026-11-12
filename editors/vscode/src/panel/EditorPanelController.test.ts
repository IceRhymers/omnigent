/**
 * Tests for EditorPanelController — the sole owner of the editor WebviewPanel.
 * Uses a FAKE WebviewPanel (createWebviewPanel replaced) and a LOCAL target so
 * the iframe render path is taken (the only path in this build).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import * as vscode from "vscode";
import { EditorPanelController } from "./EditorPanelController";
import type { ServerTarget } from "../config";

const LOCAL_TARGET: ServerTarget = {
  baseUrl: "http://127.0.0.1:6767",
  origin: "http://127.0.0.1:6767",
  hostType: "local",
  source: "discovered",
};

/** A fake WebviewPanel that records html set on its webview. */
function makeFakePanel() {
  let disposeCb: (() => void) | undefined;
  let messageCb: ((message: unknown) => void) | undefined;
  const panel = {
    webview: {
      html: "",
      cspSource: "vscode-resource:",
      asWebviewUri: (uri: { toString(): string }) => uri,
      postMessage: () => true,
      onDidReceiveMessage: (cb: (message: unknown) => void) => {
        messageCb = cb;
        return { dispose: () => {} };
      },
    },
    reveal: vi.fn(),
    onDidDispose: (cb: () => void) => {
      disposeCb = cb;
      return { dispose: () => {} };
    },
    dispose: vi.fn(() => disposeCb?.()),
  };
  return { panel, postFromWebview: (message: unknown) => messageCb?.(message) };
}

function makeController() {
  const extensionUri = vscode.Uri.parse("file:///ext") as unknown as vscode.Uri;
  const output = { appendLine: () => {} } as unknown as vscode.OutputChannel;
  return new EditorPanelController(extensionUri, output);
}

describe("EditorPanelController", () => {
  let fake: ReturnType<typeof makeFakePanel>;
  let createSpy: Mock<() => ReturnType<typeof makeFakePanel>["panel"]>;

  beforeEach(() => {
    fake = makeFakePanel();
    const win = vscode.window as unknown as Record<string, unknown>;
    createSpy = vi.fn(() => fake.panel);
    win.createWebviewPanel = createSpy;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ensure() creates a single panel and renders the iframe for a resolved local target", () => {
    const controller = makeController();
    controller.setResolved(LOCAL_TARGET);
    controller.ensure();

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(fake.panel.webview.html).toContain('id="omnigent-frame"');
    expect(fake.panel.webview.html).toContain('src="http://127.0.0.1:6767"');
  });

  it("ensure() reuses and reveals the existing panel (no second panel)", () => {
    const controller = makeController();
    controller.setResolved(LOCAL_TARGET);
    controller.ensure();
    controller.ensure();

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(fake.panel.reveal).toHaveBeenCalled();
  });

  it("opening before setResolved shows the placeholder, then setResolved re-renders the iframe", () => {
    const controller = makeController();

    controller.ensure();
    expect(controller.isOpen()).toBe(true);
    expect(fake.panel.webview.html).toContain("Resolving");

    controller.setResolved(LOCAL_TARGET);
    expect(fake.panel.webview.html).toContain('id="omnigent-frame"');
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("never injects a token into the rendered html", () => {
    const controller = makeController();
    controller.setResolved(LOCAL_TARGET);
    controller.ensure();
    expect(fake.panel.webview.html.toLowerCase()).not.toContain("token");
  });

  it("frames a remote server through its loopback proxy entry URL", () => {
    const controller = makeController();
    controller.setResolved({
      baseUrl: "http://127.0.0.1:53001/c2VjcmV0/",
      origin: "http://127.0.0.1:53001",
      hostType: "remote",
      source: "manual",
      displayUrl: "https://omnigent.example.com",
    });
    controller.ensure();

    expect(fake.panel.webview.html).toContain('src="http://127.0.0.1:53001/c2VjcmV0"');
    expect(fake.panel.webview.html).toContain("frame-src http://127.0.0.1:53001");
    expect(fake.panel.webview.html).not.toContain("omnigent.example.com");
  });

  it("openPath() reveals the existing panel directly at a session", () => {
    const controller = makeController();
    controller.setResolved(LOCAL_TARGET);
    controller.ensure();

    controller.openPath("/c/conv_123");

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(fake.panel.reveal).toHaveBeenCalled();
    expect(fake.panel.webview.html).toContain('src="http://127.0.0.1:6767/c/conv_123"');
  });

  it("returns to the home route when the panel starts resolving another server", () => {
    const controller = makeController();
    controller.setResolved(LOCAL_TARGET);
    controller.openPath("/c/conv_123");
    controller.setResolving("Connecting elsewhere…");
    controller.setResolved({ ...LOCAL_TARGET, baseUrl: "http://127.0.0.1:7000" });

    expect(fake.panel.webview.html).toContain('src="http://127.0.0.1:7000"');
    expect(fake.panel.webview.html).not.toContain("conv_123");
  });

  it("does not carry an old session through an error page onto another server", () => {
    const controller = makeController();
    controller.setResolved(LOCAL_TARGET);
    controller.openPath("/c/old-server-session");
    controller.setMessage({ title: "Disconnected", detail: "Try another server." });
    controller.setResolved({ ...LOCAL_TARGET, baseUrl: "http://127.0.0.1:7000" });

    expect(fake.panel.webview.html).toContain('src="http://127.0.0.1:7000"');
    expect(fake.panel.webview.html).not.toContain("old-server-session");
  });

  it("shows a status message whose buttons run their actions", () => {
    const controller = makeController();
    const retry = vi.fn();
    const connect = vi.fn();
    controller.ensure();
    controller.setMessage({
      title: "Couldn't reach omnigent.example.com",
      detail: "Check your network.",
      actions: [
        { label: "Retry", run: retry },
        { label: "Connect…", run: connect },
      ],
    });

    expect(fake.panel.webview.html).toContain("Couldn&#39;t reach omnigent.example.com");
    fake.postFromWebview({ type: "action", index: 1 });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();

    // Once the app is showing, stale clicks from the old page do nothing.
    controller.setResolved(LOCAL_TARGET);
    fake.postFromWebview({ type: "action", index: 0 });
    expect(retry).not.toHaveBeenCalled();
  });

  it("reload() re-renders the framed app with a fresh nonce", () => {
    const controller = makeController();
    controller.setResolved(LOCAL_TARGET);
    controller.ensure();
    const before = fake.panel.webview.html;
    controller.reload();
    expect(fake.panel.webview.html).toContain('id="omnigent-frame"');
    expect(fake.panel.webview.html).not.toBe(before);
  });

  it("dispose() disposes the panel and nulls the ref; onDidDispose does not double-clear", () => {
    const controller = makeController();
    controller.setResolved(LOCAL_TARGET);
    controller.ensure();
    expect(controller.isOpen()).toBe(true);

    controller.dispose();
    expect(fake.panel.dispose).toHaveBeenCalled();
    expect(controller.isOpen()).toBe(false);
  });
});
