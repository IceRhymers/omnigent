import { describe, expect, it, vi } from "vitest";
import { hostIdentityFromConfig, normalizeHostId, readLocalHostIdentity } from "./hostIdentity";

const HOST_ID = "298917f54901428299dee608f20654c6";

describe("normalizeHostId", () => {
  it.each([
    [HOST_ID, HOST_ID],
    [`host_${HOST_ID}`, HOST_ID],
    ["298917f5-4901-4282-99de-e608f20654c6", HOST_ID],
    [HOST_ID.toUpperCase(), HOST_ID],
    ["not-a-host", undefined],
    ["host_1234", undefined],
  ])("normalizes %s", (value, expected) => {
    expect(normalizeHostId(value)).toBe(expected);
  });
});

describe("hostIdentityFromConfig", () => {
  it("reads only the root host section and accepts quoted YAML scalars", () => {
    expect(
      hostIdentityFromConfig(
        `providers:\n  host_id: not-the-machine\nhost:\n  name: "Tanner's Mac"\n  host_id: host_${HOST_ID}\nserver: https://example.com\n`,
      ),
    ).toEqual({ id: HOST_ID, name: "Tanner's Mac" });
  });

  it("returns undefined for an absent or invalid host section", () => {
    expect(hostIdentityFromConfig("providers: {}\n")).toBeUndefined();
    expect(hostIdentityFromConfig("host:\n  host_id: nope\n  name: Mac\n")).toBeUndefined();
  });
});

describe("readLocalHostIdentity", () => {
  it("prefers a complete environment override without reading the config", async () => {
    const readText = vi.fn<(path: string) => Promise<string>>();
    await expect(
      readLocalHostIdentity(
        { OMNIGENT_HOST_ID: `host_${HOST_ID}`, OMNIGENT_HOST_NAME: "Sandbox" },
        readText,
      ),
    ).resolves.toEqual({ id: HOST_ID, name: "Sandbox" });
    expect(readText).not.toHaveBeenCalled();
  });

  it("treats a half-set environment override as no identity", async () => {
    const readText = vi
      .fn<(path: string) => Promise<string>>()
      .mockResolvedValue(`host:\n  host_id: ${HOST_ID}\n  name: Mac\n`);
    await expect(
      readLocalHostIdentity({ OMNIGENT_HOST_ID: HOST_ID }, readText),
    ).resolves.toBeUndefined();
    expect(readText).not.toHaveBeenCalled();
  });
});
