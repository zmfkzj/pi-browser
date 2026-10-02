import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_BROWSER_CONFIG, type BrowserConfig } from "../src/config.js";
import { BrowserRestartedError } from "../src/mcp-client.js";
import { BrowserSession, type BrowserSessionOptions } from "../src/session.js";
import { checkedText } from "../src/page.js";

const server = fileURLToPath(new URL("./helpers/fake-mcp-server.mjs", import.meta.url));
const sessions: BrowserSession[] = [];
function session(config: Partial<BrowserConfig> = {}, extra: Partial<BrowserSessionOptions> = {}): BrowserSession {
  const instance = new BrowserSession({ config: { ...DEFAULT_BROWSER_CONFIG, ...config }, binary: process.execPath, source: "env",
    launch: () => spawn(process.execPath, [server], { stdio: "pipe" }), ...extra });
  sessions.push(instance);
  return instance;
}
function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
afterEach(async () => { await Promise.all(sessions.splice(0).map((instance) => instance.stop())); });

describe("BrowserSession", () => {
  it("starts lazily, records status, and stops idempotently", async () => {
    const states: boolean[] = [];
    const instance = session({}, { now: () => 1234, onStateChange: (state) => states.push(state.running) });
    expect(instance.status()).toEqual({ running: false, pid: undefined, binary: process.execPath, source: "env", startedAt: undefined, calls: 0 });
    await instance.ensureStarted();
    const pid = instance.status().pid;
    expect(instance.status()).toMatchObject({ running: true, startedAt: 1234, calls: 0 });
    await instance.call("echo", { hi: true });
    expect(instance.status().calls).toBe(1);
    const stop = instance.stop();
    expect(instance.stop()).toBe(stop);
    await stop;
    expect(instance.status()).toMatchObject({ running: false, pid: undefined, startedAt: undefined, calls: 1 });
    expect(alive(pid)).toBe(false);
    expect(states).toContain(true);
    expect(states.at(-1)).toBe(false);
  });

  it("stops after idle and starts again on the next call", async () => {
    const instance = session({ idleMs: 30 });
    await instance.call("echo", {});
    const pid = instance.status().pid;
    await delay(100);
    expect(instance.status().running).toBe(false);
    expect(alive(pid)).toBe(false);
    await instance.call("echo", {});
    expect(instance.status().running).toBe(true);
    expect(instance.status().pid).not.toBe(pid);
  });

  it("does not apply the idle timer to active or queued calls", async () => {
    const instance = session({ idleMs: 20 });
    await instance.ensureStarted();
    const pid = instance.status().pid;
    await Promise.all([instance.call("slow", { ms: 60 }), instance.call("slow", { ms: 60 })]);
    expect(instance.status()).toMatchObject({ running: true, pid, calls: 2 });
  });

  it("restarts explicitly with a new process", async () => {
    const instance = session();
    await instance.call("echo", {});
    const pid = instance.status().pid;
    await instance.restart();
    expect(instance.status().running).toBe(true);
    expect(instance.status().pid).not.toBe(pid);
    expect(alive(pid)).toBe(false);
  });

  it("uses evaluate deadlines and transparently recovers after a killed call", async () => {
    const instance = session({ evaluateTimeoutMs: 35, timeoutMs: 2000 });
    await instance.call("echo", {});
    const pid = instance.status().pid;
    await expect(instance.call("browser_evaluate", { expression: "(() => { while (true) {} })()" })).rejects.toBeInstanceOf(BrowserRestartedError);
    expect(instance.status().running).toBe(false);
    await instance.call("browser_navigate", { url: "https://example.com" });
    expect(instance.status()).toMatchObject({ running: true, calls: 3 });
    expect(instance.status().pid).not.toBe(pid);
    expect(alive(pid)).toBe(false);
  });

  it("allows per-call overrides and rejects queued calls after a kill", async () => {
    const instance = session();
    await instance.ensureStarted();
    const results = await Promise.allSettled([instance.call("hang", {}, { deadlineMs: 25 }), instance.call("echo", {})]);
    expect(results.every((result) => result.status === "rejected" && result.reason instanceof BrowserRestartedError)).toBe(true);
    await instance.call("echo", {});
    expect(instance.status().running).toBe(true);
  });

  it("propagates aborts from queued calls to the active child", async () => {
    const instance = session();
    await instance.ensureStarted();
    const controller = new AbortController();
    const pending = Promise.allSettled([instance.call("hang", {}), instance.call("echo", {}, { signal: controller.signal })]);
    setTimeout(() => controller.abort(), 20);
    const results = await pending;
    expect(results.every((result) => result.status === "rejected" && result.reason.name === "BrowserAbortedError")).toBe(true);
    await instance.call("echo", {});
    expect(instance.status().running).toBe(true);
  });

  it("applies the call deadline even when initialization hangs", async () => {
    const instance = new BrowserSession({ config: { ...DEFAULT_BROWSER_CONFIG }, binary: process.execPath,
      launch: () => spawn(process.execPath, [server], { stdio: "pipe", env: { ...process.env, OBSCURA_FAKE_INIT_HANG: "1" } }) });
    sessions.push(instance);
    await expect(instance.call("echo", {}, { deadlineMs: 80 })).rejects.toBeInstanceOf(BrowserRestartedError);
    expect(instance.status().running).toBe(false);
  });

  it("propagates missing binary resolution without invoking the launcher", async () => {
    let launches = 0;
    const instance = new BrowserSession({ config: { ...DEFAULT_BROWSER_CONFIG }, resolveBinary: () => ({ ok: false, message: "Provide obscura explicitly" }),
      launch: () => { launches++; return spawn(process.execPath, [server]); } });
    sessions.push(instance);
    await expect(instance.call("echo", {})).rejects.toThrow("Provide obscura explicitly");
    expect(launches).toBe(0);
    expect(instance.status().running).toBe(false);
  });

  it("stops a pending start and handles another call while stopping", async () => {
    const instance = session();
    await instance.ensureStarted();
    const stopping = instance.stop();
    const call = instance.call("echo", {});
    await stopping;
    await call;
    expect(instance.status().running).toBe(true);
  });
  it("restores after each fresh handshake before tool calls, exactly once for concurrent starts", async () => {
    let restores = 0;
    const state = { cookies: [{ name: "saved", value: "yes", domain: "example.com" }], origins: [] };
    const instance = session({}, { onAfterStart: async (call) => {
      restores++;
      checkedText(await call("browser_set_storage_state", { state }));
    } });
    await Promise.all([instance.call("echo", {}), instance.call("echo", {})]);
    expect(restores).toBe(1);
    const recorded = JSON.parse(checkedText(await instance.call("recorded_calls", {})));
    expect(recorded.map((entry: { name: string }) => entry.name)).toEqual(["browser_set_storage_state", "echo", "echo"]);
    expect(checkedText(await instance.call("browser_get_cookies", {}))).toContain("saved");
    await instance.restart();
    expect(restores).toBe(2);
  });

  it("exports before graceful stop and restart, but not when already stopped", async () => {
    const exports: unknown[] = [];
    const instance = session({}, { onBeforeStop: async (call) => {
      exports.push(JSON.parse(checkedText(await call("browser_storage_state", {}))));
    } });
    await instance.call("browser_set_cookie", { name: "saved", value: "yes", domain: "example.com" });
    await instance.restart();
    expect(exports).toHaveLength(1);
    expect(exports[0]).toMatchObject({ cookies: [{ name: "saved", value: "yes" }] });
    await instance.stop();
    await instance.stop();
    expect(exports).toHaveLength(2);
  });

  it("exports before idle stop", async () => {
    let exports = 0;
    const instance = session({ idleMs: 20 }, { onBeforeStop: async (call) => {
      checkedText(await call("browser_storage_state", {})); exports++;
    } });
    await instance.call("echo", {});
    await delay(100);
    expect(exports).toBe(1);
    expect(instance.status().running).toBe(false);
  });

  it("skips export after a hang kills the child and restores on recovery", async () => {
    let exports = 0;
    let restores = 0;
    const instance = session({}, { onAfterStart: async () => { restores++; }, onBeforeStop: async () => { exports++; } });
    await instance.call("echo", {});
    await expect(instance.call("hang", {}, { deadlineMs: 30 })).rejects.toBeInstanceOf(BrowserRestartedError);
    await instance.stop();
    expect(exports).toBe(0);
    await instance.call("echo", {});
    expect(restores).toBe(2);
  });

  it("reports hook failures without making start or stop fatal", async () => {
    const errors: string[] = [];
    const instance = session({}, {
      onAfterStart: async (call) => { checkedText(await call("browser_set_storage_state", { state: {} })); },
      onBeforeStop: async () => { throw new Error("cannot write profile"); },
      onHookError: (error, phase) => { errors.push(`${phase}: ${String(error)}`); },
    });
    await instance.call("echo", {});
    await instance.stop();
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("restore:");
    expect(errors[1]).toContain("save: Error: cannot write profile");
  });

});
