/** Harness labels, availability, and picker ordering shared by sessions UI. */
import type { AgentSummary, HarnessAvailability, HostSummary, SessionSummary } from "./api";

interface HarnessPresentation {
  label: string;
  rank: number;
}

const HARNESSES: Record<string, HarnessPresentation> = {
  "claude-native-ui": { label: "Claude Code", rank: 0 },
  "codex-native-ui": { label: "Codex", rank: 1 },
  "opencode-native-ui": { label: "OpenCode", rank: 2 },
  "cursor-native-ui": { label: "Cursor", rank: 3 },
  "pi-native-ui": { label: "Pi", rank: 4 },
  "kiro-native-ui": { label: "Kiro", rank: 5 },
  "antigravity-native-ui": { label: "Antigravity", rank: 6 },
  "qwen-native-ui": { label: "Qwen Code", rank: 7 },
  "kimi-native-ui": { label: "Kimi", rank: 8 },
  "goose-native-ui": { label: "Goose", rank: 9 },
  "hermes-native-ui": { label: "Hermes", rank: 10 },
  "devin-native-ui": { label: "Devin", rank: 11 },
  grok: { label: "Grok Build", rank: 12 },
  jcode: { label: "Jcode", rank: 13 },
};

const HARNESS_LABELS: Record<string, string> = {
  "claude-native": "Claude Code",
  "claude-sdk": "Claude SDK",
  "codex-native": "Codex",
  codex: "Codex",
  "opencode-native": "OpenCode",
  "cursor-native": "Cursor",
  "pi-native": "Pi",
  "kiro-native": "Kiro",
  "antigravity-native": "Antigravity",
  "qwen-native": "Qwen Code",
  "kimi-native": "Kimi",
  "goose-native": "Goose",
  "hermes-native": "Hermes",
  "devin-native": "Devin",
};

export interface HarnessChoice {
  agentId: string;
  label: string;
  available: boolean;
  unavailableReason?: string;
  /** Advisory readiness detail; the harness can still be selected. */
  warning?: string;
  rank: number;
}

export function harnessChoices(
  agents: readonly AgentSummary[],
  host: HostSummary,
  lastUsedAgentId?: string,
): HarnessChoice[] {
  const choices = agents.flatMap((agent): HarnessChoice[] => {
    const presentation = HARNESSES[agent.name];
    if (!presentation) {
      return [];
    }
    const availability = agent.harness ? host.configuredHarnesses[agent.harness] : undefined;
    const readiness = availabilityState(
      availability,
      Object.keys(host.configuredHarnesses).length > 0,
    );
    return [
      {
        agentId: agent.id,
        label: presentation.label,
        available: agent.harness !== undefined && readiness.unavailableReason === undefined,
        unavailableReason:
          agent.harness === undefined ? "Harness unavailable" : readiness.unavailableReason,
        warning: readiness.warning,
        rank: presentation.rank,
      },
    ];
  });
  return choices.sort(
    (first, second) =>
      Number(second.available) - Number(first.available) ||
      Number(second.agentId === lastUsedAgentId) - Number(first.agentId === lastUsedAgentId) ||
      first.rank - second.rank,
  );
}

export function sessionHarnessLabel(
  session: Pick<SessionSummary, "agentName" | "harness">,
): string | undefined {
  if (session.agentName && HARNESSES[session.agentName]) {
    return HARNESSES[session.agentName].label;
  }
  if (session.harness && HARNESS_LABELS[session.harness]) {
    return HARNESS_LABELS[session.harness];
  }
  return session.agentName ?? session.harness;
}

export function sessionTitle(session: Pick<SessionSummary, "title">): string {
  return session.title?.trim() || "Untitled session";
}

/** Compact relative time for epoch-second API timestamps. */
export function relativeTime(epochSeconds: number, nowMs = Date.now()): string {
  if (epochSeconds <= 0) {
    return "";
  }
  const elapsedSeconds = Math.max(0, Math.floor(nowMs / 1000 - epochSeconds));
  if (elapsedSeconds < 60) {
    return "now";
  }
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days}d ago`;
  }
  const months = Math.floor(days / 30);
  if (months < 12) {
    return `${months}mo ago`;
  }
  return `${Math.floor(days / 365)}y ago`;
}

function availabilityState(
  availability: HarnessAvailability | undefined,
  hasReadinessReport: boolean,
): { unavailableReason?: string; warning?: string } {
  // Older hosts report no readiness at all; an omitted row in a real report is
  // an unsupported harness, but an unresponsive version probe is only advisory.
  if (availability === undefined) {
    return hasReadinessReport ? { unavailableReason: "Not configured on this host" } : {};
  }
  if (availability === true || availability === null) {
    return {};
  }
  if (availability === "cli-unresponsive") {
    return { warning: "CLI did not respond to a version check" };
  }
  if (availability === false || availability === "binary-missing") {
    return { unavailableReason: "CLI is not installed" };
  }
  switch (availability) {
    case "needs-auth":
      return { unavailableReason: "sign-in required" };
    case "version-too-low":
      return { unavailableReason: "CLI update required" };
    case "tmux-unavailable":
      return { unavailableReason: "tmux is unavailable" };
    default:
      return { unavailableReason: availability.replaceAll("-", " ") };
  }
}
