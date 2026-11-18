import { describe, expect, it } from "vitest";
import { pathWithin, sessionInFolderScope } from "./scope";

const HOST_ID = "298917f54901428299dee608f20654c6";

describe("pathWithin", () => {
  it.each([
    ["/work/repo", "/work/repo", true],
    ["/work/repo", "/work/repo/src/file.ts", true],
    ["/work/repo", "/work/repo/..hidden/session", true],
    ["/work/repo", "/work/repo-other", false],
    ["/work/repo", "/work", false],
    ["/work/repo", "relative/path", false],
  ])("%s contains %s: %s", (root, candidate, expected) => {
    expect(pathWithin(root, candidate)).toBe(expected);
  });
});

describe("sessionInFolderScope", () => {
  it("requires this host and a workspace in one of the repository worktrees", () => {
    const roots = ["/work/repo", "/work/repo-worktrees/branch"];
    expect(
      sessionInFolderScope(
        { hostId: `host_${HOST_ID}`, workspace: "/work/repo-worktrees/branch/src" },
        roots,
        HOST_ID,
      ),
    ).toBe(true);
    expect(
      sessionInFolderScope({ hostId: HOST_ID, workspace: "/work/other" }, roots, HOST_ID),
    ).toBe(false);
    expect(
      sessionInFolderScope(
        { hostId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", workspace: "/work/repo" },
        roots,
        HOST_ID,
      ),
    ).toBe(false);
  });
});
