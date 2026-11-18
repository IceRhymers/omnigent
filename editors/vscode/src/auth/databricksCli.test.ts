/**
 * Reuse of the Databricks CLI's workspace sign-in: which profiles are tried,
 * how `databricks auth token` output is read, and when a token is minted again.
 */
import { describe, expect, it, vi } from "vitest";
import { REFRESH_MARGIN_MS } from "./credentials";
import {
  DatabricksCliTokens,
  cliProfilesForWorkspace,
  cliTokenFrom,
  databricksConfigPath,
  parseDatabricksConfig,
  type CliRun,
} from "./databricksCli";

const WORKSPACE = "https://dbc-1.cloud.databricks.com";
const NOW = Date.parse("2026-11-10T12:00:00Z");

const minted = (token: string, expiresIn = 3600): CliRun => ({
  ok: true,
  missing: false,
  stdout: JSON.stringify({ access_token: token, expires_in: expiresIn }),
  stderr: "",
});
const signedOut: CliRun = {
  ok: false,
  missing: false,
  stdout: "",
  stderr: "Error: cache: token not found\nmore detail",
};
const WORK_PROFILE = `[work]\nhost = ${WORKSPACE}\nauth_type = databricks-cli\n`;

describe("cliProfilesForWorkspace", () => {
  const config = parseDatabricksConfig(`
; profiles written by databricks auth login
[DEFAULT]
host = https://dbc-1.cloud.databricks.com/
auth_type = databricks-cli

[work]
host = DBC-1.cloud.databricks.com
auth_type = databricks-cli

[inherits-host]
auth_type: databricks-cli

[pat]
host = ${WORKSPACE}
token = dapi-secret

[elsewhere]
host = https://dbc-2.cloud.databricks.com
auth_type = databricks-cli
`);

  it("lists the workspace's databricks-cli profiles in file order, [DEFAULT] last", () => {
    expect(cliProfilesForWorkspace(config, WORKSPACE, {})).toEqual([
      "work",
      "inherits-host",
      "DEFAULT",
    ]);
  });

  it("tries DATABRICKS_CONFIG_PROFILE first only when it names one of them", () => {
    expect(
      cliProfilesForWorkspace(config, WORKSPACE, { DATABRICKS_CONFIG_PROFILE: "inherits-host" }),
    ).toEqual(["inherits-host", "work", "DEFAULT"]);
    expect(
      cliProfilesForWorkspace(config, WORKSPACE, { DATABRICKS_CONFIG_PROFILE: "elsewhere" }),
    ).toEqual(["work", "inherits-host", "DEFAULT"]);
  });

  it("reads the config path from the environment", () => {
    expect(databricksConfigPath({ DATABRICKS_CONFIG_FILE: "/etc/dbx.cfg" })).toBe("/etc/dbx.cfg");
    expect(databricksConfigPath({})).toMatch(/\.databrickscfg$/);
  });
});

describe("cliTokenFrom", () => {
  it("trusts the absolute expiry over the CLI's fixed expires_in", () => {
    const stdout = JSON.stringify({
      access_token: "tok",
      expiry: "2026-11-10T12:10:00.123456789Z",
      expires_in: 3600,
    });
    expect(cliTokenFrom(stdout, NOW)).toEqual({
      token: "tok",
      expiresAt: Date.parse("2026-11-10T12:10:00.123Z"),
    });
  });

  it("falls back to expires_in, then to an assumed lifetime", () => {
    expect(cliTokenFrom('{"access_token":"tok","expires_in":"600"}', NOW)?.expiresAt).toBe(
      NOW + 600_000,
    );
    expect(cliTokenFrom('{"access_token":"tok","expires_in":""}', NOW)?.expiresAt).toBe(
      NOW + 50 * 60_000,
    );
  });

  it("reads output without a token as nothing", () => {
    for (const stdout of ["", "not json", "[]", "null", '{"access_token":""}', '{"token":"x"}']) {
      expect(cliTokenFrom(stdout, NOW)).toBeUndefined();
    }
  });
});

describe("DatabricksCliTokens", () => {
  it("tries the workspace's profiles, then the host lookup", async () => {
    const run = vi.fn(async (args: string[]) =>
      args.includes("--host") ? minted("host") : signedOut,
    );
    const log = vi.fn();
    const tokens = new DatabricksCliTokens(WORKSPACE, {
      run,
      readConfig: async () => WORK_PROFILE,
      env: {},
      now: () => NOW,
      log,
    });
    expect((await tokens.token())?.token).toBe("host");
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ["auth", "token", "--profile", "work", "--output", "json"],
      ["auth", "token", "--host", WORKSPACE, "--output", "json"],
    ]);
    expect(log).toHaveBeenCalledWith(
      "[omnigent] databricks auth token --profile work failed: Error: cache: token not found",
    );
  });

  it("stops at a missing CLI", async () => {
    const run = vi.fn(async (): Promise<CliRun> => ({ ...signedOut, missing: true }));
    const log = vi.fn();
    const tokens = new DatabricksCliTokens(WORKSPACE, {
      run,
      readConfig: async () => WORK_PROFILE,
      env: {},
      log,
    });
    expect(await tokens.token()).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("[omnigent] the Databricks CLI isn't installed");
  });

  it("mints once for concurrent callers and again only near expiry", async () => {
    let clock = NOW;
    let mints = 0;
    const run = vi.fn(async () => minted(`tok-${++mints}`, 600));
    const tokens = new DatabricksCliTokens(WORKSPACE, {
      run,
      readConfig: async () => undefined,
      env: {},
      now: () => clock,
    });
    const [first, second] = await Promise.all([tokens.token(), tokens.token()]);
    expect([first?.token, second?.token]).toEqual(["tok-1", "tok-1"]);
    clock += 600_000 - REFRESH_MARGIN_MS - 1;
    expect((await tokens.token())?.token).toBe("tok-1");
    clock += 2;
    expect((await tokens.token())?.token).toBe("tok-2");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("mints again after a refusal, but never hands out a token refused for sign-in", async () => {
    const run = vi.fn(async () => minted("cached"));
    const tokens = new DatabricksCliTokens(WORKSPACE, {
      run,
      readConfig: async () => undefined,
      env: {},
      now: () => NOW,
    });
    expect((await tokens.token())?.token).toBe("cached");
    tokens.invalidate("cached", "forbidden");
    expect((await tokens.token())?.token).toBe("cached");
    expect(run).toHaveBeenCalledTimes(2);
    tokens.invalidate("cached", "sign-in");
    expect(await tokens.token()).toBeUndefined();
    run.mockResolvedValue(minted("renewed"));
    expect((await tokens.token())?.token).toBe("renewed");
  });
});
