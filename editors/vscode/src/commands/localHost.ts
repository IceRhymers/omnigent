/**
 * Run Omnigent from VS Code alone: start it on this computer, make this
 * computer a host on the connected server, and set up the models its sessions
 * use (e.g. Databricks Unity Gateway). Each drives the `omnigent` CLI in a task
 * terminal (cli/task.ts), so sign-in and setup prompts work as in a shell.
 */
import * as vscode from "vscode";
import { readCliSession } from "../auth/cliTokens";
import { findCli, INSTALL_COMMAND } from "../cli/locate";
import { hostOnServerSteps, setupStep, startLocalStep, type CliStep } from "../cli/steps";
import { isCliTaskRunning, runCliTask, type CliTaskResult } from "../cli/task";
import { checkServerUrl } from "../config";
import { readSettings } from "../config/vscodeSettings";
import { remoteServerKind } from "../servers/classify";
import { START_LOCAL_COMMAND, type ServerConnection } from "../servers/connection";
import type { EditorPanelController } from "../panel/EditorPanelController";
import { saveServerUrl } from "./connect";

export const HOST_HERE_COMMAND = "omnigent.hostHere";
export const SET_UP_UNITY_GATEWAY_COMMAND = "omnigent.setUpUnityGateway";

export function registerLocalHost(
  context: vscode.ExtensionContext,
  connection: ServerConnection,
  controller: EditorPanelController,
): void {
  /** Run the steps in order, stopping at the first failure; true when all succeed. */
  const run = async (steps: CliStep[], intro?: string): Promise<boolean> => {
    if (isCliTaskRunning()) {
      void vscode.window.showInformationMessage(
        "An Omnigent command is already running in the terminal.",
      );
      return false;
    }
    if (vscode.env.remoteName) {
      void vscode.window.showWarningMessage(
        `This window runs on a remote machine (${vscode.env.remoteName}). Run Omnigent from a local VS Code window.`,
      );
      return false;
    }
    const cli = await requireCli();
    if (!cli) {
      return false;
    }
    if (intro) {
      void vscode.window.showInformationMessage(intro);
    }
    for (const step of steps) {
      const result = await runCliTask(cli, step);
      if (result.status !== "succeeded") {
        void vscode.window.showErrorMessage(failureMessage(step, result));
        return false;
      }
    }
    return true;
  };

  const startLocal = async () => {
    if (await run([startLocalStep()])) {
      await saveServerUrl("", connection);
      controller.ensure();
    }
  };

  const hostHere = async () => {
    const serverUrl = connection.remoteServerUrl;
    if (serverUrl === undefined) {
      const configured = checkServerUrl(readSettings().serverUrl);
      if (configured.ok && configured.hostType === "remote") {
        void vscode.window.showWarningMessage(
          `Omnigent isn't connected to ${new URL(configured.url).host} yet. Open it in the panel, then try again.`,
        );
        return;
      }
      // On this computer's server, `omnigent start` adds this computer as its host.
      await startLocal();
      return;
    }
    const kind = remoteServerKind(serverUrl);
    const hasCliSession = kind === "self-hosted" && (await readCliSession(serverUrl)) !== undefined;
    if (await run(hostOnServerSteps(serverUrl, kind, hasCliSession))) {
      void vscode.window.showInformationMessage(
        `This computer is now a host on ${new URL(serverUrl).host}.`,
      );
    }
  };

  const setUpUnityGateway = async () => {
    const intro =
      "In the terminal, pick a coding agent, choose “+ Add a credential”, then “Databricks — workspace”, and enter your workspace URL.";
    if (await run([setupStep()], intro)) {
      void vscode.window.showInformationMessage(
        "Omnigent setup finished. New sessions use the credentials you added.",
      );
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(START_LOCAL_COMMAND, startLocal),
    vscode.commands.registerCommand(HOST_HERE_COMMAND, hostHere),
    vscode.commands.registerCommand(SET_UP_UNITY_GATEWAY_COMMAND, setUpUnityGateway),
  );
}

async function requireCli(): Promise<string | undefined> {
  const cli = findCli();
  if (cli) {
    return cli;
  }
  const copy = "Copy Install Command";
  const picked = await vscode.window.showErrorMessage(
    "The Omnigent CLI isn't installed. Install it in a terminal, then try again.",
    copy,
  );
  if (picked === copy) {
    await vscode.env.clipboard.writeText(INSTALL_COMMAND);
  }
  return undefined;
}

function failureMessage(step: CliStep, result: Exclude<CliTaskResult, { status: "succeeded" }>) {
  if (result.status === "not-started") {
    return `Omnigent: couldn't run “${step.label}” (${result.detail}). Run \`omnigent ${step.args.join(" ")}\` in a terminal instead.`;
  }
  const how =
    result.exitCode === undefined ? "was stopped" : `failed (exit code ${result.exitCode})`;
  return `Omnigent: “${step.label}” ${how}. See its terminal for details.`;
}
