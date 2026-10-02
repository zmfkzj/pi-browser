import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage as reply } from "@earendil-works/pi-ai";
import { managedBinaryPath, managedCacheDir } from "../src/binary.js";
import { BROWSER_USAGE } from "../src/extension/index.js";
import type { InstallObscuraOptions } from "../src/install.js";
import { createHarness, tool, type Harness } from "./helpers/harness.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const fakeServer = fileURLToPath(new URL("./helpers/fake-mcp-server.mjs", import.meta.url));
const fakeCli = fileURLToPath(new URL("./helpers/fake-obscura-cli.mjs", import.meta.url));
const open: Harness[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const h of open.splice(0)) await h.dispose(); });
async function harness(options: Parameters<typeof createHarness>[0] = {}) {
  const h = await createHarness({ ...options, config: { exposure: "direct", ...options.config } }); open.push(h); return h;
}
const results = (h: Harness) => h.session.messages.filter((message) => message.role === "toolResult");
const text = (h: Harness) => results(h).at(-1)!.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
async function run(h: Harness, name: string, args: Record<string, unknown> = {}) {
  if (!h.manager.active() && name !== "browser_navigate") await h.manager.select();
  h.main.faux.setResponses([tool(name, args as Parameters<typeof tool>[1]), reply("done")]);
  await h.session.prompt(`Call ${name}`);
  return results(h).at(-1)!;
}
function installer() {
  return vi.fn(async (o: InstallObscuraOptions) => {
    o.signal?.throwIfAborted();
    o.onProgress?.({ receivedBytes: 42, totalBytes: 100 });
    const path = managedBinaryPath(o.agentDir, o.version, o.platform);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `#!/bin/sh\necho obscura ${o.version}\n`);
    await chmod(path, 0o755);
    return { path, version: o.version, asset: "fake.tar.gz", bytes: 100, sha256: "a".repeat(64) };
  });
}
const missing = { binaryPath: null };
const isolated = { env: {}, pathDirs: [] };
const profilePath = (h: Harness, name: string) => join(h.agentDir, "pi-browser", "profiles", `${name}.json`);
const cookieState = { cookies: [{ name: "saved", value: "yes", domain: "example.com", path: "/" }], origins: [] };

