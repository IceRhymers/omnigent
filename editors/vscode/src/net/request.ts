/**
 * Back-channel HTTP helper for server probes and sign-in calls.
 *
 * Never follows redirects: these endpoints answer JSON, so a 3xx (usually a
 * login proxy) must not carry a code, verifier, or refresh token anywhere else.
 */

export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

export interface JsonRequest {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** Sent as application/x-www-form-urlencoded. */
  form?: Record<string, string>;
  /** Sent as application/json. */
  json?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface JsonResponse {
  status: number;
  headers: Headers;
  /** The parsed body when it is a JSON object, else null. */
  body: Record<string, unknown> | null;
}

/** The request never got an HTTP answer (DNS, TLS, refused, timed out). */
export class NetworkError extends Error {
  constructor(
    message: string,
    readonly timedOut: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "NetworkError";
  }
}

export async function requestJson(
  url: string,
  request: JsonRequest = {},
  fetchImpl: typeof fetch = fetch,
): Promise<JsonResponse> {
  const headers: Record<string, string> = { Accept: "application/json", ...request.headers };
  let body: string | undefined;
  if (request.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(request.form).toString();
  } else if (request.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(request.json);
  }
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const onCallerAbort = () => timeout.abort();
  request.signal?.addEventListener("abort", onCallerAbort, { once: true });
  try {
    request.signal?.throwIfAborted();
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: request.method ?? (body === undefined ? "GET" : "POST"),
        headers,
        body,
        redirect: "manual",
        signal: timeout.signal,
      });
    } catch (error) {
      request.signal?.throwIfAborted();
      const timedOut = timeout.signal.aborted;
      throw new NetworkError(
        timedOut
          ? `timed out reaching ${new URL(url).host}`
          : `could not reach ${new URL(url).host}`,
        timedOut,
        { cause: error },
      );
    }
    let parsed: unknown = null;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.toLowerCase().includes("json")) {
      try {
        parsed = await response.json();
      } catch {
        // A malformed JSON answer is judged by its status alone.
      }
    }
    return {
      status: response.status,
      headers: response.headers,
      body:
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null,
    };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onCallerAbort);
  }
}

/** Join a server base URL (no trailing slash) and an absolute route path. */
export function serverEndpoint(serverUrl: string, routePath: string): string {
  return `${serverUrl.replace(/\/+$/, "")}${routePath}`;
}
