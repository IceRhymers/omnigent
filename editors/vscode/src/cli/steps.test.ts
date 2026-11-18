import { describe, expect, it } from "vitest";
import { hostOnServerSteps, startLocalStep } from "./steps";

describe("startLocalStep", () => {
  it("forces local mode with a single --server= token", () => {
    expect(startLocalStep().args).toEqual(["start", "--server=", "--no-open"]);
  });
});

describe("hostOnServerSteps", () => {
  const hostArgs = (serverUrl: string) => ["start", "--server", serverUrl, "--no-open"];

  it("signs in to a self-hosted server the CLI has no session for", () => {
    const steps = hostOnServerSteps("https://omnigent.example.com", "self-hosted", false);
    expect(steps.map((step) => step.args)).toEqual([
      ["login", "https://omnigent.example.com"],
      hostArgs("https://omnigent.example.com"),
    ]);
  });

  it("reuses the CLI's session for a self-hosted server", () => {
    const steps = hostOnServerSteps("https://omnigent.example.com", "self-hosted", true);
    expect(steps.map((step) => step.args)).toEqual([hostArgs("https://omnigent.example.com")]);
  });

  it.each([
    ["https://my-app-123.aws.databricksapps.com", "databricks-app"],
    ["https://dbc-abc123.cloud.databricks.com/omnigent", "databricks-workspace"],
  ] as const)("lets `start` sign in to %s itself", (serverUrl, kind) => {
    const steps = hostOnServerSteps(serverUrl, kind, false);
    expect(steps.map((step) => step.args)).toEqual([hostArgs(serverUrl)]);
  });
});
