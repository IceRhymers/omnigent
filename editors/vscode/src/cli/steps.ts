/**
 * The `omnigent` invocations behind the extension's start/host/setup commands.
 * Pure, so the argument shapes are testable without running the CLI.
 */
import type { RemoteServerKind } from "../servers/classify";

export interface CliStep {
  /** Task and error-message name, e.g. "Start Omnigent". */
  label: string;
  args: string[];
}

/**
 * A local server with this computer as its host. `--server=` (one token, so no
 * empty argument is lost) forces local mode over a `server` saved in the CLI
 * config.
 */
export function startLocalStep(): CliStep {
  return { label: "Start Omnigent", args: ["start", "--server=", "--no-open"] };
}

/**
 * Make this computer a host on a remote server. `start` signs in to
 * Databricks-hosted servers itself; a self-hosted one needs `omnigent login`
 * first when the CLI has no session for it.
 */
export function hostOnServerSteps(
  serverUrl: string,
  kind: RemoteServerKind,
  hasCliSession: boolean,
): CliStep[] {
  const host = {
    label: "Connect This Computer",
    args: ["start", "--server", serverUrl, "--no-open"],
  };
  if (kind === "self-hosted" && !hasCliSession) {
    return [{ label: "Sign In to Omnigent", args: ["login", serverUrl] }, host];
  }
  return [host];
}

/** The model/credential picker, where Databricks (Unity Gateway) routing is added. */
export function setupStep(): CliStep {
  return { label: "Set Up Models", args: ["setup"] };
}