describe("browser commands", () => {
  it.each([undefined, "0.2.4"])("installs explicitly without confirmation, then resolves cache (%s)", async (version) => {
    const install = installer();
    const h = await harness({ config: missing, extension: { ...isolated, install } });
    await h.session.prompt(`/browser install${version ? ` ${version}` : ""}`);
    expect(install).toHaveBeenCalledTimes(1);
    expect(install.mock.calls[0]![0]).toMatchObject({ version: version ?? "0.2.3", agentDir: h.agentDir });
    expect(h.confirmations).toEqual([]);
    expect(h.statuses).toContainEqual({ key: "browser", text: "browser: downloading obscura 42%" });
    expect(h.notifications.at(-1)?.message).toContain("Size: 100 bytes");
    expect(h.notifications.at(-1)?.message).toContain("SHA-256: " + "a".repeat(64));
    await h.session.prompt("/browser status");
    expect(h.notifications.at(-1)?.message).toContain(`Binary: ${managedBinaryPath(h.agentDir, version ?? "0.2.3")} (cache)`);
    expect(h.children).toHaveLength(0);
  });

  it("persists an explicit changed version exactly once and preserves unrelated settings", async () => {
    const install = installer();
    const h = await harness({ config: { ...missing, userAgent: "kept", timeoutMs: 1234 }, extension: { ...isolated, install } });
    const path = join(h.agentDir, "browser.config.json");
    const writes = vi.mocked(writeFile);
    writes.mockClear();
    await h.session.prompt("/browser install 0.2.4");
    const written = await readFile(path, "utf8");
    const values = JSON.parse(written);
    expect(values).toEqual({ exposure: "direct", binaryPath: null, userAgent: "kept", timeoutMs: 1234, version: "0.2.4" });
    expect(written).toBe(JSON.stringify(values, null, 2) + "\n");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(h.notifications.filter((n) => n.message.includes(`version 0.2.4 saved to ${path}`))).toHaveLength(1);
    const before = await stat(path);
    await h.session.prompt("/browser install 0.2.4");
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(path, "utf8")).toBe(written);
    expect(h.notifications.filter((n) => n.message.includes(`version 0.2.4 saved to ${path}`))).toHaveLength(1);
    expect(install).toHaveBeenCalledTimes(2);
    expect(writes.mock.calls.filter(([target]) => target === path)).toHaveLength(1);
  });

  it.each(["install", "install 0.2.3"])("does not write the unchanged version: %s", async (command) => {
    const h = await harness({ config: missing, extension: { ...isolated, install: installer() } });
    const path = join(h.agentDir, "browser.config.json");
    const before = await stat(path);
    const content = await readFile(path, "utf8");
    await h.session.prompt(`/browser ${command}`);
    expect(await readFile(path, "utf8")).toBe(content);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    expect(h.notifications.some((n) => n.message.includes("saved to"))).toBe(false);
  });

  it("persists the user version and warns when a trusted project version wins", async () => {
    const install = installer();
    const h = await harness({ config: missing, extension: { ...isolated, install } });
    const projectPath = join(h.cwd, ".pi", "browser.config.json");
    await mkdir(dirname(projectPath));
    await writeFile(projectPath, JSON.stringify({ version: "0.2.5" }));
    await h.session.prompt("/browser install 0.2.4");
    expect(JSON.parse(await readFile(join(h.agentDir, "browser.config.json"), "utf8")).version).toBe("0.2.4");
    expect(h.notifications).toContainEqual({ message: `browser: ${projectPath} sets version; the project value wins.`, type: "warning" });
    expect(install.mock.calls[0]![0].version).toBe("0.2.4");
  });

  it.each(["config", "env", "path"])("warns when %s binary precedence shadows the installed cache", async (source) => {
    const pathDirs: string[] = [];
    const h = await harness({ config: { binaryPath: source === "config" ? process.execPath : null }, extension: {
      env: source === "env" ? { PI_BROWSER_OBSCURA_BIN: process.execPath } : {}, pathDirs, install: installer(),
    } });
    let path = process.execPath;
    if (source === "path") {
      path = join(h.agentDir, "bin", "obscura");
      await mkdir(dirname(path));
      await writeFile(path, "#!/bin/sh\necho obscura\n", { mode: 0o755 });
      pathDirs.push(dirname(path));
    }
    await h.session.prompt("/browser install");
    expect(h.notifications.at(-1)).toEqual({ message: `Installed to ${managedBinaryPath(h.agentDir, "0.2.3")}, but binary resolution currently uses ${source}: ${path}. Remove binaryPath / PI_BROWSER_OBSCURA_BIN / the PATH entry to use the managed binary.`, type: "warning" });
  });

  it("reports installer failure without changing to cache", async () => {
    const h = await harness({ config: missing, extension: { ...isolated, install: async () => { throw new Error("test install failure"); } } });
    await h.session.prompt("/browser install");
    expect(h.notifications.at(-1)).toEqual({ message: "test install failure", type: "error" });
  });

  it("prints new status fields without starting or requesting consent", async () => {
    const h = await harness({ config: { ...missing, autoInstall: "never", profile: "test", artifactsDir: "artifacts" }, extension: isolated });
    await h.session.prompt("/browser status");
    const status = h.notifications.at(-1)!.message;
    for (const value of ["autoInstall: never", "profile: test", "rawMcp: false", "artifactsDir: artifacts", `Managed cache: ${managedCacheDir(h.agentDir)}`]) expect(status).toContain(value);
    await h.session.prompt("/browser stop");
    expect(h.confirmations).toEqual([]);
    expect(h.children).toHaveLength(0);
  });

  it.each(["", "Status", "status extra", "install ../x", "install 0.2.3 extra", "allow-private-network", "allow-private-network yes", "allow-private-network on extra", "profile", "profile remove", "profile save one two"])("rejects strict grammar %j", async (args) => {
    const install = installer();
    const h = await harness({ extension: { install } });
    await h.session.prompt(`/browser ${args}`.trimEnd());
    expect(h.notifications.at(-1)).toEqual({ message: BROWSER_USAGE, type: "warning" });
    expect(install).not.toHaveBeenCalled();
    expect(h.children).toHaveLength(0);
  });

  it("writes private-network opt-in, preserves keys, and restarts only a running browser", async () => {
    const h = await harness({ config: { userAgent: "kept", timeoutMs: 1234 } });
    await h.session.prompt("/browser allow-private-network on");
    expect(h.children).toHaveLength(0);
    const path = join(h.agentDir, "browser.config.json");
    const first = JSON.parse(await readFile(path, "utf8"));
    expect(first).toMatchObject({ binaryPath: process.execPath, userAgent: "kept", timeoutMs: 1234, allowPrivateNetwork: true });
    expect(await readFile(path, "utf8")).toBe(JSON.stringify(first, null, 2) + "\n");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await run(h, "browser_navigate", { url: "https://example.com" });
    const oldPid = h.children[0]!.pid;
    await h.session.prompt("/browser allow-private-network off");
    expect(h.children).toHaveLength(2);
    expect(h.children[1]!.pid).not.toBe(oldPid);
    expect(h.children[0]!.exitCode !== null || h.children[0]!.signalCode !== null).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8")).allowPrivateNetwork).toBe(false);
  });

  it("creates a missing config and preserves unrelated keys", async () => {
    const h = await harness();
    const path = join(h.agentDir, "browser.config.json");
    await rm(path);
    await h.session.prompt("/browser allow-private-network on");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ allowPrivateNetwork: true });
    await writeFile(path, JSON.stringify({ unknownPreserved: { nested: 1 }, allowPrivateNetwork: true }));
    await h.session.prompt("/browser allow-private-network off");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ unknownPreserved: { nested: 1 }, allowPrivateNetwork: false });
  });

  it("does not overwrite malformed user JSON", async () => {
    const h = await harness();
    const path = join(h.agentDir, "browser.config.json");
    await writeFile(path, "{");
    await h.session.prompt("/browser allow-private-network on");
    expect(h.notifications.at(-1)?.type).toBe("error");
    expect(await readFile(path, "utf8")).toBe("{");
  });

  it("refuses invalid known config values without modifying the file", async () => {
    const h = await harness();
    const path = join(h.agentDir, "browser.config.json");
    const content = JSON.stringify({ timeoutMs: -1, allowPrivateNetwork: false });
    await writeFile(path, content);
    await h.session.prompt("/browser allow-private-network on");
    expect(h.notifications.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("timeoutMs must be") });
    expect(await readFile(path, "utf8")).toBe(content);
  });

  it("warns when a trusted project private-network setting wins", async () => {
    const h = await harness();
    await mkdir(join(h.cwd, ".pi"));
    await writeFile(join(h.cwd, ".pi", "browser.config.json"), JSON.stringify({ allowPrivateNetwork: false }));
    await h.session.prompt("/browser allow-private-network on");
    expect(h.notifications.at(-1)?.message).toContain("the project value wins");
    expect(h.notifications.at(-1)?.type).toBe("warning");
  });

  it("saves, loads and clears profiles with private modes and default names", async () => {
    const h = await harness();
    await run(h, "browser_state", { action: "set_cookie", cookie: { name: "saved", value: "yes", domain: "example.com" } });
    await h.session.prompt("/browser profile save");
    const path = profilePath(h, "default");
    expect(JSON.parse(await readFile(path, "utf8")).cookies[0].name).toBe("saved");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    await run(h, "browser_state", { action: "clear_cookies" });
    await h.session.prompt("/browser profile load");
    await run(h, "browser_state", { action: "cookies" });
    expect(text(h)).toContain("saved");
    await h.session.prompt("/browser profile save named.profile");
    await h.session.prompt("/browser profile clear named.profile");
    await expect(stat(profilePath(h, "named.profile"))).rejects.toMatchObject({ code: "ENOENT" });
    await h.session.prompt("/browser profile clear");
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["../escape", "a/b", "a".repeat(65)])("rejects invalid profile names %s", async (name) => {
    const h = await harness();
    await h.session.prompt(`/browser profile save ${name}`);
    expect(h.notifications.at(-1)?.message).toContain("Invalid profile name");
    expect(h.children).toHaveLength(0);
  });
});

