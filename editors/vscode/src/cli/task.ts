/**
 * Run an `omnigent` command as a VS Code task: a real terminal the user can
 * watch and type into (sign-in and setup prompts need one), whose exit code
 * decides what the extension does next.
 */
import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { CliStep } from "./steps";

/** Declared under `contributes.taskDefinitions` in package.json. */
const TASK_TYPE = "omnigent";

export type CliTaskResult =
  | { status: "succeeded" }
  | { status: "failed"; exitCode: number | undefined }
  | { status: "not-started"; detail: string };

/** Whether a command this extension started is still running. */
export function isCliTaskRunning(): boolean {
  return vscode.tasks.taskExecutions.some(
    (execution) => execution.task.definition.type === TASK_TYPE,
  );
}

export function runCliTask(cliPath: string, step: CliStep): Promise<CliTaskResult> {
  const runId = randomUUID();
  const task = new vscode.Task(
    { type: TASK_TYPE, runId },
    vscode.workspace.workspaceFolders?.[0] ?? vscode.TaskScope.Global,
    step.label,
    "Omnigent",
    // Machine-wide daemons shouldn't pick up the open project's `.omnigent/` config.
    new vscode.ProcessExecution(cliPath, step.args, { cwd: homedir() }),
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    focus: true,
    clear: true,
  };
  return new Promise((resolve) => {
    let settled = false;
    const listeners: vscode.Disposable[] = [];
    const settle = (result: CliTaskResult) => {
      if (settled) {
        return;
      }
      settled = true;
      listeners.forEach((listener) => listener.dispose());
      resolve(result);
    };
    const isThisRun = (execution: vscode.TaskExecution) =>
      execution.task.definition.runId === runId;
    listeners.push(
      vscode.tasks.onDidEndTaskProcess((event) => {
        if (isThisRun(event.execution)) {
          settle(
            event.exitCode === 0
              ? { status: "succeeded" }
              : { status: "failed", exitCode: event.exitCode },
          );
        }
      }),
      // Fires after the process event, or alone when the process never started.
      vscode.tasks.onDidEndTask((event) => {
        if (isThisRun(event.execution)) {
          settle({ status: "not-started", detail: "the task ended before the command ran" });
        }
      }),
    );
    vscode.tasks.executeTask(task).then(undefined, (error: unknown) => {
      settle({
        status: "not-started",
        detail: error instanceof Error ? error.message : String(error),
      });
    });
  });
}
