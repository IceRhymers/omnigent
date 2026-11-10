import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { cliSessionFrom, cliTokensPath, readCliSession } from "./cliTokens";

describe("cliTokensPath", () => {
  it("uses OMNIGENT_DATA_DIR, expanding ~, else ~/.omnigent", () => {
    expect(cliTokensPath({ OMNIGENT_DATA_DIR: "/data" })).toBe(join("/data", "auth_tokens.json"));
    expect(cliTokensPath({ OMNIGENT_DATA_DIR: "~/omni" })).toBe(
      join(homedir(), "omni", "auth_tokens.json"),
    );
    expect(cliTokensPath({})).toBe(join(homedir(), ".omnigent", "auth_tokens.json"));
  });
});

describe("cliSessionFrom", () => {
  const file = {
    "https://omnigent.example.com": {
      token: "jwt",
      expires_at: 1_800_000_000,
      refresh_token: "grant",
      user_id: "u1",
    },
    "https://dbc-1.cloud.databricks.com": { type: "databricks", profile: "DEFAULT" },
  };

  it("finds a server's entry by its URL without a trailing slash", () => {
    expect(cliSessionFrom(file, "https://omnigent.example.com/")).toEqual({
      token: "jwt",
      expiresAt: 1_800_000_000_000,
      refreshToken: "grant",
      userId: "u1",
    });
  });

  it("reads pointer entries, unknown servers, and junk as nothing stored", () => {
    expect(cliSessionFrom(file, "https://dbc-1.cloud.databricks.com")).toBeUndefined();
    expect(cliSessionFrom(file, "https://other.example.com")).toBeUndefined();
    expect(cliSessionFrom([], "https://omnigent.example.com")).toBeUndefined();
    expect(cliSessionFrom(null, "https://omnigent.example.com")).toBeUndefined();
  });
});

describe("readCliSession", () => {
  it("reads the file and treats a missing or corrupt file as nothing stored", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omnigent-cli-tokens-"));
    try {
      const path = join(dir, "auth_tokens.json");
      expect(await readCliSession("https://omnigent.example.com", path)).toBeUndefined();
      await writeFile(path, JSON.stringify({ "https://omnigent.example.com": { token: "t" } }));
      expect(await readCliSession("https://omnigent.example.com", path)).toEqual({ token: "t" });
      await writeFile(path, "{not json");
      expect(await readCliSession("https://omnigent.example.com", path)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
