import { describe, expect, it } from "vitest";
import { cliCandidates, findCli, type LocateEnv } from "./locate";

function env(executables: string[], pathEnv = "/usr/bin:/bin"): LocateEnv {
  return {
    pathEnv,
    platform: "darwin",
    home: "/Users/ada",
    isExecutable: (path) => executables.includes(path),
  };
}

describe("findCli", () => {
  it("prefers omnigent anywhere on PATH over the omni alias", () => {
    const found = findCli(env(["/usr/bin/omni", "/bin/omnigent"]));
    expect(found).toBe("/bin/omnigent");
  });

  it("falls back to the omni alias on PATH", () => {
    expect(findCli(env(["/bin/omni"]))).toBe("/bin/omni");
  });

  it("finds a uv tool install a minimal GUI PATH omits", () => {
    const found = findCli(env(["/opt/homebrew/bin/omnigent", "/Users/ada/.local/bin/omnigent"]));
    expect(found).toBe("/Users/ada/.local/bin/omnigent");
  });

  it("returns undefined when the CLI isn't installed", () => {
    expect(findCli(env([]))).toBeUndefined();
  });
});

describe("cliCandidates", () => {
  it("tries .exe first on Windows and splits PATH on semicolons", () => {
    const candidates = cliCandidates({
      pathEnv: "C:\\bin;C:\\tools",
      platform: "win32",
      home: "/home/ada",
    });
    expect(candidates.slice(0, 3)).toEqual([
      expect.stringMatching(/C:\\bin.omnigent\.exe$/),
      expect.stringMatching(/C:\\bin.omnigent\.cmd$/),
      expect.stringMatching(/C:\\bin.omnigent$/),
    ]);
  });

  it("lists each path once when PATH already holds a well-known directory", () => {
    const candidates = cliCandidates({
      pathEnv: "/usr/local/bin",
      platform: "linux",
      home: "/home/ada",
    });
    expect(candidates.filter((path) => path === "/usr/local/bin/omnigent")).toHaveLength(1);
  });
});
