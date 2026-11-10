/**
 * Read-only reuse of the Databricks CLI's workspace sign-in, minted with
 * `databricks auth token` the way the Omnigent CLI does it
 * (omnigent/inner/databricks_executor.py): `databricks-cli` profiles pinned to
 * the workspace in `~/.databrickscfg` first, because the CLI's host-keyed
 * lookup can miss a profile's grant, then that host-keyed lookup.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionCredential } from "./cliTokens";
import { REFRESH_MARGIN_MS, type TokenRejection } from "./credentials";

const CLI_TIMEOUT_MS = 30_000;
/** Lifetime assumed when the CLI reports no expiry. */
const DEFAULT_TOKEN_TTL_MS = 50 * 60_000;
/** Refused tokens remembered so the CLI's cached copy isn't sent again. */
const MAX_REFUSED_TOKENS = 8;

export interface CliRun {
  ok: boolean;
  /** The `databricks` executable isn't installed (or not on PATH). */
  missing: boolean;
  stdout: string;
  stderr: string;
}

export type RunDatabricksCli = (args: string[]) => Promise<CliRun>;

/** Config sections by name; keys are lower-cased like ConfigParser's. */
export type DatabricksConfig = Map<string, Record<string, string>>;

/** `$DATABRICKS_CONFIG_FILE`, else `~/.databrickscfg`. */
export function databricksConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DATABRICKS_CONFIG_FILE?.trim();
  return configured
    ? configured.replace(/^~(?=$|[\\/])/, homedir())
    : join(homedir(), ".databrickscfg");
}

/** Parse the INI-style config file. Pure. */
export function parseDatabricksConfig(text: string): DatabricksConfig {
  const sections: DatabricksConfig = new Map();
  let current: Record<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      const name = header[1].trim();
      current = sections.get(name) ?? {};
      sections.set(name, current);
      continue;
    }
    const separator = line.search(/[=:]/);
    if (current && separator > 0) {
      current[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
    }
  }
  return sections;
}

/**
 * The `databricks-cli` profiles for a workspace, in the order to try them:
 * `DATABRICKS_CONFIG_PROFILE` first, then file order with `[DEFAULT]` last.
 * A section without its own `host` inherits `[DEFAULT]`'s. Pure.
 */
export function cliProfilesForWorkspace(
  config: DatabricksConfig,
  workspaceOrigin: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const wanted = hostKey(workspaceOrigin);
  const defaults = config.get("DEFAULT");
  const signsInWithCli = (name: string, host: string | undefined): boolean =>
    host !== undefined &&
    hostKey(host) === wanted &&
    (config.get(name)?.auth_type ?? "").trim().toLowerCase() === "databricks-cli";
  const matches = [...config.entries()]
    .filter(
      ([name, options]) =>
        name !== "DEFAULT" && signsInWithCli(name, options.host ?? defaults?.host),
    )
    .map(([name]) => name);
  if (defaults && signsInWithCli("DEFAULT", defaults.host)) {
    matches.push("DEFAULT");
  }
  const preferred = env.DATABRICKS_CONFIG_PROFILE?.trim();
  return preferred && matches.includes(preferred)
    ? [preferred, ...matches.filter((name) => name !== preferred)]
    : matches;
}

/**
 * Read `databricks auth token --output json`. Pure.
 *
 * The absolute `expiry` is authoritative: the CLI keeps `expires_in` at the
 * original lifetime however old its cached token is, so that may only shorten it.
 */
export function cliTokenFrom(stdout: string, now: number): SessionCredential | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const token = typeof record.access_token === "string" ? record.access_token.trim() : "";
  if (token === "") {
    return undefined;
  }
  const candidates: number[] = [];
  if (typeof record.expiry === "string") {
    const parsed = Date.parse(record.expiry);
    if (!Number.isNaN(parsed)) {
      candidates.push(parsed);
    }
  }
  const expiresIn =
    typeof record.expires_in === "string" && record.expires_in.trim() !== ""
      ? Number(record.expires_in)
      : record.expires_in;
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn)) {
    candidates.push(now + Math.max(expiresIn, 0) * 1000);
  }
  return {
    token,
    expiresAt: candidates.length > 0 ? Math.min(...candidates) : now + DEFAULT_TOKEN_TTL_MS,
  };
}

