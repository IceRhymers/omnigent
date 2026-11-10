// Module exports used by the VS Code extension (editors/vscode).
export function isLoopbackServerUrl(raw: string): boolean;
export function isDatabricksManagedServerUrl(rawUrl: string | null | undefined): boolean;
export function isDatabricksOAuthServerUrl(rawUrl: string): boolean;
export function serverDisplayLabel(rawUrl: string): string;
export function parseManifestAuth(
  raw: unknown,
  serverUrl: string,
): { mode: string; sessionCookie: string | null } | null;
export function sanitizeServerName(raw: unknown): string | null;

declare global {
  var omnigentUrl: {
    normalizeUrl: (raw: string) => string;
    isPlainHttpRemote: (raw: string) => boolean;
  };
}
