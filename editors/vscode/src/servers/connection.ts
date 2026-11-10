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
import { readCliSession, readCliWorkspace } from "../auth/cliTokens";
import { DatabricksCliTokens } from "../auth/databricksCli";
import { refreshDatabricksGrant, signInWithDatabricks } from "../auth/databricksSignIn";
import { refreshSession, revokeGrant, signInWithBrowser } from "../auth/omnigentSignIn";
import { LocalApp } from "../proxy/localApp";
import { ServerProxy, type ProxyAuthMode } from "../proxy/ServerProxy";
import type { SignInPrompt } from "../proxy/pages";
import type { EditorPanelController, PanelAction } from "../panel/EditorPanelController";
import {
  findDatabricksWorkspace,
  probeServer,
  probeWorkspace,
  workspaceOmnigent,
  type RemoteServerKind,
  type WorkspaceOmnigent,
} from "./classify";
import { addRecentServer, RECENT_SERVERS_KEY } from "./recents";

export const CONNECT_COMMAND = "omnigent.connect";

interface ActiveRemote {
  serverUrl: string;
  proxy: ServerProxy;
  credentials: ServerCredentials;
}

interface RemoteActions {
  openInBrowser: PanelAction;
  connectElsewhere: PanelAction;
  retry: PanelAction;
}

/** How the proxy signs a remote server's requests. */
interface RemoteSetup {
  credentials: ServerCredentials;
  authMode: ProxyAuthMode;
  sessionCookies: readonly string[];
  signInPrompt?: SignInPrompt;
  /** The app to serve when the server has none to frame. */
  localApp?: LocalApp;
  /** For the output log. */
  description: string;
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
    // A workspace serves its API apart from its page, which is what users open.
    const workspace = kind === "databricks-workspace" ? workspaceOmnigent(serverUrl) : undefined;
    const displayUrl = workspace?.pageUrl ?? serverUrl;
    const actions: RemoteActions = {
      openInBrowser: {
        label: "Open in Browser",
        run: () => void vscode.env.openExternal(vscode.Uri.parse(displayUrl)),
      },
      connectElsewhere: {
        label: "Connect to Another Server…",
        run: () => void vscode.commands.executeCommand(CONNECT_COMMAND),
      },
      retry: { label: "Retry", run: () => void this.refresh() },
    };

    if (vscode.env.remoteName) {
      this.controller.setMessage({
        title: "Remote servers aren't available in this window yet",
        detail: `This window runs on a remote machine (${vscode.env.remoteName}). Open ${host} from a local VS Code window, or in your browser.`,
        actions: [actions.openInBrowser, actions.connectElsewhere],
      });
      return;
    }
    if (workspace === null) {
      this.controller.setMessage({
        title: `${host} doesn't point at Omnigent`,
        detail: `Use the workspace's Omnigent page, https://${host}/omnigent.`,
        actions: [actions.connectElsewhere],
      });
      return;
    }

