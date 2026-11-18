/**
 * Match sessions to VS Code folders. A repository's worktrees are one folder
 * scope because sessions created on another branch live outside the checkout.
 */
import { normalizeHostId } from "./hostIdentity";
import { pathWithin } from "./worktrees";
import type { SessionSummary } from "./api";

export { pathWithin };

export function sessionInFolderScope(
  session: Pick<SessionSummary, "hostId" | "workspace">,
  roots: readonly string[],
  localHostId: string,
): boolean {
  const { workspace } = session;
  return (
    workspace !== undefined &&
    normalizeHostId(session.hostId) === normalizeHostId(localHostId) &&
    roots.some((root) => pathWithin(root, workspace))
  );
}
