import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { applyPendingStorage, restoreStorageState, validateRestorableState, type PendingStorage } from "../src/state.js";
import type { PageSession } from "../src/page.js";

const origin = "https://example.com";
function fixture(initialOrigin = origin) {
  let activeOrigin = initialOrigin;
  const localStorage = new Map<string, string>();
  const sessionStorage = new Map<string, string>();
  const call = vi.fn<PageSession["call"]>(async (name, args) => {
    if (name === "browser_set_storage_state") return { content: [{ type: "text", text: "Restored cookies." }], isError: false };
    if (name !== "browser_evaluate") throw new Error(`Unexpected tool: ${name}`);
    const value = runInNewContext(String(args.expression), {
      location: { origin: activeOrigin },
      localStorage: { setItem: (k: string, v: string) => { localStorage.set(k, v); } },
      sessionStorage: { setItem: (k: string, v: string) => { sessionStorage.set(k, v); } },
    });
    return { content: [{ type: "text", text: String(value) }], isError: false };
  });
  return { call, localStorage, sessionStorage, navigate: (next: string) => { activeOrigin = next; } };
}

describe("origin storage restore", () => {
  it.each([null, {}, { cookies: [], origins: {} }])("validates top-level state %j", (value) => {
    expect(() => validateRestorableState(value)).toThrow("Storage state must be a JSON object");
  });
  it.each([
    null, [], "origin", {}, { origin: 1 }, { origin, extra: [] },
    { origin, localStorage: {} }, { origin, localStorage: null }, { origin, localStorage: undefined },
    { origin, localStorage: [["one"]] }, { origin, localStorage: [["k", 1]] },
    { origin, sessionStorage: [{ k: "v" }] }, { origin, sessionStorage: [["a", "b", "c"]] },
  ])("rejects malformed origin %j before calling obscura", async (entry) => {
    const session = fixture();
    await expect(restoreStorageState(session, { cookies: [], origins: [entry] }, { pending: new Map() })).rejects.toThrow("Storage state origins[0] must be");
    expect(session.call).not.toHaveBeenCalled();
  });
  it("accepts optional stores and retains the state object", () => {
    const state = { cookies: [], origins: [{ origin }, { origin, localStorage: [["k", "v"]], sessionStorage: [] }] };
    expect(validateRestorableState(state)).toBe(state);
  });
  it("makes one origin evaluation and one application per matching entry", async () => {
    const session = fixture();
    const pending: PendingStorage = new Map();
    const signal = new AbortController().signal;
    const report = await restoreStorageState(session, { cookies: [{}, {}], origins: [
      { origin, localStorage: [["k", "v"]], sessionStorage: [["s", "1"]] },
      { origin, localStorage: [["another", "2"]] },
      { origin: "https://other.example", localStorage: [["later", "yes"]] },
    ] }, { pending, signal, cwd: "/project" });
    expect(session.call).toHaveBeenCalledTimes(4);
    expect(session.call.mock.calls.every(([, , options]) => options?.signal === signal)).toBe(true);
    expect(session.localStorage.get("k")).toBe("v");
    expect(session.sessionStorage.get("s")).toBe("1");
    expect(report).toEqual({ cookies: 2, storageApplied: 3, storageOrigin: origin, queuedOrigins: ["https://other.example"], text: `Restored 2 cookies; applied 3 storage entries to ${origin}; queued storage for 1 other origin (applied on the next navigation there).` });
    expect(pending.size).toBe(1);
  });
  it("avoids evaluation when no storage is pending", async () => {
    const session = fixture();
    expect(await applyPendingStorage(session, new Map())).toBeUndefined();
    expect(session.call).not.toHaveBeenCalled();
  });
  it("queues on opaque origins, merges duplicate origins, and deletes only after successful application", async () => {
    const session = fixture("null");
    const pending: PendingStorage = new Map();
    const report = await restoreStorageState(session, { cookies: [], origins: [
      { origin, localStorage: [["k", "old"]] }, { origin, localStorage: [["k", "new"]], sessionStorage: [["s", "1"]] },
      { origin: "null", localStorage: [["opaque", "never"]] },
    ] }, { pending });
    expect(report).toMatchObject({ storageApplied: 0, storageOrigin: null, queuedOrigins: [origin, "null"] });
    expect(session.call).toHaveBeenCalledTimes(2);
    expect(await applyPendingStorage(session, pending)).toBeUndefined();
    expect(pending.size).toBe(2);
    session.navigate(origin);
    session.call.mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify({ ok: true, value: origin }) }], isError: false });
    session.call.mockResolvedValueOnce({ content: [{ type: "text", text: "Evaluation failed" }], isError: true });
    await expect(applyPendingStorage(session, pending)).rejects.toThrow("Evaluation failed");
    expect(pending.has(origin)).toBe(true);
    expect(await applyPendingStorage(session, pending)).toBe(`Applied 3 queued storage entries for ${origin}.`);
    expect(pending.has(origin)).toBe(false);
    expect(session.localStorage.get("k")).toBe("new");
    expect(session.sessionStorage.get("s")).toBe("1");
    expect(pending.has("null")).toBe(true);
  });
});
