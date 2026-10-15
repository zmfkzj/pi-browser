import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { managedBinaryPath } from "../src/binary.js";
import type { BrowserConfig } from "../src/config.js";
import { DEPENDENCY_CHANNEL, type DependencyProvider, type DependencyReport, type RunResult } from "../src/dependencies.js";
import { createBrowserDependencyProvider, type BrowserDependencyOptions, type DoctorContext } from "../src/doctor.js";
import { BROWSER_USAGE } from "../src/extension/index.js";
import { completeBrowserArguments } from "../src/extension/completions.js";
import type { InstallObscuraOptions } from "../src/install.js";
import { createHarness, type Harness } from "./helpers/harness.js";

const roots: string[] = [];
const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function script(path: string, body: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

/** The fake verified installer: writes a managed binary that reports the requested version. */
function installer(onCall?: (o: { version: string; variant: string }) => void) {
  return vi.fn(async (o: InstallObscuraOptions) => {
    onCall?.(o);
    const path = managedBinaryPath(o.agentDir, o.version, o.platform);
    await script(path, `echo obscura ${o.version}`);
    return { path, version: o.version, asset: "fake.tar.gz", bytes: 100, sha256: "a".repeat(64) };
  });
}

async function setup(config: Record<string, unknown> = {}, probes: Partial<BrowserDependencyOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "browser-deps-"));
  roots.push(root);
  const agentDir = join(root, "agent"), cwd = join(root, "project"), packageDir = join(root, "package");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "pi-browser", dependencies: { "chrome-devtools-mcp": "1.10.1" } }));
  if (Object.keys(config).length) await writeFile(join(agentDir, "browser.config.json"), JSON.stringify(config));
  const installed: string[] = [];
  const install = installer(o => installed.push(o.version));
  const runs: string[][] = [];
  const run = vi.fn(async (command: string, args: string[]): Promise<RunResult> => {
    runs.push([command, ...args]);
    const { runProcess } = await import("../src/dependencies.js");
    return runProcess(command, args, { timeoutMs: 5_000 });
  });
  const options: BrowserDependencyOptions = {
    agentDir, env: {}, pathDirs: [], platform: "linux", arch: "x64", packageDir,
    glibcVersion: () => "2.39", run,
    chromeServer: () => ({ bin: "/fake/chrome-devtools-mcp/index.js", version: "1.10.1" }),
    chromeExists: () => true,
    npmRun: vi.fn(async () => { throw new Error("npm must not run"); }),
    installObscura: (_ctx, cfg: BrowserConfig) => install({ version: cfg.version, variant: cfg.variant, platform: "linux", arch: "x64", agentDir }),
    ...probes,
  };
  const provider = createBrowserDependencyProvider(options);
  const ctx: DoctorContext = { cwd, isProjectTrusted: () => true };
  return { root, agentDir, cwd, packageDir, install, installed, run, runs, options, provider, ctx };
}

const item = (report: DependencyReport, name: string) => report.items.find(entry => entry.name === name);
const outcome = async (report: DependencyReport, mode: "check" | "install") => (await import("../src/dependencies.js")).dependencyOutcome(report, mode);

