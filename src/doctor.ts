// pi-browser's dependency provider for `/browser doctor`, `/browser install-deps` and the umbrella's
// `/oh-my-pi doctor|install-deps` (contract: ./dependencies.ts). It reuses the package's own logic: loadBrowserConfig,
// resolveObscuraBinary, releaseAsset, the verified/atomic obscura installer (injected by the extension so overlapping
// `/browser install` runs share one download) and chromeAvailability.
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { managedBinaryPath, releaseAsset, resolveObscuraBinary, type BinaryResolution } from "./binary.js";
import { loadBrowserConfig, type BrowserConfig } from "./config.js";
import {
  installNpmDependencies, outputTail, runProcess,
  type DependencyItem, type DependencyMode, type DependencyProvider, type DependencyReport,
} from "./dependencies.js";
import { buildChildEnv } from "./engines/obscura.js";
import { chromeAvailability, resolveChromeServer } from "./engines/chrome.js";
import type { InstallObscuraResult } from "./install.js";

/** The part of Pi's command context the provider needs. */
export interface DoctorContext {
  cwd: string;
  isProjectTrusted(): boolean;
}

/** Probes that tests (and embedders) replace; defaults inspect the real system read-only. */
export interface BrowserDependencyProbes {
  platform?: NodeJS.Platform;
  arch?: string;
  /** Runtime glibc version ("2.35"), undefined when Node reports none (musl or non-Linux). */
  glibcVersion?: () => string | undefined;
  /** Runs `obscura --version` (bounded). */
  run?: typeof runProcess;
  /** Runs npm for installNpmDependencies. */
  npmRun?: typeof runProcess;
  /** pi-browser's package directory (package.json, node_modules). */
  packageDir?: string;
  /** Resolves the pinned chrome-devtools-mcp server; throws when it is not installed. */
  chromeServer?: () => { bin: string; version?: string };
  /** Whether a Chrome executable exists (chromeAvailability's check). */
  chromeExists?: (path: string) => boolean;
  /** HTTP probe of a configured chrome.browserUrl. */
  fetch?: typeof fetch;
}

export interface BrowserDependencyOptions<Context extends DoctorContext = DoctorContext> extends BrowserDependencyProbes {
  agentDir: string;
  env?: NodeJS.ProcessEnv;
  pathDirs?: string[];
  /** The verified, atomic obscura install of `/browser install` for `config.version` (never persists a version). */
  installObscura: (ctx: Context, config: BrowserConfig) => Promise<InstallObscuraResult>;
}

export const PROBE_TIMEOUT_MS = 5_000;
const OBSCURA_REPO = "https://github.com/h4ckf0r0day/obscura";
const require = createRequire(import.meta.url);
const defaultPackageDir = fileURLToPath(new URL("..", import.meta.url));

function defaultChromeServer(): { bin: string; version?: string } {
  const pkg = JSON.parse(readFileSync(require.resolve("chrome-devtools-mcp/package.json"), "utf8")) as { version?: string };
  return { bin: resolveChromeServer(), version: pkg.version };
}

function defaultGlibcVersion(): string | undefined {
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    return report?.header?.glibcVersionRuntime;
  } catch { return undefined; }
}

/** The executable test of resolveObscuraBinary (a missing or non-executable candidate is skipped there). */
function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch { return false; }
}

function atLeast(version: string, major: number, minor: number): boolean {
  const [a = 0, b = 0] = version.split(".").map(Number);
  return a > major || (a === major && b >= minor);
}

/** Config error texts can quote file content (JSON parse errors): drop quoted snippets and URL credentials. */
function sanitize(message: string): string {
  return message.replace(/"(?:[^"\\]|\\.)*"\s+is not valid JSON/g, "invalid JSON").replace(/\/\/[^/\s@]+@/g, "//***@");
}

/** Origin of a URL without credentials, path or query. */
function origin(url: string): string {
  try { const parsed = new URL(url); return `${parsed.protocol}//${parsed.host}`; } catch { return "(invalid URL)"; }
}

const GLIBC_FAILURE = /ELF|glibc|GLIBC|exec format|shared librar|dynamic linker|ENOEXEC/i;