    this.controller.setResolving(`Connecting to ${host}…`);
    const setup = workspace
      ? await this.databricksWorkspaceSetup(workspace, attempt, actions)
      : kind === "databricks-app"
        ? await this.databricksAppSetup(serverUrl, attempt, actions)
        : await this.selfHostedSetup(serverUrl, attempt, actions);
    if (!setup) {
      return;
    }
    const { credentials } = setup;
    const display = new URL(displayUrl);
    const proxy = await ServerProxy.start({
      serverUrl: workspace?.apiUrl ?? serverUrl,
      authMode: setup.authMode,
      sessionCookies: setup.sessionCookies,
      credentials,
      openExternal,
      serverLabel: `${display.host}${display.pathname.replace(/\/+$/, "")}`,
      signInPrompt: setup.signInPrompt,
      localApp: setup.localApp,
      log: (message) => this.output.appendLine(message),
    });
    if (attempt !== this.attempt) {
      credentials.dispose();
      await proxy.close();
      return;
    }
    this.active = { serverUrl: displayUrl, proxy, credentials };
    this.controller.setResolved({
      baseUrl: proxy.entryUrl,
      origin: proxy.origin,
      hostType: "remote",
      source: "manual",
      displayUrl,
    });
    this.log(`connected to ${displayUrl} (${setup.description}) via ${proxy.origin}`);
    const recents = addRecentServer(this.context.globalState.get(RECENT_SERVERS_KEY), displayUrl);
    void this.context.globalState.update(RECENT_SERVERS_KEY, recents);
  }

  /** Probe a self-hosted server; undefined once the panel shows why it can't connect. */
  private async selfHostedSetup(
    serverUrl: string,
    attempt: number,
    actions: RemoteActions,
  ): Promise<RemoteSetup | undefined> {
    const host = new URL(serverUrl).host;
    const probe = await probeServer(serverUrl);
    if (attempt !== this.attempt) {
      return undefined;
    }
    if (probe.status === "unreachable") {
      this.log(`couldn't reach ${serverUrl}: ${probe.detail}`);
      this.controller.setMessage({
        title: `Couldn't reach ${host}`,
        detail: "Check the URL and your network connection, then retry.",
        actions: [actions.retry, actions.connectElsewhere],
      });
      return undefined;
    }
    if (probe.status === "not-omnigent") {
      this.controller.setMessage({
        title: `${host} doesn't look like an Omnigent server`,
        detail:
          "Check the server URL. If the server is behind a login page, open it in your browser.",
        actions: [actions.connectElsewhere, actions.openInBrowser],
      });
      return undefined;
    }
    const profile = probe.profile;
    if (profile.authMode === "header" || profile.authMode === "custom") {
      this.controller.setMessage({
        title: `VS Code can't sign in to ${host} yet`,
        detail:
          "This server signs users in through a login service in front of it, which the panel can't use. Open it in your browser instead.",
        actions: [actions.openInBrowser, actions.connectElsewhere],
      });
      return undefined;
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
    return {
      credentials,
      authMode: profile.authMode,
      sessionCookies: profile.sessionCookies,
      description: `auth=${profile.authMode}`,
    };
  }

  /**
   * Find a Databricks App's workspace and sign in with a workspace token: the
   * Databricks CLI's first, else a browser sign-in. Undefined once the panel
   * shows why it can't connect.
   */
  private async databricksAppSetup(
    serverUrl: string,
    attempt: number,
    actions: RemoteActions,
  ): Promise<RemoteSetup | undefined> {
    const host = new URL(serverUrl).host;
    const lookup = await findDatabricksWorkspace(serverUrl);
    const workspaceOrigin =
      lookup.status === "found" ? lookup.workspaceOrigin : await readCliWorkspace(serverUrl);
    if (attempt !== this.attempt) {
      return undefined;
    }
    if (!workspaceOrigin) {
      if (lookup.status === "unreachable") {
        this.log(`couldn't reach ${serverUrl}: ${lookup.detail}`);
        this.controller.setMessage({
          title: `Couldn't reach ${host}`,
          detail: "Check the URL and your network connection, then retry.",
          actions: [actions.retry, actions.connectElsewhere],
        });
      } else {
        this.controller.setMessage({
          title: `Couldn't find the Databricks workspace for ${host}`,
          detail:
            "The app didn't send VS Code to a Databricks sign-in. Check the app URL, then retry.",
          actions: [actions.retry, actions.openInBrowser, actions.connectElsewhere],
        });
      }
      return undefined;
    }
    return {
      credentials: this.databricksCredentials(serverUrl, workspaceOrigin),
      authMode: "databricks-app",
      sessionCookies: [],
      signInPrompt: {
        detail: `This app signs you in with your Databricks account on ${new URL(workspaceOrigin).host}.`,
        button: "Sign in with Databricks",
      },
      description: `databricks-app, workspace ${workspaceOrigin}`,
    };
  }

  /**
   * Serve the bundled app for Omnigent in a Databricks workspace, which signs
   * in with a workspace token like an app does. Undefined once the panel shows
   * why it can't connect.
   */
  private async databricksWorkspaceSetup(
    workspace: WorkspaceOmnigent,
    attempt: number,
    actions: RemoteActions,
  ): Promise<RemoteSetup | undefined> {
    const host = new URL(workspace.workspaceOrigin).host;
    const appDir = vscode.Uri.joinPath(this.context.extensionUri, "dist", "web-ui").fsPath;
    const [localApp, probe] = await Promise.all([
      LocalApp.load(appDir).catch(() => undefined),
      probeWorkspace(workspace.apiUrl),
    ]);
    if (attempt !== this.attempt) {
      return undefined;
    }
    if (!localApp) {
      this.log(`no bundled app at ${appDir}`);
      this.controller.setMessage({
        title: "This build of the extension can't open Databricks workspaces",
        detail:
          "It was packaged without the Omnigent app it serves for them. Run `pnpm --filter omnigent-vscode run build:web-ui`, then reload the window.",
        actions: [actions.openInBrowser, actions.connectElsewhere],
      });
      return undefined;
    }
    if (probe.status === "unreachable") {
      this.log(`couldn't reach ${workspace.apiUrl}: ${probe.detail}`);
      this.controller.setMessage({
        title: `Couldn't reach ${host}`,
        detail: "Check the URL and your network connection, then retry.",
        actions: [actions.retry, actions.connectElsewhere],
      });
      return undefined;
    }
    if (!probe.databricksRealm) {
      // Not fatal: the app shows what the API says once signed in.
      this.log(
        `${workspace.apiUrl}/v1/me answered ${probe.httpStatus} without a Databricks sign-in challenge`,
      );
    }
    return {
      credentials: this.databricksCredentials(workspace.apiUrl, workspace.workspaceOrigin),
      authMode: "databricks-workspace",
      sessionCookies: [],
      localApp,
      signInPrompt: {
        detail: `Omnigent on ${host} signs you in with your Databricks account.`,
        button: "Sign in with Databricks",
      },
      description: `databricks-workspace, ${localApp.fileCount} bundled app files`,
    };
  }

  /** Workspace-token credentials: the Databricks CLI's first, else a browser sign-in. */
  private databricksCredentials(serverUrl: string, workspaceOrigin: string): ServerCredentials {
    const log = (message: string) => this.output.appendLine(message);
    const cliTokens = new DatabricksCliTokens(workspaceOrigin, { log });
    return new ServerCredentials({
      serverUrl,
      vault: new SecretSessionVault(this.context.secrets),
      cliGate: new MementoCliReuseGate(this.context.globalState),
      readCliSession: () => cliTokens.token(),
      refresh: (grant) => refreshDatabricksGrant(workspaceOrigin, grant),
      // Signing out forgets the grant here; the workspace keeps no session for it.
      revoke: async () => undefined,
      signIn: async (signal) =>
        (await cliTokens.token()) ??
        signInWithDatabricks(workspaceOrigin, { openExternal, signal }),
      onTokenRejected: (token, rejection) => cliTokens.invalidate(token, rejection),
      log,
    });
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
