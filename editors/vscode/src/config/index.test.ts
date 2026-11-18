import { describe, it, expect } from "vitest";
import { checkServerUrl, resolveServerTarget, hostTypeOf, originOf } from "./index";

describe("hostTypeOf", () => {
  it.each([
    ["http://127.0.0.1:6767", "local"],
    ["http://localhost:6767", "local"],
    ["http://[::1]:6767", "local"],
    ["https://omnigent.example.com", "remote"],
    ["https://dbc-abc123.cloud.databricks.com", "remote"],
    ["not a url", "unknown"],
  ])("classifies %s as %s", (url, expected) => {
    expect(hostTypeOf(url)).toBe(expected);
  });
});

describe("originOf", () => {
  it("strips path and trailing slash", () => {
    expect(originOf("http://127.0.0.1:6767/app/")).toBe("http://127.0.0.1:6767");
  });
});

describe("checkServerUrl", () => {
  it.each([
    ["omnigent.example.com", "https://omnigent.example.com", "remote"],
    ["localhost:6767/", "http://localhost:6767", "local"],
    ["  https://Omnigent.Example.com:443/a//  ", "https://omnigent.example.com/a", "remote"],
  ])("normalizes %s", (raw, url, hostType) => {
    expect(checkServerUrl(raw)).toEqual({ ok: true, url, hostType });
  });

  it.each([
    ["", "empty"],
    ["ftp://omnigent.example.com", "invalid-url"],
    ["https://user:pass@omnigent.example.com", "invalid-url"],
    ["http://omnigent.example.com", "insecure-remote"],
  ])("rejects %j as %s", (raw, reason) => {
    expect(checkServerUrl(raw)).toEqual({ ok: false, reason });
  });
});

describe("resolveServerTarget", () => {
  it("manual loopback override wins over discovered local", () => {
    const r = resolveServerTarget(
      { serverUrl: "http://127.0.0.1:9000" },
      { found: true, baseUrl: "http://127.0.0.1:6767", health: "ok" },
    );
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") {
      expect(r.target.source).toBe("manual");
      expect(r.target.hostType).toBe("local");
      expect(r.target.origin).toBe("http://127.0.0.1:9000");
    }
  });

  it("resolves a manual https override to a remote server, keeping its mount path", () => {
    const r = resolveServerTarget(
      { serverUrl: "https://omnigent.example.com/team/?x=1" },
      { found: true, baseUrl: "http://127.0.0.1:6767", health: "ok" },
    );
    expect(r).toEqual({
      status: "remote",
      serverUrl: "https://omnigent.example.com/team",
      kind: "self-hosted",
    });
  });

  it.each([
    ["https://my-app-123.aws.databricksapps.com", "databricks-app"],
    ["https://dbc-abc123.cloud.databricks.com", "databricks-workspace"],
    ["https://adb-1.2.azuredatabricks.net", "databricks-workspace"],
  ])("recognizes %s as %s", (serverUrl, kind) => {
    const r = resolveServerTarget({ serverUrl }, { found: false });
    expect(r).toEqual({ status: "remote", serverUrl, kind });
  });

  it("rejects a plain-http remote override", () => {
    const r = resolveServerTarget({ serverUrl: "http://omnigent.example.com" }, { found: false });
    expect(r).toEqual({ status: "needs-prompt", reason: "insecure-remote" });
  });

  it("rejects a malformed manual override", () => {
    const r = resolveServerTarget({ serverUrl: "not a url" }, { found: false });
    expect(r).toEqual({ status: "needs-prompt", reason: "invalid-url" });
  });

  it("uses discovered local when healthy and no manual override", () => {
    const r = resolveServerTarget(
      { serverUrl: "" },
      { found: true, baseUrl: "http://127.0.0.1:6767", health: "ok" },
    );
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") {
      expect(r.target.source).toBe("discovered");
      expect(r.target.hostType).toBe("local");
      expect(r.target.baseUrl).toBe("http://127.0.0.1:6767");
    }
  });

  it("needs-prompt when discovered local is unhealthy", () => {
    const r = resolveServerTarget(
      { serverUrl: "" },
      { found: true, baseUrl: "http://127.0.0.1:6767", health: "timeout" },
    );
    expect(r).toEqual({ status: "needs-prompt", reason: "local-unhealthy" });
  });

  it("needs-prompt when nothing is available", () => {
    const r = resolveServerTarget({ serverUrl: "" }, { found: false });
    expect(r).toEqual({ status: "needs-prompt", reason: "no-manual-no-local" });
  });
});
