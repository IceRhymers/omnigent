/**
 * The small part of Omnigent's HTTP API used by the Sessions view. The base
 * URL is the same one the panel frames, so remote calls inherit the proxy's
 * sign-in without exposing credentials to this module.
 */
import { requestJson, serverEndpoint } from "../net/request";
import type { ServerTarget } from "../config";

const PAGE_SIZE = 200;
// Bounds each poll: the tree lists at most this many recently updated sessions.
const MAX_SESSION_PAGES = 5;
export const MAX_LISTED_SESSIONS = PAGE_SIZE * MAX_SESSION_PAGES;
// Matches the Python SDK: the server's host-launch budget can be one hour.
const CREATE_SESSION_TIMEOUT_MS = 3_660_000;

export type HarnessAvailability = boolean | string | null;

export type SessionStatus = "idle" | "running" | "waiting" | "failed";

export interface SessionSummary {
  id: string;
  title?: string;
  agentName?: string;
  harness?: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  hostId?: string;
  workspace?: string;
  gitBranch?: string;
  pendingElicitationsCount: number;
  /** Why a running agent is parked on a terminal prompt, e.g. "permission prompt". */
  blockedOn?: string;
  backgroundWorkRunning: boolean;
  viewerLastSeen?: number;
  viewerUnread: boolean;
}

export interface SessionList {
  sessions: SessionSummary[];
  /** More sessions exist beyond {@link MAX_LISTED_SESSIONS}. */
  truncated: boolean;
}

export interface HostSummary {
  id: string;
  status: "online" | "offline";
  sandboxProvider?: string;
  configuredHarnesses: Record<string, HarnessAvailability>;
}

export interface AgentSummary {
  id: string;
  name: string;
  harness?: string;
}

export interface CreateSessionInput {
  agentId: string;
  hostId: string;
  workspace: string;
}

export class OmnigentApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The server's `error.code`, e.g. "stale_cursor". */
    readonly code?: string,
  ) {
    super(message);
    this.name = "OmnigentApiError";
  }
}

export interface SessionsApiClient {
  listSessions(): Promise<SessionList>;
  listHosts(): Promise<HostSummary[]>;
  listAgents(): Promise<AgentSummary[]>;
  createSession(input: CreateSessionInput): Promise<string>;
}

export class SessionsApi implements SessionsApiClient {
  constructor(
    readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  static forTarget(target: ServerTarget): SessionsApi {
    return new SessionsApi(target.baseUrl);
  }

  /** Unarchived top-level sessions, most recently updated first. */
  async listSessions(): Promise<SessionList> {
    try {
      return await this.listSessionPages();
    } catch (error) {
      // The cursor row was archived or deleted between pages; the server can't resume from it.
      if (error instanceof OmnigentApiError && error.code === "stale_cursor") {
        return this.listSessionPages();
      }
      throw error;
    }
  }

  async listHosts(): Promise<HostSummary[]> {
    const body = await this.get("/v1/hosts");
    return arrayField(body, "hosts").map(hostFromWire).filter(isDefined);
  }

  async listAgents(): Promise<AgentSummary[]> {
    const agents: AgentSummary[] = [];
    const seenCursors = new Set<string>();
    let after: string | undefined;
    do {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (after) {
        params.set("after", after);
      }
      const body = await this.get(`/v1/agents?${params.toString()}`);
      agents.push(...arrayField(body, "data").map(agentFromWire).filter(isDefined));
      const cursor = stringField(body, "last_id");
      if (body.has_more !== true || !cursor || seenCursors.has(cursor)) {
        break;
      }
      seenCursors.add(cursor);
      after = cursor;
    } while (true);
    return agents;
  }

  async createSession(input: CreateSessionInput): Promise<string> {
    const body = await this.request("/v1/sessions", {
      method: "POST",
      // The same Origin the panel's app sends, which the proxy and server's CSRF checks accept.
      headers: { origin: new URL(this.baseUrl).origin },
      timeoutMs: CREATE_SESSION_TIMEOUT_MS,
      json: {
        agent_id: input.agentId,
        host_id: input.hostId,
        workspace: input.workspace,
      },
    });
    const id = stringField(body, "id");
    if (!id) {
      throw new OmnigentApiError("The server created a session without returning its id.", 201);
    }
    return id;
  }

  private async listSessionPages(): Promise<SessionList> {
    const sessions = new Map<string, SessionSummary>();
    let after: string | undefined;
    for (let page = 0; page < MAX_SESSION_PAGES; page++) {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        order: "desc",
        sort_by: "updated_at",
        visibility: "all",
        kind: "default",
      });
      if (after) {
        params.set("after", after);
      }
      const body = await this.get(`/v1/sessions?${params.toString()}`);
      for (const session of arrayField(body, "data").map(sessionFromWire).filter(isDefined)) {
        // A session updated between pages moves ahead of the cursor and comes back again.
        if (!sessions.has(session.id)) {
          sessions.set(session.id, session);
        }
      }
      const cursor = stringField(body, "last_id");
      if (body.has_more !== true || !cursor || cursor === after) {
        return { sessions: [...sessions.values()], truncated: false };
      }
      after = cursor;
    }
    return { sessions: [...sessions.values()], truncated: true };
  }

  private get(path: string): Promise<Record<string, unknown>> {
    return this.request(path);
  }

  private async request(
    path: string,
    options: {
      method?: "GET" | "POST";
      headers?: Record<string, string>;
      json?: unknown;
      timeoutMs?: number;
    } = {},
  ): Promise<Record<string, unknown>> {
    const response = await requestJson(serverEndpoint(this.baseUrl, path), options, this.fetchImpl);
    if (response.status < 200 || response.status >= 300) {
      throw new OmnigentApiError(
        errorMessage(response.body, response.status),
        response.status,
        errorCode(response.body),
      );
    }
    if (!response.body) {
      // Usually a sign-in or app page in place of the API; an empty result would hide it.
      throw new OmnigentApiError(
        "Omnigent answered with something other than JSON.",
        response.status,
      );
    }
    return response.body;
  }
}

