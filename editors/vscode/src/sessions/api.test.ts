import { describe, expect, it, vi } from "vitest";
import { OmnigentApiError, SessionsApi } from "./api";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("SessionsApi", () => {
  it("lists every session page and normalizes the fields the tree uses", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          object: "list",
          data: [
            {
              id: "conv_one",
              title: "First",
              agent_name: "codex-native-ui",
              status: "running",
              created_at: 10,
              updated_at: 20,
              host_id: "host_abc",
              workspace: "/work/repo",
              pending_elicitations_count: 1,
              blocked_on: "permission prompt",
              background_work_running: true,
              viewer_last_seen: 15,
              viewer_unread: true,
            },
          ],
          has_more: true,
          last_id: "conv_one",
        }),
      )
      .mockResolvedValueOnce(
        json({
          object: "list",
          data: [{ id: "conv_two", status: "idle", created_at: 5, updated_at: 6 }],
          has_more: false,
          last_id: "conv_two",
        }),
      );
    const api = new SessionsApi("http://127.0.0.1:5000/secret/", fetchImpl);

    const { sessions, truncated } = await api.listSessions();

    expect(truncated).toBe(false);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      id: "conv_one",
      agentName: "codex-native-ui",
      status: "running",
      workspace: "/work/repo",
      pendingElicitationsCount: 1,
      blockedOn: "permission prompt",
      backgroundWorkRunning: true,
      viewerLastSeen: 15,
      viewerUnread: true,
    });
    expect(sessions[1]).toMatchObject({ backgroundWorkRunning: false, viewerLastSeen: undefined });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstUrl = String(fetchImpl.mock.calls[0][0]);
    const secondUrl = String(fetchImpl.mock.calls[1][0]);
    expect(firstUrl).toContain("http://127.0.0.1:5000/secret/v1/sessions?");
    expect(firstUrl).toContain("sort_by=updated_at");
    expect(firstUrl).toContain("visibility=all");
    expect(secondUrl).toContain("after=conv_one");
  });

  it("drops a session repeated because it moved ahead of the cursor between pages", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({ data: [{ id: "a" }, { id: "b" }], has_more: true, last_id: "b" }),
      )
      .mockResolvedValueOnce(
        json({ data: [{ id: "b" }, { id: "c" }], has_more: false, last_id: "c" }),
      );

    const { sessions } = await new SessionsApi("http://127.0.0.1:6767", fetchImpl).listSessions();

    expect(sessions.map((session) => session.id)).toEqual(["a", "b", "c"]);
  });

  it("restarts from the first page when the server reports a stale cursor", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ data: [{ id: "a" }], has_more: true, last_id: "a" }))
      .mockResolvedValueOnce(
        json({ error: { code: "stale_cursor", message: "Cursor no longer exists" } }, 400),
      )
      .mockResolvedValueOnce(json({ data: [{ id: "b" }], has_more: false, last_id: "b" }));

    const { sessions } = await new SessionsApi("http://127.0.0.1:6767", fetchImpl).listSessions();

    expect(sessions.map((session) => session.id)).toEqual(["b"]);
    expect(String(fetchImpl.mock.calls[2][0])).not.toContain("after=");
  });

  it("stops after the page budget and reports that older sessions were left out", async () => {
    let page = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      page += 1;
      return json({ data: [{ id: `s${page}` }], has_more: true, last_id: `s${page}` });
    });

    const { sessions, truncated } = await new SessionsApi(
      "http://127.0.0.1:6767",
      fetchImpl,
    ).listSessions();

    expect(truncated).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(sessions).toHaveLength(5);
  });

  it("rejects a success page that isn't JSON instead of showing no sessions", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("<html>Sign in</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      );

    await expect(
      new SessionsApi("http://127.0.0.1:6767", fetchImpl).listSessions(),
    ).rejects.toBeInstanceOf(OmnigentApiError);
  });

  it("creates a session on this host in the requested folder", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ id: "conv_new" }, 201));
    const api = new SessionsApi("http://127.0.0.1:6767", fetchImpl);

    await expect(
      api.createSession({ agentId: "agent-1", hostId: "host-1", workspace: "/work/repo" }),
    ).resolves.toBe("conv_new");

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:6767/v1/sessions");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).origin).toBe("http://127.0.0.1:6767");
    expect(JSON.parse(String(init?.body))).toEqual({
      agent_id: "agent-1",
      host_id: "host-1",
      workspace: "/work/repo",
    });
  });

  it.each([
    [{ detail: "Choose a host" }, "Choose a host", undefined],
    [
      { error: { code: "invalid_request", message: "Folder does not exist" } },
      "Folder does not exist",
      "invalid_request",
    ],
  ])("surfaces the server's error detail from %j", async (body, message, code) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(body, 400));
    const api = new SessionsApi("http://127.0.0.1:6767", fetchImpl);

    const request = api.createSession({ agentId: "a", hostId: "h", workspace: "/work" });
    await expect(request).rejects.toEqual(new OmnigentApiError(message, 400, code));
  });
});