export function createBrowserDependencyProvider<Context extends DoctorContext>(options: BrowserDependencyOptions<Context>): DependencyProvider<Context> {
  let installing: Promise<DependencyReport> | undefined;
  const provider: DependencyProvider<Context> = {
    id: "browser",
    label: "pi-browser",
    command: "/browser",
    check: ctx => inspect(options, ctx, "check"),
    // One install at a time per session: a second request joins the running one.
    install: ctx => installing ??= inspect(options, ctx, "install").finally(() => { installing = undefined; }),
  };
  return provider;
}

async function inspect<Context extends DoctorContext>(o: BrowserDependencyOptions<Context>, ctx: Context, mode: DependencyMode): Promise<DependencyReport> {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const packageDir = o.packageDir ?? defaultPackageDir;
  const userConfig = join(o.agentDir, "browser.config.json");
  const projectConfig = join(ctx.cwd, ".pi", "browser.config.json");
  const loaded = await loadBrowserConfig({ cwd: ctx.cwd, agentDir: o.agentDir, projectTrusted: ctx.isProjectTrusted() });
  const config = loaded.config;
  /** The applied config file that sets `key` ("chrome.x" for nested keys), else the user config. */
  const fileFor = (key: string): string => {
    const [top, nested] = key.split(".") as [string, string | undefined];
    for (const path of [...loaded.sources].reverse()) {
      try {
        const values = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        const scope = nested ? values[top] as Record<string, unknown> | undefined : values;
        if (scope && Object.hasOwn(scope, nested ?? top)) return path;
      } catch { /* The file was valid at load time; fall through. */ }
    }
    return userConfig;
  };
  const items: DependencyItem[] = [];

  // Configuration: an invalid file is ignored as a whole, so its settings silently do not apply.
  if (loaded.errors.length === 0) {
    items.push({ name: "browser config", status: "ok", detail: loaded.sources.length ? loaded.sources.join(", ") : "defaults (no browser.config.json)" });
  } else {
    for (const error of loaded.errors) {
      const file = [projectConfig, userConfig].find(path => error.startsWith(`${path}: `)) ?? userConfig;
      items.push({
        name: "browser config", status: "error", detail: `${sanitize(error)} (the whole file is ignored)`,
        action: `Fix ${file} (see the Configuration section of the pi-browser README), then run /browser restart`,
      });
    }
  }

  // Platform and libc for the published release binaries.
  const resolution: BinaryResolution = resolveObscuraBinary({ config, agentDir: o.agentDir, env, platform, pathDirs: o.pathDirs });
  const asset = releaseAsset({ platform, arch, variant: config.variant });
  const target = `${platform}/${arch}`;
  const buildFromSourceStep = `build obscura from source (${OBSCURA_REPO}) and set binaryPath in ${userConfig} or PI_BROWSER_OBSCURA_BIN`;
  const buildFromSource = `B${buildFromSourceStep.slice(1)}`;
  if (asset) items.push({ name: "platform", status: "ok", detail: `${target}: release asset ${asset}` });
  else if (resolution.ok) items.push({ name: "platform", status: "ok", detail: `${target} has no obscura release binary; using the ${resolution.source} binary ${resolution.path}` });
  else items.push({ name: "platform", status: "manual", detail: `${target} has no obscura release binary (released: Linux/macOS x86_64 and aarch64, Windows x86_64)`, action: buildFromSource });

  const needsRelease = !resolution.ok || resolution.source === "cache";
  let glibcTooOld = false;
  if (platform === "linux" && asset) {
    const glibc = (o.glibcVersion ?? defaultGlibcVersion)();
    const own = resolution.ok && resolution.source !== "cache" ? `; not required by the ${resolution.source} binary in use` : "";
    if (glibc === undefined) {
      items.push(needsRelease
        ? { name: "glibc", status: "unverified", detail: "Node reports no glibc (musl or another C library?)", action: `Run ldd --version: obscura release binaries need glibc 2.35+ (Ubuntu 22.04+); otherwise ${buildFromSourceStep}` }
        : { name: "glibc", status: "ok", detail: `not reported by Node${own}` });
    } else if (atLeast(glibc, 2, 35)) {
      items.push({ name: "glibc", status: "ok", detail: `${glibc} (release binaries need 2.35+)` });
    } else if (needsRelease) {
      glibcTooOld = true;
      items.push({ name: "glibc", status: "manual", detail: `${glibc}; obscura release binaries need 2.35+`, action: `Upgrade to a distribution with glibc 2.35+ (e.g. Ubuntu 22.04+), or ${buildFromSourceStep}` });
    } else {
      items.push({ name: "glibc", status: "ok", detail: `${glibc} (< 2.35)${own}` });
    }
  }

  // obscura (required): binaryPath -> PI_BROWSER_OBSCURA_BIN -> PATH -> managed cache for config.version.
  const managed = managedBinaryPath(o.agentDir, config.version, platform);
  const overrides = [
    config.binaryPath ? { setting: "binaryPath", path: config.binaryPath, fix: `Fix or remove binaryPath in ${fileFor("binaryPath")}` } : undefined,
    env.PI_BROWSER_OBSCURA_BIN ? { setting: "PI_BROWSER_OBSCURA_BIN", path: env.PI_BROWSER_OBSCURA_BIN, fix: "Fix or unset the PI_BROWSER_OBSCURA_BIN environment variable, then restart pi" } : undefined,
  ].filter(entry => entry !== undefined);
  const broken = overrides.filter(entry => !isExecutableFile(resolve(entry.path), platform));
  const probe = async (path: string): Promise<{ ok: true; version: string } | { ok: false; error: string }> => {
    const result = await (o.run ?? runProcess)(path, ["--version"], { env: buildChildEnv(env), timeoutMs: PROBE_TIMEOUT_MS });
    const version = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? "";
    if (result.code !== 0) return { ok: false, error: `--version failed: ${outputTail(result) || `exit ${result.code}`}` };
    return { ok: true, version };
  };
  const fixFor = (found: { path: string; source: string }): string => {
    switch (found.source) {
      case "config": return `${overrides[0]?.fix ?? "Fix binaryPath"}, then run /browser restart`;
      case "env": return "Fix or unset the PI_BROWSER_OBSCURA_BIN environment variable, then restart pi";
      case "path": return `Replace or remove ${found.path} on PATH, or set binaryPath in ${userConfig} to a working obscura`;
      default: return `Run /browser install-deps to reinstall the verified v${config.version} release into ${managed}`;
    }
  };
  const glibcHint = (error: string) => platform === "linux" && GLIBC_FAILURE.test(error) ? " (obscura release binaries need glibc 2.35+, Ubuntu 22.04+)" : "";
  const missingDetail = () => [
    ...overrides.map(entry => `${entry.setting} ${entry.path} is not an executable file`),
    env.PI_BROWSER_OBSCURA_BIN ? undefined : "PI_BROWSER_OBSCURA_BIN not set",
    "not on PATH",
    `managed cache ${managed} missing`,
  ].filter(Boolean).join("; ");

  let obscuraItem: DependencyItem;
  let current = resolution;
  let probed = current.ok ? await probe(current.path) : undefined;
  // A managed binary must be the configured release; other sources may be any build.
  if (current.ok && probed?.ok && current.source === "cache" && !probed.version.includes(config.version)) {
    probed = { ok: false, error: `reports "${probed.version}", expected v${config.version}` };
  }
  if (current.ok && probed?.ok) {
    obscuraItem = { name: "obscura binary", status: "ok", detail: `${mode === "install" ? "already available: " : ""}${current.path} (${current.source}) reports "${probed.version}"` };
  } else if (mode === "check" || (current.ok && current.source !== "cache")) {
    // check, or install with a broken user-provided binary: never install behind or over the user's choice.
    if (current.ok && probed && !probed.ok) {
      obscuraItem = { name: "obscura binary", status: mode === "check" ? "error" : "manual", detail: `${current.path} (${current.source}) ${probed.error}${glibcHint(probed.error)}`, action: fixFor(current) };
    } else {
      const action = broken.length
        ? `${broken.map(entry => entry.fix).join("; ")}; or run /browser install to download v${config.version} into ${managed} behind the override`
        : !asset ? buildFromSource
        : glibcTooOld ? "See the glibc item"
        : `Run /browser install-deps (downloads the verified v${config.version} release into ${managed}), or set binaryPath / PI_BROWSER_OBSCURA_BIN, or put obscura on PATH`;
      obscuraItem = { name: "obscura binary", status: "error", detail: `not found: ${missingDetail()}`, action };
    }
  } else if (!current.ok && broken.length) {
    // Documented choice: a configured but broken override is the user's to fix; /browser install still installs behind it.
    obscuraItem = { name: "obscura binary", status: "manual", detail: `not found: ${missingDetail()}`, action: `${broken.map(entry => entry.fix).join("; ")}; or run /browser install to download v${config.version} into ${managed} behind the override` };
  } else if (!asset) {
    obscuraItem = { name: "obscura binary", status: "manual", detail: `no release binary for ${target}`, action: buildFromSource };
  } else if (glibcTooOld) {
    obscuraItem = { name: "obscura binary", status: "manual", detail: "the release binary would not run on this glibc", action: "See the glibc item" };
  } else {
    // Not found, or the managed binary is broken: the verified, atomic `/browser install` path for config.version.
    const before = current.ok && probed && !probed.ok ? `managed ${current.path} ${probed.error}; ` : "";
    const retry = `Retry /browser install (shows download progress), or provision obscura manually (see the README "Binary provisioning") and set binaryPath / PI_BROWSER_OBSCURA_BIN`;
    try {
      const installed = await o.installObscura(ctx, config);
      current = resolveObscuraBinary({ config, agentDir: o.agentDir, env, platform, pathDirs: o.pathDirs });
      probed = current.ok ? await probe(current.path) : undefined;
      if (current.ok && probed?.ok) {
        obscuraItem = { name: "obscura binary", status: "installed", detail: `${before}v${installed.version} (${installed.asset}, sha256 ${installed.sha256.slice(0, 12)}…) -> ${installed.path}${current.source !== "cache" ? `; resolution uses ${current.source}: ${current.path}` : ""}` };
      } else {
        const error = current.ok && probed && !probed.ok ? probed.error : "still not resolvable after install";
        obscuraItem = { name: "obscura binary", status: "failed", detail: `${before}installed v${installed.version} to ${installed.path}, but ${error}${glibcHint(error)}`, action: retry };
      }
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).split(/\r?\n/).filter(Boolean).join(" | ");
      obscuraItem = { name: "obscura binary", status: "failed", detail: `${before}install of v${config.version} failed: ${message}`, action: retry };
    }
  }
  items.push(obscuraItem);
  if (current.ok) {
    for (const entry of broken) {
      items.push({ name: `obscura override ${entry.setting}`, status: "warn", optional: true, detail: `${entry.path} is not an executable file; ignored, using the ${current.source} binary ${current.path}`, action: entry.fix });
    }
  }

  // Chrome engine: optional unless config makes it the default engine.
  const required = config.engine === "chrome";
  const optional = required ? {} : { optional: true as const };
  const missingStatus = mode === "install" ? "manual" as const : required ? "error" as const : "warn" as const;
  if (!config.chrome.enabled) {
    items.push(required
      ? { name: "Chrome engine", status: "error", detail: 'engine is "chrome" but chrome.enabled is false', action: `Set chrome.enabled to true, or engine to "auto" or "obscura", in ${fileFor("engine")}` }
      : { name: "Chrome engine", status: "ok", optional: true, detail: "disabled in config (chrome.enabled: false)" });
    return { items };
  }

  const serverName = "chrome-devtools-mcp npm package";
  const pinned = (() => {
    try { return (JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { dependencies?: Record<string, string> }).dependencies?.["chrome-devtools-mcp"]; }
    catch { return undefined; }
  })();
  const findServer = () => { try { return (o.chromeServer ?? defaultChromeServer)(); } catch { return undefined; } };
  const npmAction = `cd ${packageDir} && npm install --legacy-peer-deps`;
  let server = findServer();
  if (server) {
    if (pinned && server.version && server.version !== pinned) {
      items.push({ name: serverName, status: "warn", optional: true, detail: `${server.version} installed, pinned ${pinned}`, action: `Run: ${npmAction}, then /reload` });
    } else {
      items.push({ name: serverName, status: "ok", ...optional, detail: `${mode === "install" ? "already installed: " : ""}${server.version ?? "version unknown"} (${server.bin})` });
    }
  } else if (mode === "check") {
    items.push({ name: serverName, status: required ? "error" : "warn", ...optional, detail: "not installed (the Chrome engine needs it; it is never fetched with npx)", action: `Run /browser install-deps (runs npm install --legacy-peer-deps in ${packageDir})` });
  } else {
    const result = await installNpmDependencies(packageDir, { env, run: o.npmRun, reinstallHint: "Reinstall pi-browser with pi install (or pi update --extensions), then /reload" });
    server = findServer();
    for (const item of result) {
      const named = { ...item, name: item.name === "npm dependencies" ? serverName : item.name, ...optional };
      if (named.name === serverName && (named.status === "installed" || named.status === "ok") && !server) {
        items.push({ ...named, status: "failed", detail: `${item.detail ?? "npm finished"}, but chrome-devtools-mcp still does not resolve`, action: `Run by hand and read the error: ${npmAction}` });
      } else items.push(named);
    }
  }

  // Chrome itself is never downloaded: an override, an attach URL, or an installed Chrome.
  const installChrome = `Install Google Chrome (https://www.google.com/chrome/) or Chromium with your system package manager, or set chrome.executablePath / chrome.browserUrl in ${userConfig}; pi-browser never downloads a browser`;
  if (config.chrome.executablePath) {
    const found = chromeAvailability(config, env, { pathDirs: o.pathDirs, platform, exists: o.chromeExists, resolveServer: () => "" });
    items.push(found.ok
      ? { name: "Chrome browser", status: "ok", ...optional, detail: `${config.chrome.executablePath} (chrome.executablePath)` }
      : { name: "Chrome browser", status: missingStatus, ...optional, detail: `chrome.executablePath ${config.chrome.executablePath} is not an executable file`, action: `Fix or remove chrome.executablePath in ${fileFor("chrome.executablePath")}` });
  } else if (config.chrome.browserUrl) {
    const where = origin(config.chrome.browserUrl);
    let detail: string | undefined;
    try {
      const url = new URL(config.chrome.browserUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") detail = `cannot probe ${url.protocol} URLs`;
      else {
        const response = await (o.fetch ?? fetch)(new URL("/json/version", `${url.protocol}//${url.host}`), { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        await response.body?.cancel().catch(() => {});
        if (!response.ok) detail = `${where} answered HTTP ${response.status}`;
      }
    } catch (error) { detail = `${where} not reachable (${error instanceof Error ? error.message : String(error)})`; }
    if (detail === undefined) items.push({ name: "Chrome browser", status: "ok", ...optional, detail: `attaches to ${where} (chrome.browserUrl); DevTools endpoint answers` });
    else if (detail.startsWith("cannot probe")) items.push({ name: "Chrome browser", status: "unverified", ...optional, detail: `attaches to ${where} (chrome.browserUrl); ${detail}`, action: "Open the DevTools endpoint in a browser (/json/version) to confirm Chrome runs with remote debugging" });
    else items.push({ name: "Chrome browser", status: missingStatus, ...optional, detail: `chrome.browserUrl: ${detail}`, action: `Start Chrome with --remote-debugging-port matching ${where}, or fix/remove chrome.browserUrl in ${fileFor("chrome.browserUrl")}` });
  } else {
    const found = chromeAvailability(config, env, { pathDirs: o.pathDirs, platform, exists: o.chromeExists, resolveServer: () => "" });
    items.push(found.ok && found.executablePath
      ? { name: "Chrome browser", status: "ok", ...optional, detail: found.executablePath }
      : { name: "Chrome browser", status: missingStatus, ...optional, detail: "Google Chrome not found on PATH or in its default location", action: installChrome });
  }
  return { items };
}