describe("binary consent and fetch wiring", () => {
  it("installs after consent and continues the tool", async () => {
    const install = installer();
    const h = await harness({ config: missing, confirm: true, extension: { ...isolated, install } });
    expect((await run(h, "browser_navigate", { url: "https://example.com" })).isError).toBe(false);
    expect(install).toHaveBeenCalledTimes(1);
    expect(h.confirmations).toEqual([{ title: "Download obscura?", message: `pi-browser needs the obscura browser (v0.2.3, ~70 MB, Apache-2.0) from GitHub releases. Download to ${managedBinaryPath(h.agentDir, "0.2.3")}?` }]);
    expect(h.children).toHaveLength(1);
  });

  it("shares one consent and installer across concurrent tool calls", async () => {
    const install = installer();
    const h = await harness({ config: missing, confirm: true, extension: { ...isolated, install } });
    const tool = h.session.getToolDefinition("browser_navigate")!;
    await Promise.all(["one", "two"].map((id) => tool.execute(id, { url: "https://example.com" }, undefined, undefined, h.session.extensionRunner.createToolContext(id, undefined))));
    expect(install).toHaveBeenCalledTimes(1);
    expect(h.confirmations).toHaveLength(1);
    expect(h.children).toHaveLength(1);
  });

  it.each([
    { confirm: false, autoInstall: "ask", hasUI: true, expected: "Obscura download declined." },
    { confirm: true, autoInstall: "never", hasUI: true, expected: "Obscura executable not found." },
    { confirm: true, autoInstall: "ask", hasUI: false, expected: "Obscura executable not found." },
  ])("does not install when %j", async ({ confirm, autoInstall, hasUI, expected }) => {
    const install = installer();
    const h = await harness({ config: { ...missing, autoInstall }, confirm, hasUI, extension: { ...isolated, install } });
    expect((await run(h, "browser_navigate", { url: "https://example.com" })).isError).toBe(true);
    expect(text(h)).toContain(expected);
    expect(text(h)).toContain("/browser install");
    expect(install).not.toHaveBeenCalled();
    expect(h.children).toHaveLength(0);
    expect(h.confirmations).toHaveLength(hasUI && autoInstall === "ask" ? 1 : 0);
  });

  it("registers fetch with an independent launcher and no MCP process", async () => {
    const h = await harness({ extension: { launchFetch: (args) => spawn(process.execPath, [fakeCli, ...args], { stdio: "pipe" }) } });
    expect((await run(h, "browser_fetch", { url: "https://example.com", format: "links" })).isError).toBe(false);
    expect(text(h)).toContain("links https://example.com");
    expect(h.children).toHaveLength(0);
    expect(h.session.getAllTools().find((t) => t.name === "browser_fetch")?.annotations?.readOnlyHint).toBe(true);
  });

  it("passes the injectable fetch kill grace through the extension factory", async () => {
    let child: ReturnType<typeof spawn> | undefined;
    const h = await harness({ extension: { fetchKillGraceMs: 20, launchFetch: (args) => {
      child = spawn(process.execPath, [fakeCli, ...args], { stdio: "pipe" });
      return child;
    } } });
    try {
      expect((await run(h, "browser_fetch", { url: "http://hang.invalid/", timeoutMs: 1000 })).isError).toBe(true);
      expect(text(h)).toBe("obscura fetch did not exit after 1020 ms and was killed.");
      expect(child!.signalCode).toBe("SIGKILL");
      expect(() => process.kill(child!.pid!, 0)).toThrow();
    } finally { if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  }, 6000);
});

describe("automatic cookie profiles and raw MCP registration", () => {
  async function recordedHarness() {
    let h: Harness;
    h = await harness({ config: { profile: "test" }, extension: {
      launch: () => spawn(process.execPath, [fakeServer], { stdio: "pipe", env: { ...process.env, OBSCURA_FAKE_RECORD: join(h.agentDir, "calls.jsonl") } }),
    } });
    const calls = async () => (await readFile(join(h.agentDir, "calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { name: string; args: Record<string, unknown> });
    return { h, calls };
  }

  it("restores cookies after handshake and saves on stop using configured default name", async () => {
    const { h, calls } = await recordedHarness();
    await mkdir(dirname(profilePath(h, "test")), { recursive: true });
    await writeFile(profilePath(h, "test"), JSON.stringify(cookieState));
    await run(h, "browser_state", { action: "cookies" });
    expect(text(h)).toContain("saved");
    expect((await calls())[0]).toMatchObject({ name: "browser_set_storage_state", args: { state: cookieState } });
    await h.session.prompt("/browser profile save");
    expect(h.notifications.at(-1)?.message).toContain("profile test saved");
    await h.session.prompt("/browser stop");
    expect((await calls()).at(-1)?.name).toBe("browser_storage_state");
    expect(JSON.parse(await readFile(profilePath(h, "test"), "utf8")).cookies[0].name).toBe("saved");
  });

  it("does not import absent profiles and exports on shutdown", async () => {
    const { h, calls } = await recordedHarness();
    await run(h, "browser_navigate", { url: "https://example.com" });
    expect((await calls()).some((call) => call.name === "browser_set_storage_state")).toBe(false);
    await h.shutdown();
    expect((await calls()).at(-1)?.name).toBe("browser_storage_state");
    expect(JSON.parse(await readFile(profilePath(h, "test"), "utf8"))).toHaveProperty("cookies");
  });

  it("notifies failed restore once and still starts normally after each restart", async () => {
    const { h } = await recordedHarness();
    await mkdir(dirname(profilePath(h, "test")), { recursive: true });
    await writeFile(profilePath(h, "test"), "{");
    expect((await run(h, "browser_navigate", { url: "https://example.com" })).isError).toBe(false);
    await h.session.prompt("/browser restart");
    // Graceful save repairs the profile, but the warning is still retained only once.
    expect(h.notifications.filter((note) => note.message.includes("profile test restore failed"))).toHaveLength(1);
  });

  it("registers raw MCP through the real extension API and updates it after config reload", async () => {
    const h = await harness({ config: { rawMcp: true, allowPrivateNetwork: true, userAgent: "test-agent" } });
    expect(h.getMcpServers()).toEqual([expect.objectContaining({ name: "obscura", config: {
      command: process.execPath, args: ["mcp", "--allow-private-network", "--user-agent", "test-agent"], exposure: "codemode",
      description: "Raw obscura browser MCP (37 tools); separate process and state from the curated browser_* tools.",
    } })]);
    await writeFile(join(h.agentDir, "browser.config.json"), JSON.stringify({ binaryPath: process.execPath, rawMcp: true, stealth: true }));
    await h.session.prompt("/browser restart");
    expect(h.getMcpServers()[0]!.config).toMatchObject({ args: ["mcp", "--stealth"] });
    await writeFile(join(h.agentDir, "browser.config.json"), JSON.stringify({ binaryPath: process.execPath, rawMcp: false }));
    await h.session.prompt("/browser restart");
    expect(h.getMcpServers()).toEqual([]);
  });
  it("saves the old profile before restart loads a changed profile setting", async () => {
    const h = await harness({ config: { profile: "old" } });
    await run(h, "browser_state", { action: "set_cookie", cookie: { name: "old_cookie", value: "saved", domain: "example.com" } });
    await mkdir(dirname(profilePath(h, "new")), { recursive: true });
    await writeFile(profilePath(h, "new"), JSON.stringify(cookieState));
    await writeFile(join(h.agentDir, "browser.config.json"), JSON.stringify({ binaryPath: process.execPath, exposure: "direct", profile: "new" }));
    await h.session.prompt("/browser restart");
    expect(JSON.parse(await readFile(profilePath(h, "old"), "utf8")).cookies[0].name).toBe("old_cookie");
    await run(h, "browser_state", { action: "cookies" });
    expect(text(h)).toContain('"name":"saved"');
    expect(text(h)).not.toContain("old_cookie");
  });

  it("preserves freshly auto-restored profile storage after restart until navigation", async () => {
    const h = await harness({ config: { profile: "test" } });
    await run(h, "browser_navigate", { url: "https://example.com" });
    await run(h, "browser_evaluate", { expression: "localStorage.setItem('persist', 'yes')" });
    h.manager.pendingFor("obscura").set("https://stale.example", { localStorage: [["stale", "no"]], sessionStorage: [] });
    await h.session.prompt("/browser restart");
    expect(h.manager.pendingFor("obscura").has("https://stale.example")).toBe(false);
    expect(h.manager.pendingFor("obscura").has("https://example.com")).toBe(true);
    await run(h, "browser_navigate", { url: "https://example.com" });
    expect(text(h)).toContain("Applied 1 queued storage entries");
    await run(h, "browser_evaluate", { expression: "localStorage.getItem('persist')" });
    expect(JSON.parse(text(h)).value).toBe("yes");
  });

});

describe('Chrome selection commands through AgentSession', () => {
  it('sets Chrome next-navigation default, reports availability/flags and stops the detached fake',async ()=> {
    const h=await harness({chrome:true});
    await h.session.prompt('/browser engine chrome');
    expect(h.notifications.at(-1)?.type).not.toBe('error');
    expect(h.manager.status().default).toBe('chrome');expect(h.children).toHaveLength(0);
    expect((await run(h,'browser_navigate',{url:'https://example.com'})).isError).toBe(false);
    expect(h.manager.require().name).toBe('chrome');expect(text(h)).toContain('engine: chrome');
    await h.session.prompt('/browser status');
    expect(h.notifications.at(-1)?.message).toContain('chrome');expect(h.notifications.at(-1)?.message).toContain('--workspace');
    const pid=h.children[0]!.pid!;await h.session.prompt('/browser stop');expect(()=>process.kill(pid,0)).toThrow();
  });
  it('rejects unavailable Chrome with reason and no silent fallback/default change',async ()=> {
    const h=await harness();await h.session.prompt('/browser engine chrome');
    expect(h.notifications.at(-1)).toMatchObject({type:'error',message:expect.stringContaining('chrome engine disabled in config')});
    expect(h.manager.status().default).toBe('auto');expect(h.children).toHaveLength(0);
  });
  it('routes a fresh local navigation to fake Chrome while explicit obscura wins and remains sticky',async ()=> {
    const h=await harness({chrome:true});
    await run(h,'browser_navigate',{url:'http://127.0.0.1:3000/'});expect(h.manager.require().name).toBe('chrome');
    await run(h,'browser_navigate',{url:'https://example.com'});expect(h.manager.require().name).toBe('chrome');
    await run(h,'browser_navigate',{url:'http://127.0.0.1:3000/',engine:'obscura'});expect(h.manager.require().name).toBe('obscura');
    await run(h,'browser_navigate',{url:'http://127.0.0.1:3000/'});expect(h.manager.require().name).toBe('obscura');
  });
});
