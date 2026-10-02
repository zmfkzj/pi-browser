import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_BROWSER_CONFIG } from "../src/config.js";
import { BrowserAbortedError, BrowserRestartedError, McpStdioClient, buildChildEnv, buildObscuraArgs, obscuraGlobalArgs, type McpToolResult } from "../src/mcp-client.js";

const server = fileURLToPath(new URL("./helpers/fake-mcp-server.mjs", import.meta.url));
const clients: McpStdioClient[] = [];
function client(env?: NodeJS.ProcessEnv): McpStdioClient {
  const instance = new McpStdioClient({ label: "test-engine", command: process.execPath, args: [server], defaultDeadlineMs: DEFAULT_BROWSER_CONFIG.timeoutMs,
    launch: () => spawn(process.execPath, [server], { stdio: "pipe", env: buildChildEnv(env ?? process.env) }) });
  clients.push(instance);
  return instance;
}
function text(result: McpToolResult): string {
  const item = result.content[0];
  if (item?.type !== "text") throw new Error("Expected text");
  return item.text;
}
function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
afterEach(async () => { await Promise.all(clients.splice(0).map((instance) => instance.close())); });

describe("McpStdioClient", () => {
  it("handshakes before requests and lists tools", async () => {
    const instance = client();
    expect(instance.isRunning).toBe(false);
    const tools = await instance.listTools();
    expect(tools.map((tool) => tool.name)).toContain("echo");
    const handshake = JSON.parse(text(await instance.callTool("handshake", {})));
    expect(handshake).toEqual({ initialized: true, initialization: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pi-browser", version: "0.1.0" } } });
    expect(instance.isRunning).toBe(true);
    expect(instance.pid).toBeGreaterThan(0);
    expect(text(await instance.callTool("echo", { hello: "world" }))).toBe('{"hello":"world"}');
  });

  it("runs concurrent requests one at a time in FIFO order", async () => {
    const instance = client();
    const completion: number[] = [];
    const calls = [60, 5, 1].map((ms, index) => instance.callTool("slow", { ms }).then((result) => {
      completion.push(index);
      return JSON.parse(text(result));
    }));
    const results = await Promise.all(calls);
    expect(completion).toEqual([0, 1, 2]);
    expect(results.map((value) => value.order)).toEqual([1, 2, 3]);
  });

  it("kills on deadline, rejects the queue, and restarts for the next call", async () => {
    const instance = client();
    await instance.initialize();
    const oldPid = instance.pid;
    const failures = await Promise.allSettled([
      instance.callTool("hang", {}, { deadlineMs: 35 }),
      instance.callTool("echo", { queued: true }),
    ]);
    for (const result of failures) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(BrowserRestartedError);
        expect(result.reason.message).toMatch(/test-engine process was terminated.*tabs were lost/);
      }
    }
    expect(text(await instance.callTool("echo", { fresh: true }))).toContain("fresh");
    expect(instance.pid).not.toBe(oldPid);
    expect(alive(oldPid)).toBe(false);
  });

  it("kills on an active abort and rejects every queued request", async () => {
    const instance = client();
    await instance.initialize();
    const controller = new AbortController();
    const pending = Promise.allSettled([
      instance.callTool("hang", {}, { signal: controller.signal }),
      instance.callTool("echo", {}),
    ]);
    setTimeout(() => controller.abort(), 15);
    for (const result of await pending) {
      if (result.status !== "rejected") throw new Error("Expected abort");
      expect(result.reason).toBeInstanceOf(BrowserAbortedError);
    }
    expect(text(await instance.callTool("echo", { recovered: true }))).toContain("recovered");
  });

  it("aborting a queued request also terminates the active browser", async () => {
    const instance = client();
    await instance.initialize();
    const controller = new AbortController();
    const pending = Promise.allSettled([instance.callTool("hang", {}), instance.callTool("echo", {}, { signal: controller.signal })]);
    controller.abort();
    expect((await pending).every((result) => result.status === "rejected" && result.reason instanceof BrowserAbortedError)).toBe(true);
  });

  it("rejects a pre-aborted call without spawning", async () => {
    const instance = client();
    await expect(instance.callTool("echo", {}, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(BrowserAbortedError);
    expect(instance.pid).toBeUndefined();
  });

  it("includes the last 4 KB of stderr after a crash", async () => {
    const instance = client();
    const results = await Promise.allSettled([instance.callTool("crash", {}), instance.callTool("echo", {})]);
    for (const result of results) {
      if (result.status !== "rejected") throw new Error("Expected crash rejection");
      expect(result.reason.message).toContain("code 3");
      expect(result.reason.message).toContain("FAKE_CRASH_DIAGNOSTIC");
    }
    expect(Buffer.byteLength(instance.stderrTail())).toBe(4096);
    expect(instance.isRunning).toBe(false);
  });

  it("handles split lines, ignores non-JSON diagnostics, and reports JSON-RPC errors", async () => {
    const instance = client();
    expect(text(await instance.callTool("partial", {}))).toBe("partial works");
    await expect(instance.callTool("protocol_error", {})).rejects.toThrow("MCP error -32602: Bad fake arguments");
    expect((await instance.callTool("error", {})).isError).toBe(true);
    expect(text(await instance.callTool("echo", {}))).toBe("{}");
  });

  it("close is idempotent and resolves only after the process exits", async () => {
    const instance = client();
    await instance.initialize();
    const pid = instance.pid;
    const first = instance.close();
    expect(instance.close()).toBe(first);
    await first;
    expect(instance.isRunning).toBe(false);
    expect(alive(pid)).toBe(false);
    await expect(instance.callTool("echo", {})).rejects.toThrow("closed");
  });

  it("falls back to SIGKILL when the child ignores SIGTERM", async () => {
    const instance = client({ ...process.env, OBSCURA_FAKE_IGNORE_SIGTERM: "1" });
    await instance.initialize();
    const pid = instance.pid;
    const started = Date.now();
    await instance.close();
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    expect(alive(pid)).toBe(false);
  });

  it("bounds handshake hangs by the request deadline", async () => {
    const instance = client({ ...process.env, OBSCURA_FAKE_INIT_HANG: "1" });
    await expect(instance.callTool("echo", {}, { deadlineMs: 80 })).rejects.toBeInstanceOf(BrowserRestartedError);
    await instance.close();
    expect(instance.isRunning).toBe(false);
  });

  it("terminates a rejected handshake rather than leaking a child", async () => {
    const instance = client({ ...process.env, OBSCURA_FAKE_INIT_ERROR: "1" });
    const results = await Promise.allSettled([instance.callTool("echo", {}), instance.callTool("echo", {})]);
    for (const result of results) {
      if (result.status !== "rejected") throw new Error("Expected rejected handshake");
      expect(result.reason.message).toContain("Handshake refused");
    }
    await instance.close();
    expect(instance.isRunning).toBe(false);
  });

  it("does not leak API keys or other environment variables", async () => {
    const env = { PATH: process.env.PATH, HOME: "/fake/home", TMPDIR: "/tmp", TMP: "/tmp", TEMP: "/tmp", OBSCURA_TEST: "allowed", SECRET_API_KEY: "do-not-leak", NODE_OPTIONS: "--invalid" };
    const actual = JSON.parse(text(await client(env).callTool("env", {})));
    expect(actual).toEqual(buildChildEnv(env));
    expect(actual.SECRET_API_KEY).toBeUndefined();
    expect(actual.NODE_OPTIONS).toBeUndefined();
  });

  it("shares global flags without including the subcommand or user-agent option", () => {
    expect(obscuraGlobalArgs({ ...DEFAULT_BROWSER_CONFIG })).toEqual([]);
    expect(obscuraGlobalArgs({ ...DEFAULT_BROWSER_CONFIG, allowPrivateNetwork: true, stealth: true, proxy: "http://proxy", userAgent: "Agent" }))
      .toEqual(["--allow-private-network", "--stealth", "--proxy", "http://proxy"]);
  });

  it("accepts a handshake deadline and abort signal", async () => {
    const instance = client({ ...process.env, OBSCURA_FAKE_INIT_HANG: "1" });
    await expect(instance.initialize({ deadlineMs: 80 })).rejects.toBeInstanceOf(BrowserRestartedError);
    await expect(client().initialize({ signal: AbortSignal.abort() })).rejects.toBeInstanceOf(BrowserAbortedError);
  });

  it("builds only supported CLI flags and minimal environment", () => {
    expect(buildObscuraArgs({ ...DEFAULT_BROWSER_CONFIG })).toEqual(["mcp"]);
    expect(buildObscuraArgs({ ...DEFAULT_BROWSER_CONFIG, allowPrivateNetwork: true, stealth: true, proxy: "http://proxy", userAgent: "Agent" }))
      .toEqual(["mcp", "--allow-private-network", "--stealth", "--proxy", "http://proxy", "--user-agent", "Agent"]);
    expect(buildChildEnv({ PATH: "/bin", HOME: "/home", UNSET: undefined, OBSCURA_ONE: "1", OBSCURA_: "2", OTHER: "no" }))
      .toEqual({ PATH: "/bin", HOME: "/home", OBSCURA_ONE: "1", OBSCURA_: "2" });
  });
  it("spawns the supplied command/args/environment without obscura policy and labels errors", async () => {
    const instance = new McpStdioClient({ label: "chrome", command: process.execPath, args: [server],
      env: { PATH: process.env.PATH, SECRET_TEST: "explicitly forwarded" }, defaultDeadlineMs: 2000 });
    clients.push(instance);
    expect(JSON.parse(text(await instance.callTool("env", {}))).SECRET_TEST).toBe("explicitly forwarded");
    await expect(instance.callTool("hang", {}, { deadlineMs: 20 })).rejects.toThrow("chrome process was terminated");
    await instance.close();
    await expect(instance.callTool("echo", {})).rejects.toThrow("chrome MCP client is closed");
  });

  it.skipIf(process.platform !== "linux")("escalates a detached group even after the MCP parent exits", async () => {
    const script = `import { spawn } from 'node:child_process';
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore','ignore','ignore','ipc'] });
      await new Promise(resolve => child.once('message', resolve));
      process.stderr.write('DESCENDANT=' + child.pid + '\\n');
      await import(${JSON.stringify(new URL("./helpers/fake-mcp-server.mjs", import.meta.url).href)});`;
    const instance = new McpStdioClient({ label: "chrome", command: process.execPath,
      args: ["--input-type=module", "-e", script], detached: true, defaultDeadlineMs: 2000 });
    clients.push(instance);
    await instance.initialize();
    const parent = instance.pid;
    const descendant = Number(/DESCENDANT=(\d+)/.exec(instance.stderrTail())?.[1]);
    expect(descendant).toBeGreaterThan(0);
    const started = Date.now();
    await instance.close();
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    expect(alive(parent)).toBe(false);
    // Orphaned killed children may briefly be zombies before the host init reaps them.
    await expect.poll(() => {
      try { return !/^\d+ \(.+\) Z /.test(readFileSync(`/proc/${descendant}/stat`, "utf8")); }
      catch { return false; }
    }, { timeout: 2000 }).toBe(false);
  }, 6000);

});
