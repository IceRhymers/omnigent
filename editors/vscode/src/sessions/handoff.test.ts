import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeHandoff, handoffPath, writeHandoff } from "./handoff";

let dir: string | undefined;

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

async function storage(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "omnigent-handoff-"));
  return dir;
}

describe("session handoff", () => {
  it("hands a session to the window that has the folder open, once", async () => {
    const storageDir = await storage();
    const target = join(storageDir, "worktree");
    await writeHandoff(storageDir, { folder: target, sessionId: "abc", createdAt: 1_000 });

    await expect(consumeHandoff(storageDir, [target], () => 2_000)).resolves.toEqual({
      folder: target,
      sessionId: "abc",
      createdAt: 1_000,
    });
    expect(existsSync(handoffPath(storageDir))).toBe(false);
    await expect(consumeHandoff(storageDir, [target], () => 2_000)).resolves.toBeUndefined();
  });

  it("leaves the handoff for another folder's window", async () => {
    const storageDir = await storage();
    await writeHandoff(storageDir, { folder: "/work/wt", sessionId: "abc", createdAt: 1_000 });

    await expect(consumeHandoff(storageDir, ["/work/repo"], () => 2_000)).resolves.toBeUndefined();
    expect(existsSync(handoffPath(storageDir))).toBe(true);
    await expect(consumeHandoff(storageDir, ["/work/wt"], () => 2_000)).resolves.toMatchObject({
      sessionId: "abc",
    });
  });

  it("drops a stale or malformed handoff", async () => {
    const storageDir = await storage();
    await writeHandoff(storageDir, { folder: "/work/wt", sessionId: "abc", createdAt: 1_000 });
    await expect(consumeHandoff(storageDir, ["/work/wt"], () => 200_000)).resolves.toBeUndefined();
    expect(existsSync(handoffPath(storageDir))).toBe(false);

    await writeFile(handoffPath(storageDir), "not json", "utf8");
    await expect(consumeHandoff(storageDir, ["/work/wt"], () => 1_000)).resolves.toBeUndefined();
  });
});
