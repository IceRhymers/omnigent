import { describe, expect, it } from "vitest";
import type { AgentSummary, HostSummary } from "./api";
import { harnessChoices, relativeTime, sessionHarnessLabel, sessionTitle } from "./harnesses";

const HOST: HostSummary = {
  id: "host",
  status: "online",
  configuredHarnesses: {
    "claude-native": true,
    "codex-native": "version-too-low",
    "pi-native": "needs-auth",
    "opencode-native": "cli-unresponsive",
  },
};

const AGENTS: AgentSummary[] = [
  { id: "codex-id", name: "codex-native-ui", harness: "codex-native" },
  { id: "pi-id", name: "pi-native-ui", harness: "pi-native" },
  { id: "claude-id", name: "claude-native-ui", harness: "claude-native" },
  { id: "opencode-id", name: "opencode-native-ui", harness: "opencode-native" },
  { id: "custom-id", name: "my-composed-agent", harness: "claude-sdk" },
];

describe("harnessChoices", () => {
  it("offers known harnesses, puts available and last-used first, and explains unavailable ones", () => {
    const choices = harnessChoices(AGENTS, HOST, "claude-id");
    expect(choices.map((choice) => choice.label)).toEqual([
      "Claude Code",
      "OpenCode",
      "Codex",
      "Pi",
    ]);
    expect(choices[0]).toMatchObject({ agentId: "claude-id", available: true });
    expect(choices[1]).toMatchObject({
      agentId: "opencode-id",
      available: true,
      warning: "CLI did not respond to a version check",
    });
    expect(choices[2]).toMatchObject({
      available: false,
      unavailableReason: "CLI update required",
    });
    expect(choices[3]).toMatchObject({ available: false, unavailableReason: "sign-in required" });
  });

  it("allows every harness when the host has no readiness report", () => {
    const choices = harnessChoices(AGENTS, { ...HOST, configuredHarnesses: {} });
    expect(choices.every((choice) => choice.available)).toBe(true);
  });

  it("marks an omitted harness unavailable in a nonempty readiness report", () => {
    const choices = harnessChoices(AGENTS, {
      ...HOST,
      configuredHarnesses: { "claude-native": true },
    });
    expect(choices.find((choice) => choice.agentId === "claude-id")?.available).toBe(true);
    expect(choices.find((choice) => choice.agentId === "codex-id")).toMatchObject({
      available: false,
      unavailableReason: "Not configured on this host",
    });
  });
});

describe("session labels", () => {
  it("uses native agent and harness labels", () => {
    expect(sessionHarnessLabel({ agentName: "claude-native-ui" })).toBe("Claude Code");
    expect(sessionHarnessLabel({ harness: "codex-native" })).toBe("Codex");
    expect(sessionHarnessLabel({ agentName: "custom-agent" })).toBe("custom-agent");
  });

  it("provides an untitled fallback", () => {
    expect(sessionTitle({ title: "  " })).toBe("Untitled session");
    expect(sessionTitle({ title: "Fix the sidebar" })).toBe("Fix the sidebar");
  });
});

describe("relativeTime", () => {
  it("formats compact ages from epoch seconds", () => {
    const now = 1_000_000_000_000;
    expect(relativeTime(now / 1000 - 30, now)).toBe("now");
    expect(relativeTime(now / 1000 - 120, now)).toBe("2m ago");
    expect(relativeTime(now / 1000 - 7_200, now)).toBe("2h ago");
    expect(relativeTime(now / 1000 - 172_800, now)).toBe("2d ago");
    expect(relativeTime(0, now)).toBe("");
  });
});
