/**
 * Connects the panel to the configured server: a local one directly, a remote
 * one through a per-server credential proxy (proxy/ServerProxy.ts). Owns the
 * active proxy and re-resolves whenever `omnigent.serverUrl` changes.
 */
import * as vscode from "vscode";
import { resolveServerTarget, type TargetResolution } from "../config";
import { readSettings } from "../config/vscodeSettings";
import { DEFAULT_HEALTH_TIMEOUT_MS, discoverLocalServer } from "../discovery";
import { ServerCredentials } from "../auth/credentials";
import { MementoCliReuseGate, SecretSessionVault } from "../auth/credentialStore";
import { readCliSession } from "../auth/cliTokens";
import { refreshSession, revokeGrant, signInWithBrowser } from "../auth/omnigentSignIn";
import { ServerProxy } from "../proxy/ServerProxy";
import type { EditorPanelController, PanelAction } from "../panel/EditorPanelController";
import { probeServer, type RemoteServerKind } from "./classify";
import { addRecentServer, RECENT_SERVERS_KEY } from "./recents";

export const CONNECT_COMMAND = "omnigent.connect";

interface ActiveRemote {
  serverUrl: string;
  proxy: ServerProxy;
  credentials: ServerCredentials;
}

export class ServerConnection implements vscode.Disposable {
  private active: ActiveRemote | undefined;
  private attempt = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly controller: EditorPanelController,
    private readonly output: vscode.OutputChannel,
  ) {}

  /** Re-read the settings and (re)connect the panel. Never throws. */
  async refresh(): Promise<void> {
    const attempt = ++this.attempt;
    try {
      await this.connect(attempt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`connect failed: ${message}`);
      if (attempt === this.attempt) {
        this.controller.setMessage({
          title: "Couldn't open Omnigent",
          detail: message,
          actions: [{ label: "Retry", run: () => void this.refresh() }],
        });
      }
    }
  }

  private async connect(attempt: number): Promise<void> {
    await this.closeActive();
    const settings = readSettings();
    let resolution: TargetResolution;
    if (settings.serverUrl.trim() !== "") {
      resolution = resolveServerTarget(settings, { found: false });
    } else {
      this.controller.setResolving();
      const discovery = await discoverLocalServer(undefined, DEFAULT_HEALTH_TIMEOUT_MS);
      resolution = resolveServerTarget(settings, {
        found: discovery.found,
        baseUrl: discovery.found ? discovery.baseUrl : undefined,
        health: discovery.found ? discovery.health : undefined,
      });
    }
    if (attempt !== this.attempt) {
      return;
    }
    switch (resolution.status) {
      case "resolved":
        this.controller.setResolved(resolution.target);
        this.log(
          `target: ${resolution.target.baseUrl} (hostType=${resolution.target.hostType}, source=${resolution.target.source})`,
        );
        return;
      case "remote":
        await this.connectRemote(resolution.serverUrl, resolution.kind, attempt);
        return;
      case "needs-prompt":
        this.log(`no server to show (${resolution.reason})`);
        this.controller.setMessage(this.needsPromptMessage(resolution.reason));
    }
  }

  /** Sign out of the connected remote server and reload the panel. */
  async signOut(): Promise<string | undefined> {
    const active = this.active;
    if (!active) {
      return undefined;
    }
    await active.credentials.signOut();
    if (this.active === active) {
      this.controller.reload();
    }
    return active.serverUrl;
  }

  dispose(): void {
    this.attempt++;
    void this.closeActive();
  }

  private async connectRemote(
    serverUrl: string,
    kind: RemoteServerKind,
    attempt: number,
  ): Promise<void> {
    const host = new URL(serverUrl).host;
    const openInBrowser: PanelAction = {
      label: "Open in Browser",
      run: () => void vscode.env.openExternal(vscode.Uri.parse(serverUrl)),
    };
    const connectElsewhere: PanelAction = {
      label: "Connect to Another Server…",
      run: () => void vscode.commands.executeCommand(CONNECT_COMMAND),
    };
    const retry: PanelAction = { label: "Retry", run: () => void this.refresh() };

    if (vscode.env.remoteName) {
      this.controller.setMessage({
        title: "Remote servers aren't available in this window yet",
        detail: `This window runs on a remote machine (${vscode.env.remoteName}). Open ${host} from a local VS Code window, or in your browser.`,
        actions: [openInBrowser, connectElsewhere],
      });
      return;
    }
    if (kind !== "self-hosted") {
      const what = kind === "databricks-app" ? "Databricks Apps" : "Databricks-hosted Omnigent";
      this.controller.setMessage({
        title: `${what} isn't supported in VS Code yet`,
        detail: `Open ${host} in your browser for now.`,
        actions: [openInBrowser, connectElsewhere],
      });
      return;
    }

    this.controller.setResolving(`Connecting to ${host}…`);
    const probe = await probeServer(serverUrl);
    if (attempt !== this.attempt) {
      return;
    }
    if (probe.status === "unreachable") {
      this.log(`couldn't reach ${serverUrl}: ${probe.detail}`);
      this.controller.setMessage({
        title: `Couldn't reach ${host}`,
        detail: "Check the URL and your network connection, then retry.",
        actions: [retry, connectElsewhere],
      });
      return;
    }
    if (probe.status === "not-omnigent") {
      this.controller.setMessage({
        title: `${host} doesn't look like an Omnigent server`,
        detail:
          "Check the server URL. If the server is behind a login page, open it in your browser.",
        actions: [connectElsewhere, openInBrowser],
      });
      return;
    }
    const profile = probe.profile;
    if (profile.authMode === "header" || profile.authMode === "custom") {
      this.controller.setMessage({
        title: `VS Code can't sign in to ${host} yet`,
        detail:
          "This server signs users in through a login service in front of it, which the panel can't use. Open it in your browser instead.",
        actions: [openInBrowser, connectElsewhere],
      });
      return;
    }

    const credentials = new ServerCredentials({
      serverUrl,
      vault: new SecretSessionVault(this.context.secrets),
      cliGate: new MementoCliReuseGate(this.context.globalState),
      readCliSession: (url) => readCliSession(url),
      refresh: (grant) => refreshSession(serverUrl, grant),
      revoke: (grant) => revokeGrant(serverUrl, grant),
      signIn:
        profile.authMode === "oidc"
          ? (signal, onUserCode) =>
              signInWithBrowser(serverUrl, {
                openExternal,
                nativeSignIn: profile.nativeSignIn,
                signal,
                onUserCode,
              })
          : undefined,
      log: (message) => this.output.appendLine(message),
    });
    const proxy = await ServerProxy.start({
      serverUrl,
      authMode: profile.authMode,
      sessionCookies: profile.sessionCookies,
      credentials,
      openExternal,
      serverLabel: `${host}${new URL(serverUrl).pathname.replace(/\/+$/, "")}`,
      log: (message) => this.output.appendLine(message),
    });
    if (attempt !== this.attempt) {
      credentials.dispose();
      await proxy.close();
      return;
    }
    this.active = { serverUrl, proxy, credentials };
    this.controller.setResolved({
      baseUrl: proxy.entryUrl,
      origin: proxy.origin,
      hostType: "remote",
      source: "manual",
      displayUrl: serverUrl,
    });
    this.log(`connected to ${serverUrl} (auth=${profile.authMode}) via ${proxy.origin}`);
    const recents = addRecentServer(this.context.globalState.get(RECENT_SERVERS_KEY), serverUrl);
    void this.context.globalState.update(RECENT_SERVERS_KEY, recents);
  }

  private needsPromptMessage(
    reason: Extract<TargetResolution, { status: "needs-prompt" }>["reason"],
  ): { title: string; detail: string; actions: PanelAction[] } {
    const connect: PanelAction = {
      label: "Connect to Server…",
      run: () => void vscode.commands.executeCommand(CONNECT_COMMAND),
    };
    const retry: PanelAction = { label: "Retry", run: () => void this.refresh() };
    switch (reason) {
      case "insecure-remote":
        return {
          title: "Remote servers need https",
          detail:
            "The omnigent.serverUrl setting uses plain http for a remote host. Use its https URL.",
          actions: [connect],
        };
      case "invalid-url":
        return {
          title: "The server URL isn't valid",
          detail: "Check the omnigent.serverUrl setting, or pick a server.",
          actions: [connect],
        };
      case "local-unhealthy":
        return {
          title: "The local Omnigent server isn't responding",
          detail: "Restart it with `omnigent server`, then retry.",
          actions: [retry, connect],
        };
      case "no-manual-no-local":
        return {
          title: "No Omnigent server found",
          detail: "Start one with `omnigent server`, or connect to a remote server.",
          actions: [connect, retry],
        };
    }
  }

  private async closeActive(): Promise<void> {
    const active = this.active;
    this.active = undefined;
    active?.credentials.dispose();
    await active?.proxy.close().catch(() => undefined);
  }

  private log(message: string): void {
    this.output.appendLine(`[omnigent] ${message}`);
  }
}

function openExternal(url: string): Promise<boolean> {
  return Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(url, true)));
}