export function runDatabricksCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<CliRun> {
  return new Promise((resolve) => {
    execFile(
      "databricks",
      args,
      { env, timeout: CLI_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: error === null,
          missing: (error as NodeJS.ErrnoException | null)?.code === "ENOENT",
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

export interface DatabricksCliTokensOptions {
  run?: RunDatabricksCli;
  /** The config file's text, or undefined when there is none. */
  readConfig?(): Promise<string | undefined>;
  env?: NodeJS.ProcessEnv;
  now?(): number;
  log?(message: string): void;
}

/**
 * The Databricks CLI's token for one workspace: minted one at a time, reused
 * until near expiry, and never handed out again once the app refused it.
 */
export class DatabricksCliTokens {
  private cached: SessionCredential | undefined;
  private pending: Promise<SessionCredential | undefined> | undefined;
  private readonly refused: string[] = [];

  constructor(
    private readonly workspaceOrigin: string,
    private readonly options: DatabricksCliTokensOptions = {},
  ) {}

  /** A usable token, or undefined when the CLI is missing or signed out. Never throws. */
  async token(): Promise<SessionCredential | undefined> {
    const now = this.options.now?.() ?? Date.now();
    if (this.cached && (this.cached.expiresAt ?? Infinity) - now > REFRESH_MARGIN_MS) {
      return this.cached;
    }
    this.pending ??= this.mint().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  /**
   * The app refused this token; mint again next time. Only a sign-in refusal
   * rules the token out: a 403 can also mean the user lacks access to the app.
   */
  invalidate(token: string, rejection: TokenRejection): void {
    if (this.cached?.token === token) {
      this.cached = undefined;
    }
    if (rejection === "sign-in" && !this.refused.includes(token)) {
      this.refused.push(token);
      this.refused.splice(0, Math.max(0, this.refused.length - MAX_REFUSED_TOKENS));
    }
  }

  private async mint(): Promise<SessionCredential | undefined> {
    const session = await this.mintFromCli().catch(() => undefined);
    if (session && this.refused.includes(session.token)) {
      this.log("the Databricks CLI still holds a token the app refused");
      this.cached = undefined;
      return undefined;
    }
    this.cached = session;
    return session;
  }

  private async mintFromCli(): Promise<SessionCredential | undefined> {
    const env = this.options.env ?? process.env;
    const run = this.options.run ?? ((args: string[]) => runDatabricksCli(args, env));
    const readConfig =
      this.options.readConfig ?? (() => readFile(databricksConfigPath(env), "utf8"));
    const text = await readConfig().catch(() => undefined);
    const profiles =
      text === undefined
        ? []
        : cliProfilesForWorkspace(parseDatabricksConfig(text), this.workspaceOrigin, env);
    const selectors = [
      ...profiles.map((profile) => ["--profile", profile]),
      ["--host", this.workspaceOrigin],
    ];
    for (const selector of selectors) {
      const result = await run(["auth", "token", ...selector, "--output", "json"]);
      if (result.missing) {
        this.log("the Databricks CLI isn't installed");
        return undefined;
      }
      const session = result.ok
        ? cliTokenFrom(result.stdout, this.options.now?.() ?? Date.now())
        : undefined;
      if (session) {
        return session;
      }
      this.log(`databricks auth token ${selector.join(" ")} failed: ${firstLine(result.stderr)}`);
    }
    return undefined;
  }

  private log(message: string): void {
    this.options.log?.(`[omnigent] ${message}`);
  }
}

/** The form in which two workspace hosts compare equal: no scheme, case, or trailing slash. */
function hostKey(host: string): string {
  const trimmed = host.trim().replace(/\/+$/, "");
  const scheme = trimmed.indexOf("://");
  return (scheme < 0 ? trimmed : trimmed.slice(scheme + 3)).toLowerCase();
}

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  return line === "" ? "no output" : line.slice(0, 200);
}