describe.skipIf(process.platform === "win32")("pi-browser dependency provider", () => {
  it("reports a healthy setup without installing or running npm", async () => {
    const s = await setup();
    const bin = await script(join(s.root, "bin", "obscura"), "echo obscura 0.2.3");
    s.options.pathDirs!.push(dirname(bin));
    const report = await s.provider.check(s.ctx);
    expect(report.items.map(entry => [entry.name, entry.status])).toEqual([
      ["browser config", "ok"], ["platform", "ok"], ["glibc", "ok"], ["obscura binary", "ok"],
      ["chrome-devtools-mcp npm package", "ok"], ["Chrome browser", "ok"],
    ]);
    expect(item(report, "obscura binary")!.detail).toBe(`${bin} (path) reports "obscura 0.2.3"`);
    expect(item(report, "platform")!.detail).toContain("obscura-x86_64-linux.tar.gz");
    expect(item(report, "Chrome browser")!.optional).toBe(true);
    expect(await outcome(report, "check")).toBe("healthy");
    expect(s.install).not.toHaveBeenCalled();
    expect(s.options.npmRun).not.toHaveBeenCalled();
  });

  it("reports missing obscura and Chrome with actions, and check never installs", async () => {
    const s = await setup({}, { chromeExists: () => false });
    const report = await s.provider.check(s.ctx);
    const obscura = item(report, "obscura binary")!;
    expect(obscura.status).toBe("error");
    expect(obscura.detail).toContain(`managed cache ${managedBinaryPath(s.agentDir, "0.2.3", "linux")} missing`);
    expect(obscura.action).toContain("Run /browser install-deps (downloads the verified v0.2.3 release");
    const chrome = item(report, "Chrome browser")!;
    expect(chrome).toMatchObject({ status: "warn", optional: true });
    expect(chrome.action).toContain("never downloads a browser");
    expect(await outcome(report, "check")).toBe("abnormal");
    expect(s.install).not.toHaveBeenCalled();
    expect(s.runs).toEqual([]);
  });

  it("installs missing obscura through the verified installer, re-checks, and is idempotent", async () => {
    const s = await setup({ version: "0.2.4" });
    const first = await s.provider.install(s.ctx);
    const managed = managedBinaryPath(s.agentDir, "0.2.4", "linux");
    expect(item(first, "obscura binary")).toMatchObject({ status: "installed" });
    expect(item(first, "obscura binary")!.detail).toContain(`v0.2.4 (fake.tar.gz, sha256 aaaaaaaaaaaa…) -> ${managed}`);
    expect(s.runs).toContainEqual([managed, "--version"]);
    expect(await outcome(first, "install")).toBe("installed");
    const second = await s.provider.install(s.ctx);
    expect(item(second, "obscura binary")).toMatchObject({ status: "ok" });
    expect(item(second, "obscura binary")!.detail).toMatch(/^already available: /);
    expect(await outcome(second, "install")).toBe("already available");
    expect(s.installed).toEqual(["0.2.4"]);
    // The configured version is used and never persisted.
    expect(JSON.parse(await readFile(join(s.agentDir, "browser.config.json"), "utf8"))).toEqual({ version: "0.2.4" });
  });

  it("joins an install that is already running", async () => {
    const s = await setup();
    const [a, b] = [s.provider.install(s.ctx), s.provider.install(s.ctx)];
    expect(a).toBe(b);
    await a;
    expect(s.install).toHaveBeenCalledTimes(1);
  });

  it("reports an installer failure as failed with a manual action", async () => {
    const s = await setup({}, { installObscura: async () => { throw new Error("Checksum mismatch for x\nsecond line"); } });
    const report = await s.provider.install(s.ctx);
    expect(item(report, "obscura binary")).toMatchObject({ status: "failed", detail: "install of v0.2.3 failed: Checksum mismatch for x | second line" });
    expect(item(report, "obscura binary")!.action).toContain("Retry /browser install");
    expect(await outcome(report, "install")).toBe("failed");
  });

  it("reports a broken binaryPath override as manual instead of installing behind it", async () => {
    const s = await setup({ binaryPath: "/nonexistent/obscura" });
    const userConfig = join(s.agentDir, "browser.config.json");
    const check = await s.provider.check(s.ctx);
    expect(item(check, "obscura binary")).toMatchObject({ status: "error" });
    expect(item(check, "obscura binary")!.detail).toContain("binaryPath /nonexistent/obscura is not an executable file");
    expect(item(check, "obscura binary")!.action).toContain(`Fix or remove binaryPath in ${userConfig}`);
    const install = await s.provider.install(s.ctx);
    expect(item(install, "obscura binary")).toMatchObject({ status: "manual" });
    expect(item(install, "obscura binary")!.action).toContain("or run /browser install to download v0.2.3");
    expect(s.install).not.toHaveBeenCalled();
  });

  it("warns about an ignored broken override when a later candidate resolves", async () => {
    const s = await setup({}, { env: { PI_BROWSER_OBSCURA_BIN: "/missing/obscura" } });
    const bin = await script(join(s.root, "bin", "obscura"), "echo obscura 0.2.3");
    s.options.pathDirs!.push(dirname(bin));
    const report = await s.provider.check(s.ctx);
    expect(item(report, "obscura binary")).toMatchObject({ status: "ok" });
    expect(item(report, "obscura override PI_BROWSER_OBSCURA_BIN")).toMatchObject({
      status: "warn", optional: true, action: "Fix or unset the PI_BROWSER_OBSCURA_BIN environment variable, then restart pi",
    });
  });

  it("flags a broken user binary from its --version probe and never replaces it", async () => {
    const s = await setup();
    const bin = await script(join(s.root, "bin", "obscura"), "echo 'error while loading shared libraries: libfoo.so' >&2; exit 127");
    await writeFile(join(s.agentDir, "browser.config.json"), JSON.stringify({ binaryPath: bin }));
    const check = await s.provider.check(s.ctx);
    expect(item(check, "obscura binary")).toMatchObject({ status: "error" });
    expect(item(check, "obscura binary")!.detail).toContain("shared libraries");
    expect(item(check, "obscura binary")!.detail).toContain("glibc 2.35+");
    expect(item(check, "obscura binary")!.action).toContain("Fix or remove binaryPath in");
    const install = await s.provider.install(s.ctx);
    expect(item(install, "obscura binary")).toMatchObject({ status: "manual" });
    expect(s.install).not.toHaveBeenCalled();
  });

  it("reinstalls a broken managed binary through the installer", async () => {
    const s = await setup();
    await script(managedBinaryPath(s.agentDir, "0.2.3", "linux"), "echo obscura 0.1.0");
    const check = await s.provider.check(s.ctx);
    expect(item(check, "obscura binary")).toMatchObject({ status: "error" });
    expect(item(check, "obscura binary")!.detail).toContain('reports "obscura 0.1.0", expected v0.2.3');
    expect(item(check, "obscura binary")!.action).toContain("Run /browser install-deps to reinstall");
    const install = await s.provider.install(s.ctx);
    expect(item(install, "obscura binary")).toMatchObject({ status: "installed" });
    expect(s.install).toHaveBeenCalledTimes(1);
  });

  it("reports config errors with the file to fix and without quoting secrets", async () => {
    const s = await setup();
    const userConfig = join(s.agentDir, "browser.config.json");
    await writeFile(userConfig, '{"proxy": "http://user:hunter2@proxy.example:8080", oops}');
    const projectConfig = join(s.cwd, ".pi", "browser.config.json");
    await mkdir(dirname(projectConfig), { recursive: true });
    await writeFile(projectConfig, JSON.stringify({ timeoutMs: -1 }));
    const report = await s.provider.check(s.ctx);
    const errors = report.items.filter(entry => entry.name === "browser config");
    expect(errors.map(entry => entry.status)).toEqual(["error", "error"]);
    expect(errors[0]!.action).toContain(`Fix ${userConfig}`);
    expect(errors[1]!.action).toContain(`Fix ${projectConfig}`);
    expect(errors[1]!.detail).toContain("timeoutMs must be");
    expect(JSON.stringify(report)).not.toContain("hunter2");
  });

  it("does not download for an unsupported platform or an old glibc", async () => {
    const unsupported = await setup({}, { arch: "ia32" });
    const report = await unsupported.provider.install(unsupported.ctx);
    expect(item(report, "platform")).toMatchObject({ status: "manual" });
    expect(item(report, "platform")!.action).toContain("Build obscura from source");
    expect(item(report, "obscura binary")).toMatchObject({ status: "manual" });
    expect(unsupported.install).not.toHaveBeenCalled();

    const old = await setup({}, { glibcVersion: () => "2.31" });
    const oldReport = await old.provider.install(old.ctx);
    expect(item(oldReport, "glibc")).toMatchObject({ status: "manual", detail: "2.31; obscura release binaries need 2.35+" });
    expect(item(oldReport, "glibc")!.action).toContain("Ubuntu 22.04+");
    expect(old.install).not.toHaveBeenCalled();

    const musl = await setup({}, { glibcVersion: () => undefined });
    const muslReport = await musl.provider.check(musl.ctx);
    expect(item(muslReport, "glibc")).toMatchObject({ status: "unverified" });
    expect(item(muslReport, "glibc")!.action).toContain("ldd --version");
  });

  it("makes Chrome required when it is the default engine, and skips it when disabled", async () => {
    const required = await setup({ engine: "chrome" }, { chromeExists: () => false });
    const report = await required.provider.check(required.ctx);
    expect(item(report, "Chrome browser")).toMatchObject({ status: "error" });
    expect(item(report, "Chrome browser")!.optional).toBeUndefined();
    const install = await required.provider.install(required.ctx);
    expect(item(install, "Chrome browser")).toMatchObject({ status: "manual" });

    const disabled = await setup({ chrome: { enabled: false } });
    const off = await disabled.provider.check(disabled.ctx);
    expect(item(off, "Chrome engine")).toMatchObject({ status: "ok", optional: true });
    expect(item(off, "Chrome browser")).toBeUndefined();
  });

  it("finds Chrome in its Linux default location without PATH entries", async () => {
    const s = await setup({}, { chromeExists: path => path === "/opt/google/chrome/chrome" });
    const report = await s.provider.check(s.ctx);
    expect(item(report, "Chrome browser")).toMatchObject({ status: "ok", optional: true, detail: "/opt/google/chrome/chrome" });
  });

  it("installs a missing chrome-devtools-mcp with npm and reports npm failures", async () => {
    for (const code of [0, 1]) {
      const s = await setup({}, { env: { PATH: process.env.PATH } });
      const marker = join(s.packageDir, "node_modules", "chrome-devtools-mcp", "package.json");
      s.options.chromeServer = () => {
        if (!existsSync(marker)) throw new Error("Cannot find module");
        return { bin: join(dirname(marker), "index.js"), version: "1.10.1" };
      };
      const npm = vi.fn(async (command: string, args: string[], opts: { cwd?: string } = {}): Promise<RunResult> => {
        expect([command, ...args]).toEqual(["npm", "install", "--legacy-peer-deps", "--no-audit", "--no-fund"]);
        expect(opts.cwd).toBe(s.packageDir);
        if (code === 0) { await mkdir(dirname(marker), { recursive: true }); await writeFile(marker, "{}"); }
        return { code, stdout: "", stderr: code ? "npm ERR! network" : "" };
      });
      s.options.npmRun = npm;
      const check = await s.provider.check(s.ctx);
      expect(item(check, "chrome-devtools-mcp npm package")).toMatchObject({ status: "warn", optional: true });
      expect(item(check, "chrome-devtools-mcp npm package")!.action).toContain("/browser install-deps");
      expect(npm).not.toHaveBeenCalled();
      const report = await s.provider.install(s.ctx);
      expect(npm).toHaveBeenCalledTimes(1);
      const entry = item(report, "chrome-devtools-mcp npm package")!;
      if (code === 0) expect(entry).toMatchObject({ status: "installed", optional: true });
      else {
        expect(entry).toMatchObject({ status: "failed", optional: true });
        expect(entry.detail).toContain("npm ERR! network");
        expect(entry.action).toContain(`cd ${s.packageDir} && npm install --legacy-peer-deps`);
      }
    }
  });

  it("probes a configured browserUrl without showing credentials", async () => {
    const urls: string[] = [];
    const up = await setup({ chrome: { browserUrl: "http://me:secret@127.0.0.1:9222" } }, {
      fetch: (async (url: URL) => { urls.push(String(url)); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch,
    });
    const ok = await up.provider.check(up.ctx);
    expect(item(ok, "Chrome browser")).toMatchObject({ status: "ok", detail: "attaches to http://127.0.0.1:9222 (chrome.browserUrl); DevTools endpoint answers" });
    expect(urls).toEqual(["http://127.0.0.1:9222/json/version"]);

    const down = await setup({ chrome: { browserUrl: "http://me:secret@127.0.0.1:9222" } }, {
      fetch: (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    const report = await down.provider.check(down.ctx);
    expect(item(report, "Chrome browser")).toMatchObject({ status: "warn", optional: true });
    expect(item(report, "Chrome browser")!.action).toContain("--remote-debugging-port");
    expect(JSON.stringify([ok, report])).not.toContain("secret");
  });
});

describe.skipIf(process.platform === "win32")("/browser doctor and install-deps", () => {
  const probes = { platform: "linux" as const, arch: "x64", glibcVersion: () => "2.39", chromeExists: () => true, chromeServer: () => ({ bin: "/fake/server.js", version: "1.10.1" }) };
  async function harness(options: Parameters<typeof createHarness>[0] = {}) {
    const h = await createHarness(options); open.push(h); return h;
  }

  it("answers the umbrella's synchronous request with the browser provider", async () => {
    const h = await harness({ extension: { dependencies: probes } });
    let provided: DependencyProvider | undefined;
    h.events.emit(DEPENDENCY_CHANNEL, { version: 1, provide: (provider: DependencyProvider) => { provided = provider; } });
    expect(provided).toMatchObject({ id: "browser", label: "pi-browser", command: "/browser" });
    const report = await provided!.check({ cwd: h.cwd, isProjectTrusted: () => true });
    expect(item(report, "obscura binary")).toMatchObject({ status: "ok" });
  });

  it("doctor notifies the formatted report without starting or installing anything", async () => {
    const install = installer();
    const h = await harness({ extension: { dependencies: probes, install } });
    await h.session.prompt("/browser doctor");
    const note = h.notifications.at(-1)!;
    expect(note.type).toBe("info");
    expect(note.message.split("\n")[0]).toBe("pi-browser doctor: healthy");
    expect(note.message).toContain(`[ok] obscura binary: ${process.execPath} (config) reports`);
    expect(install).not.toHaveBeenCalled();
    expect(h.children).toHaveLength(0);
    expect(h.confirmations).toEqual([]);
  });

  it("install-deps installs obscura once, then reports it as already available", async () => {
    const install = installer();
    const h = await harness({ config: { binaryPath: null }, extension: { env: {}, pathDirs: [], dependencies: probes, install } });
    const configBefore = await readFile(join(h.agentDir, "browser.config.json"), "utf8");
    await h.session.prompt("/browser install-deps");
    expect(h.notifications.at(-1)!.message.split("\n")[0]).toBe("pi-browser install-deps: installed");
    expect(h.notifications.at(-1)!.message).toContain("[installed] obscura binary: v0.2.3");
    expect(h.statuses).toContainEqual({ key: "browser", text: "browser: installing dependencies…" });
    expect(h.statuses.at(-1)).toEqual({ key: "browser", text: "browser: idle" });
    await h.session.prompt("/browser status");
    expect(h.notifications.at(-1)!.message).toContain(`Binary: ${managedBinaryPath(h.agentDir, "0.2.3")} (cache)`);
    await h.session.prompt("/browser install-deps");
    expect(h.notifications.at(-1)).toMatchObject({ type: "info", message: expect.stringMatching(/^pi-browser install-deps: already available\n/) });
    expect(install).toHaveBeenCalledTimes(1);
    expect(await readFile(join(h.agentDir, "browser.config.json"), "utf8")).toBe(configBefore);
  });

  it("doctor reports a missing binary as abnormal with the install action", async () => {
    const h = await harness({ config: { binaryPath: null }, extension: { env: {}, pathDirs: [], dependencies: probes } });
    await h.session.prompt("/browser doctor");
    expect(h.notifications.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("-> Run /browser install-deps") });
    expect(h.notifications.at(-1)!.message.split("\n")[0]).toBe("pi-browser doctor: abnormal");
  });

  it.each(["doctor now", "install-deps 0.2.3", "Doctor", "install-deps extra"])("keeps the strict grammar for %j", async (args) => {
    const install = installer();
    const h = await harness({ extension: { dependencies: probes, install } });
    await h.session.prompt(`/browser ${args}`);
    expect(h.notifications.at(-1)).toEqual({ message: BROWSER_USAGE, type: "warning" });
    expect(install).not.toHaveBeenCalled();
  });

  it("still parses install [version] and completes the new subcommands", async () => {
    const install = installer();
    const h = await harness({ config: { binaryPath: null }, extension: { env: {}, pathDirs: [], dependencies: probes, install } });
    await h.session.prompt("/browser install 0.2.4");
    expect(install.mock.calls[0]![0]).toMatchObject({ version: "0.2.4" });
    expect(BROWSER_USAGE).toContain("| doctor | install-deps |");
    expect(completeBrowserArguments("in")?.map(entry => entry.value)).toEqual(["install-deps", "install"]);
    expect(completeBrowserArguments("d")?.map(entry => entry.value)).toEqual(["doctor"]);
  });
});
