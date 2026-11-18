// Types for loopback-oauth.js, which the VS Code extension also imports.

export const LOOPBACK_TIMEOUT_MS: number;

export function base64url(buf: Buffer): string;

export function escapeHtml(text: unknown): string;

export function makePkce(): { verifier: string; challenge: string };

export type LoopbackPage = [heading: string, detail: string];

export interface LoopbackAuthorizationOptions {
  hostname: string;
  callbackPath: string;
  redirectUri: (port: number) => string;
  authorizeUrl: (redirectUri: string, state: string) => string;
  openExternal: (url: string) => Promise<unknown>;
  pages: { received: LoopbackPage; failed: LoopbackPage; incomplete: LoopbackPage };
  signal?: AbortSignal;
  timeoutMs?: number;
  onOpened?: () => void;
}

export function runLoopbackAuthorization(
  options: LoopbackAuthorizationOptions,
): Promise<{ params: URLSearchParams; redirectUri: string }>;