function sessionFromWire(value: unknown): SessionSummary | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = stringField(value, "id");
  if (!id) {
    return undefined;
  }
  const status = value.status;
  return {
    id,
    title: stringField(value, "title"),
    agentName: stringField(value, "agent_name"),
    harness: stringField(value, "harness"),
    status: status === "running" || status === "waiting" || status === "failed" ? status : "idle",
    createdAt: numberField(value, "created_at"),
    updatedAt: numberField(value, "updated_at"),
    hostId: stringField(value, "host_id"),
    workspace: stringField(value, "workspace"),
    gitBranch: stringField(value, "git_branch"),
    pendingElicitationsCount: numberField(value, "pending_elicitations_count"),
    blockedOn: stringField(value, "blocked_on"),
    backgroundWorkRunning: value.background_work_running === true,
    viewerLastSeen: typeof value.viewer_last_seen === "number" ? value.viewer_last_seen : undefined,
    viewerUnread: value.viewer_unread === true,
  };
}

function hostFromWire(value: unknown): HostSummary | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = stringField(value, "host_id");
  if (!id) {
    return undefined;
  }
  const configured = value.configured_harnesses;
  const configuredHarnesses: Record<string, HarnessAvailability> = {};
  if (isRecord(configured)) {
    for (const [harness, availability] of Object.entries(configured)) {
      if (
        typeof availability === "boolean" ||
        typeof availability === "string" ||
        availability === null
      ) {
        configuredHarnesses[harness] = availability;
      }
    }
  }
  return {
    id,
    status: value.status === "online" ? "online" : "offline",
    sandboxProvider: stringField(value, "sandbox_provider"),
    configuredHarnesses,
  };
}

function agentFromWire(value: unknown): AgentSummary | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = stringField(value, "id");
  const name = stringField(value, "name");
  if (!id || !name) {
    return undefined;
  }
  return { id, name, harness: stringField(value, "harness") };
}

function errorMessage(body: Record<string, unknown> | null, status: number): string {
  const detail = body?.detail;
  if (typeof detail === "string" && detail.trim() !== "") {
    return detail;
  }
  const error = body?.error;
  if (typeof error === "string" && error.trim() !== "") {
    return error;
  }
  if (isRecord(error) && typeof error.message === "string" && error.message.trim() !== "") {
    return error.message;
  }
  return `Omnigent answered HTTP ${status}.`;
}

function errorCode(body: Record<string, unknown> | null): string | undefined {
  const error = body?.error;
  return isRecord(error) ? stringField(error, "code") : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function arrayField(value: Record<string, unknown>, key: string): unknown[] {
  const field = value[key];
  return Array.isArray(field) ? field : [];
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field !== "" ? field : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : 0;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
