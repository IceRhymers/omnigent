import { describe, expect, it } from "vitest";
import { MAX_RECENT_SERVERS, addRecentServer, readRecentServers } from "./recents";

describe("recent servers", () => {
  it("keeps valid remote URLs, normalized and de-duplicated", () => {
    expect(
      readRecentServers([
        "https://a.example.com/",
        "https://A.example.com",
        "http://127.0.0.1:6767",
        "http://insecure.example.com",
        42,
        "https://b.example.com/team",
      ]),
    ).toEqual(["https://a.example.com", "https://b.example.com/team"]);
    expect(readRecentServers("nope")).toEqual([]);
  });

  it("moves a server to the front and caps the list", () => {
    const many = Array.from({ length: 8 }, (_, index) => `https://s${index}.example.com`);
    const updated = addRecentServer(many, "https://s3.example.com");
    expect(updated[0]).toBe("https://s3.example.com");
    expect(updated).toHaveLength(MAX_RECENT_SERVERS);
    expect(new Set(updated).size).toBe(updated.length);
  });
});
