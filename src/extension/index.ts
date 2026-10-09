import type { ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type, type TSchema } from "@sinclair/typebox";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { managedBinaryPath, managedCacheDir, resolveObscuraBinary, type BinaryResolution } from "../binary.js";
import { DEFAULT_BROWSER_CONFIG, isValidProfileName, loadBrowserConfig, validateBrowserConfig, type BrowserConfig, type LoadedBrowserConfig } from "../config.js";
import { storageState } from "../actions.js";
import { installObscura, type InstallObscuraResult } from "../install.js";
import { buildObscuraArgs, ObscuraEngine } from "../engines/obscura.js";
import { EngineManager, type Availability } from "../manager.js";
import { ChromeEngine, chromeAvailability, buildChromeArgs } from "../engines/chrome.js";
import type { BrowserEngine, EngineName } from "../engine.js";
import { toolExposure, deferredToolGuideline } from "../exposure.js";
import { registerFetchTool } from "../fetch.js";
import { defaultSpillDir, mcpContentToToolContent, type McpContent } from "../output.js";
import { summarizePage } from "../page.js";
import { registerInteractionTools } from "./tools.js";
import { decodeEvaluation, wrapExpression } from "../evaluate.js";
import { applyPendingStorage, restoreStorageState, validateRestorableState } from "../state.js";
import { completeBrowserArguments } from "./completions.js";
export { decodeEvaluation, wrapExpression } from "../evaluate.js";

export interface BrowserExtensionOptions {
  agentDir?: string;
  launch?: () => ChildProcess;
  /** Test/embedding seam: launch a piped Chrome MCP child instead of the bundled server. */
  launchChrome?: () => ChildProcess;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  pathDirs?: string[];
  install?: typeof installObscura;
  launchFetch?: (args: string[]) => ChildProcess;
  fetchKillGraceMs?: number;
  engineFactories?: Partial<Record<EngineName, () => BrowserEngine>>;
  engineAvailability?: Partial<Record<EngineName, () => Availability>>;
  onManager?: (manager: EngineManager) => void;
}

export const BROWSER_USAGE = "Usage: /browser status | engine [obscura|chrome] | stop | restart | install [version] | allow-private-network on|off | profile save|load|clear [name] (stop: all engines; restart: active engine)";
const REF_GUIDELINE = "Browser refs are engine-specific and are invalidated by every action and navigation; use the refs from the latest result.";


export function createBrowserExtension(options: BrowserExtensionOptions = {}) {
  return function browserExtension(pi: ExtensionAPI): void {
    const agentDir = options.agentDir ?? getAgentDir();
    const now = options.now ?? Date.now;
    let loaded: LoadedBrowserConfig = { config: { ...DEFAULT_BROWSER_CONFIG }, sources: [], errors: [] };
    let resolution: BinaryResolution | undefined;
    let manager: EngineManager | undefined;
    let obscura: ObscuraEngine | undefined;
    let context: ExtensionContext | undefined;
    let loading: Promise<void> | undefined;
    let installing: Promise<InstallObscuraResult> | undefined;
    let ensuring: Promise<string> | undefined;
    let installController: AbortController | undefined;
    let rawRegistration: string | undefined;
    const profileWarnings = new Set<string>();
    const updateUserConfig = async (patch: Partial<BrowserConfig>): Promise<string> => {
      const path = join(agentDir, "browser.config.json");
      let values: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path}: expected a JSON object`);
        values = parsed as Record<string, unknown>;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      Object.assign(values, patch);
      // Preserve unrelated keys, but validate every known browser setting before writing.
      validateBrowserConfig(Object.fromEntries(Object.entries(values).filter(([key]) => Object.hasOwn(DEFAULT_BROWSER_CONFIG, key))));
      await mkdir(agentDir, { recursive: true });
      await writeFile(path, JSON.stringify(values, null, 2) + "\n", { mode: 0o600 });
      await chmod(path, 0o600);
      return path;
    };
    const warnProjectOverride = async (ctx: ExtensionContext, key: keyof BrowserConfig) => {
      const path = join(ctx.cwd, ".pi", "browser.config.json");
      if (ctx.isProjectTrusted() && loaded.sources.includes(path)) {
        const project = JSON.parse(await readFile(path, "utf8"));
        if (Object.hasOwn(project, key)) ctx.ui.notify(`browser: ${path} sets ${key}; the project value wins.`, "warning");
      }
    };
    const resolveBinary = () => (resolution = resolveObscuraBinary({ config: loaded.config, agentDir, env: options.env, pathDirs: options.pathDirs }));
    const profilePath = (name: string) => {
      if (!isValidProfileName(name)) throw new Error("Invalid profile name; use 1–64 letters, digits, underscores, dots or hyphens.");
      return join(agentDir, "pi-browser", "profiles", `${name}.json`);
    };
    const readProfile = async (name: string) => validateRestorableState(JSON.parse(await readFile(profilePath(name), "utf8")));
    const writeProfile = async (name: string, state: unknown) => {
      const path = profilePath(name);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await chmod(dirname(path), 0o700);
      await writeFile(path, JSON.stringify(storageState(state), null, 2) + "\n", { mode: 0o600 });
      await chmod(path, 0o600);
      return path;
    };
    const registerRaw = () => {
      if (!loaded.config.rawMcp || !resolution?.ok) {
        if (rawRegistration) pi.unregisterMcpServer("obscura");
        rawRegistration = undefined;
        return;
      }
      const config = { command: resolution.path, args: buildObscuraArgs(loaded.config), exposure: "codemode" as const,
        description: "Raw obscura browser MCP (37 tools); separate process and state from the curated browser_* tools." };
      const key = JSON.stringify(config);
      if (key !== rawRegistration) { pi.registerMcpServer("obscura", config); rawRegistration = key; }
    };
    const install = (ctx: ExtensionContext, version: string, signal?: AbortSignal): Promise<InstallObscuraResult> => {
      if (installing) return installing;
      installController = new AbortController();
      const abort = () => installController?.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      installing = Promise.resolve().then(() => (options.install ?? installObscura)({
        version, variant: loaded.config.variant, platform: process.platform, arch: process.arch, agentDir,
        signal: installController!.signal,
        onProgress: ({ receivedBytes, totalBytes }) => {
          if (ctx.hasUI) ctx.ui.setStatus("browser", totalBytes
            ? `browser: downloading obscura ${Math.floor(receivedBytes / totalBytes * 100)}%`
            : `browser: downloading obscura ${receivedBytes} bytes`);
        },
      })).finally(() => {
        signal?.removeEventListener("abort", abort);
        installing = undefined; installController = undefined;
        setStatus(manager?.active()?.status().running ?? false, manager?.active()?.status().pid);
      });
      return installing;
    };
    const ensureConfig = async (ctx: ExtensionContext) => {
      if (loading) await loading;
      if (!manager) { loading = load(ctx).finally(() => { loading = undefined; }); await loading; }
      context = ctx;
    };
    const ensureBinary = async (ctx: ExtensionContext, signal?: AbortSignal): Promise<string> => {
      await ensureConfig(ctx);
      signal?.throwIfAborted();
      const found = resolveBinary();
      if (found.ok) return found.path;
      if (!ensuring) {
        ensuring = (async () => {
          if (installing) await installing;
          else {
            if (loaded.config.autoInstall === "never" || !ctx.hasUI) throw new Error(found.message);
            const approved = await ctx.ui.confirm("Download obscura?", `pi-browser needs the obscura browser (v${loaded.config.version}, ~70 MB, Apache-2.0) from GitHub releases. Download to ${managedBinaryPath(agentDir, loaded.config.version)}?`);
            if (!approved) throw new Error("Obscura download declined. Run /browser install, set binaryPath or PI_BROWSER_OBSCURA_BIN, or put obscura on PATH.");
            signal?.throwIfAborted();
            await install(ctx, loaded.config.version, signal);
          }
          const installed = resolveBinary();
          if (!installed.ok) throw new Error(installed.message);
          registerRaw();
          return installed.path;
        })().finally(() => { ensuring = undefined; });
      }
      return ensuring;
    };
    const registeredNames = new Set<string>();
    const setStatus = (running: boolean, pid?: number) => {
      if (context?.hasUI) context.ui.setStatus("browser", running ? `browser: running (pid ${pid})` : "browser: idle");
    };
    const load = async (ctx: ExtensionContext) => {
      context = ctx;
      await manager?.stopAll();
      loaded = await loadBrowserConfig({ cwd: ctx.cwd, agentDir, projectTrusted: ctx.isProjectTrusted() });
      resolveBinary();
      obscura = new ObscuraEngine({
        config: loaded.config, cwd: ctx.cwd, resolveBinary: async (signal) => {
          await ensureBinary(ctx, signal);
          return resolution!;
        }, launch: options.launch, env: options.env, now,
        onStateChange: ({ running }) => {
          if (!running) manager?.engineStopped("obscura");
          const state = manager?.active()?.status();
          setStatus(state?.running ?? false, state?.pid);
        },
        onRestore: async (engine: BrowserEngine) => {
          const profile = loaded.config.profile;
          if (!profile) return;
          let state;
          try { state = await readProfile(profile); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
          await restoreStorageState(engine, state, { cwd: ctx.cwd, pending: manager!.pendingFor("obscura") });
        },
        onSave: async (engine: BrowserEngine) => {
          const profile = loaded.config.profile;
          if (profile) await writeProfile(profile, await engine.storageState());
        },
        onHookError: (error: unknown, phase: "restore" | "save") => {
          const profile = loaded.config.profile;
          const key = `${profile}/${phase}`;
          if (!profileWarnings.has(key)) {
            profileWarnings.add(key);
            context?.ui.notify(`browser: profile ${profile} ${phase} failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
          }
        },
      });
      manager = new EngineManager({ config: loaded.config,
        factories: { obscura: () => obscura!, chrome: () => new ChromeEngine({ config: loaded.config, cwd: ctx.cwd, env: options.env, pathDirs: options.pathDirs, launch: options.launchChrome,
          onStateChange: ({ running }) => { if (!running) manager?.engineStopped("chrome"); const state = manager?.active()?.status(); setStatus(state?.running ?? false, state?.pid); },
        }), ...options.engineFactories },
        availability: {
          obscura: () => {
            const found = resolveBinary();
            return found.ok || (loaded.config.autoInstall === "ask" && ctx.hasUI) ? { ok: true } : { ok: false, reason: found.message };
          },
          chrome: () => options.launchChrome && loaded.config.chrome.enabled ? { ok: true } : chromeAvailability(loaded.config, options.env ?? process.env, { pathDirs: options.pathDirs }), ...options.engineAvailability,
        },
        onStateChange: () => {
          const state = manager?.active()?.status();
          setStatus(state?.running ?? false, state?.pid);
        },
      });
      options.onManager?.(manager);
      registerTools();
      updateExposure();
      for (const error of loaded.errors) ctx.ui.notify(`browser: ${error}`, "warning");
      if (resolution && !resolution.ok) {
        if (loaded.config.autoInstall === "ask") {
          ctx.ui.notify("browser: obscura is not installed yet. Run /browser install, or accept the download prompt when a browser tool is first used.", "info");
        } else {
          ctx.ui.notify(`browser: obscura not found (config.binaryPath / PI_BROWSER_OBSCURA_BIN / PATH / ${managedBinaryPath(agentDir, loaded.config.version)}). Install it manually or run /browser install.`, "warning");
        }
      }
      registerRaw();
      setStatus(false);
    };
    const getManager = async (ctx: ExtensionContext, _signal?: AbortSignal) => {
      await ensureConfig(ctx);
      return manager!;
    };
    const getEngine = async (ctx: ExtensionContext, signal?: AbortSignal) => (await getManager(ctx, signal)).require();
    const updateExposure = () => {
      const active = pi.getActiveTools().filter(name => !registeredNames.has(name));
      const direct = [...registeredNames].filter(name => toolExposure(name, loaded.config.exposure) === "direct");
      // Pi 0.99.2 registers tool_search but explicit active filtering must retain/enable it.
      if (direct.length < registeredNames.size && pi.getAllTools().some(t => t.name === "tool_search") && !active.includes("tool_search")) active.push("tool_search");
      pi.setActiveTools([...active, ...direct]);
    };
    const refreshConfig = async (ctx: ExtensionContext) => {
      const next = await loadBrowserConfig({ cwd: ctx.cwd, agentDir, projectTrusted: ctx.isProjectTrusted() });
      Object.assign(loaded.config, next.config);
      loaded = { ...next, config: loaded.config };
      resolveBinary(); registerTools(); updateExposure(); registerRaw();
      for (const error of loaded.errors) ctx.ui.notify(`browser: ${error}`, "warning");
    };
    const result = async (tool: string, start: number, content: McpContent[]) => {
      const bounded = await mcpContentToToolContent(content, { maxChars: loaded.config.maxOutputChars, label: tool });
      return { content: bounded.content, details: { tool, durationMs: Math.max(0, now() - start), ...(bounded.spilledPath ? { spilledPath: bounded.spilledPath } : {}) } };
    };
    const registerTools = () => {
      const common = { exposure: toolExposure("browser_navigate", loaded.config.exposure), executionMode: "sequential" as const, promptGuidelines: [REF_GUIDELINE, ...(deferredToolGuideline(loaded.config.exposure) && loaded.config.exposure !== "deferred" ? [deferredToolGuideline(loaded.config.exposure)] : [])] };
      const register = <T extends TSchema>(tool: ToolDefinition<T>) => { registeredNames.add(tool.name); pi.registerTool(tool); };
      for (const name of registerInteractionTools(pi, { config: () => loaded.config, getManager, now, guideline: REF_GUIDELINE })) registeredNames.add(name);
      registeredNames.add(registerFetchTool(pi, { getConfig: () => loaded.config, ensureBinary, env: options.env, launchFetch: options.launchFetch, killGraceMs: options.fetchKillGraceMs ?? 10_000, guideline: REF_GUIDELINE }));
      register({
        ...common, name: "browser_navigate", label: "Browser navigate", description: 'Open an HTTP(S) page and return its text and current interactive refs. engine: "chrome" for the app under development or fidelity-sensitive pages; "obscura" (default for public pages) for light reading.',
        promptSnippet: "Open a web page and inspect its current interactive refs.", annotations: { openWorldHint: true, readOnlyHint: false },
        parameters: Type.Object({ url: Type.String({ minLength: 1 }), engine: Type.Optional(Type.Union([Type.Literal("obscura"), Type.Literal("chrome")])), waitUntil: Type.Optional(Type.Union([Type.Literal("load"), Type.Literal("domcontentloaded"), Type.Literal("networkidle0")])) }),
        async execute(_id, params, signal, _update, ctx) {
          const start = now();
          let url: URL;
          try { url = new URL(params.url); } catch { throw new Error("browser_navigate requires a valid http: or https: URL."); }
          if (!["http:", "https:"].includes(url.protocol)) throw new Error("browser_navigate supports only http: and https: URLs; other schemes are not allowed.");
          const manager = await getManager(ctx, signal);
          const browser = await manager.select({ engine: params.engine, url: params.url });
          await browser.navigate(params.url, { waitUntil: params.waitUntil, signal });
          const applied = await applyPendingStorage(browser, manager.pendingFor(browser.name), { signal });
          const text = await summarizePage(browser, { maxChars: loaded.config.maxOutputChars, signal });
          return result("browser_navigate", start, [{ type: "text", text: applied ? `${text}\n${applied}` : text }]);
        },
      });
      register({
        ...common, name: "browser_snapshot", label: "Browser snapshot", description: "Read the current page text and optionally list fresh interactive refs.",
        promptSnippet: "Read the current page and refresh browser refs.", annotations: { openWorldHint: true, readOnlyHint: true },
        parameters: Type.Object({ maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 2147483647 })), interactive: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2147483647 })) }),
        async execute(_id, params, signal, _update, ctx) {
          const start = now();
          const text = await summarizePage(await getEngine(ctx, signal), { maxChars: params.maxChars ?? loaded.config.maxOutputChars, includeInteractive: params.interactive, limit: params.limit, signal });
          return result("browser_snapshot", start, [{ type: "text", text }]);
        },
      });
      register({
        ...common, name: "browser_evaluate", label: "Browser evaluate", description: "Evaluate one JavaScript expression in the page, returning explicit ok/value or an error. Can mutate the page; refresh refs afterward.",
        promptSnippet: "Evaluate a JavaScript expression in the current page.", annotations: { openWorldHint: true, readOnlyHint: false },
        parameters: Type.Object({ expression: Type.String({ minLength: 1 }) }),
        async execute(_id, params, signal, _update, ctx) {
          const start = now();
          const raw = await (await getEngine(ctx, signal)).evaluate(wrapExpression(params.expression), signal);
          return result("browser_evaluate", start, [{ type: "text", text: decodeEvaluation(raw) }]);
        },
      });
    };
    registerTools();
    pi.registerCommand("browser", {
      description: BROWSER_USAGE,
      getArgumentCompletions: completeBrowserArguments,
      async handler(args, ctx) {
        const command = args.trim();
        const installMatch = /^install(?:\s+(\d+\.\d+\.\d+(?:-[\w.-]+)?))?$/.exec(command);
        const networkMatch = /^allow-private-network\s+(on|off)$/.exec(command);
        const engineMatch = /^engine(?:\s+(obscura|chrome))?$/.exec(command);
        const profileMatch = /^profile\s+(save|load|clear)(?:\s+(\S+))?$/.exec(command);
        if (!["status", "stop", "restart"].includes(command) && !installMatch && !networkMatch && !profileMatch && !engineMatch) {
          ctx.ui.notify(BROWSER_USAGE, "warning"); return;
        }
        try {
          const manager = await getManager(ctx);
          const browser = manager.active() ?? obscura!;
          if (engineMatch) {
            if (engineMatch[1]) await manager.switchTo(engineMatch[1] as EngineName);
            const status = manager.status();
            ctx.ui.notify(`browser: active engine: ${status.active ?? "none"}; default engine: ${status.default}`, "info"); return;
          }
          if (command === "stop") { await manager.stopAll(); ctx.ui.notify("browser: stopped (tabs lost)", "info"); return; }
          if (installMatch) {
            const version = installMatch[1] ?? loaded.config.version;
            await manager.stopAll();
            const installed = await install(ctx, version);
            let savedPath: string | undefined;
            if (installMatch[1] && version !== loaded.config.version) {
              savedPath = await updateUserConfig({ version });
              loading = load(ctx).finally(() => { loading = undefined; });
              await loading;
            }
            const found = resolveBinary();
            registerRaw();
            ctx.ui.notify(`browser: installed obscura v${installed.version}\nPath: ${installed.path}\nSize: ${installed.bytes} bytes\nSHA-256: ${installed.sha256}${savedPath ? `\nversion ${version} saved to ${savedPath}` : ""}`, "info");
            if (savedPath) await warnProjectOverride(ctx, "version");
            if (found.ok && found.source !== "cache") ctx.ui.notify(`Installed to ${installed.path}, but binary resolution currently uses ${found.source}: ${found.path}. Remove binaryPath / PI_BROWSER_OBSCURA_BIN / the PATH entry to use the managed binary.`, "warning");
            else if (!found.ok) ctx.ui.notify(found.message, "warning");
            return;
          }
          if (networkMatch) {
            await updateUserConfig({ allowPrivateNetwork: networkMatch[1] === "on" });
            const wasRunning = browser.status().running;
            if (wasRunning) await browser.stop();
            await refreshConfig(ctx);
            if (wasRunning) { if (!manager.active()) await manager.select(); await manager.restartActive(); }
            ctx.ui.notify(`browser: allowPrivateNetwork ${networkMatch[1]} (user config)`, "info");
            await warnProjectOverride(ctx, "allowPrivateNetwork");
            return;
          }
          if (profileMatch) {
            const action = profileMatch[1];
            const name = profileMatch[2] ?? loaded.config.profile ?? "default";
            const path = profilePath(name);
            let restoreText: string | undefined;
            if (action === "clear") await rm(path, { force: true });
            else {
              const engine = manager.active() ?? await manager.select();
              if (action === "save") await writeProfile(name, await engine.storageState());
              else restoreText = (await restoreStorageState(engine, await readProfile(name), { signal: AbortSignal.timeout(10_000), cwd: ctx.cwd, pending: manager.pendingFor(engine.name) })).text;
            }
            ctx.ui.notify(`browser: profile ${name} ${action === "save" ? "saved" : action === "load" ? "loaded" : "cleared"} (${path})${restoreText ? `\n${restoreText}` : ""}`, "info");
            return;
          }
          if (command === "restart") {
            // Save with the old profile/settings before applying the new config.
            await manager.active()?.stop();
            await refreshConfig(ctx);
            if (!manager.active()) await manager.select();
            await manager.restartActive();
            ctx.ui.notify("browser: restarted (tabs lost)", "info");
            return;
          }
          const state = obscura!.session.status();
          const engines = manager.status();
          resolveBinary();
          const binary = resolution?.ok ? `${resolution.path} (${resolution.source})` : resolution?.message ?? "unresolved";
          const engineStatus = Object.entries(engines.engines).map(([name, e]) =>
            `[${name}] ${e.running ? "running" : "idle"} | Available: ${e.available ? "yes" : `no (${e.reason})`} | PID: ${e.pid ?? "none"} | Binary: ${name === "obscura" ? binary : e.binary ?? chromeAvailability(loaded.config, options.env ?? process.env).executablePath ?? e.detail}${name === "chrome" ? ` | ${e.detail} | flags: ${buildChromeArgs(loaded.config, options.env ?? process.env).join(" ")}` : ""}`).join("\n");
          ctx.ui.notify(`browser: ${Object.values(engines.engines).some(e => e.running) ? "running" : "idle"}\nActive engine: ${engines.active ?? "none"} | Default engine: ${engines.default} (config: ${engines.configDefault})\n${engineStatus}\nChrome config: ${JSON.stringify(loaded.config.chrome)}\nPID: ${state.pid ?? "none"}\nBinary: ${binary}\nConfig sources: ${loaded.sources.join(", ") || "defaults"}\nConfig errors: ${loaded.errors.join("; ") || "none"}\nCalls: ${state.calls}\nautoInstall: ${loaded.config.autoInstall}\nprofile: ${loaded.config.profile ?? "none"}\nrawMcp: ${loaded.config.rawMcp}\nartifactsDir: ${loaded.config.artifactsDir ?? defaultSpillDir()}\nManaged cache: ${managedCacheDir(agentDir)}`, "info");
        } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
      },
    });
    pi.on("session_start", async (_event, ctx) => {
      loading = load(ctx).finally(() => { loading = undefined; });
      await loading;
    });
    pi.on("session_shutdown", async () => {
      installController?.abort(new Error("Browser session shutdown"));
      await installing?.catch(() => {});
      await ensuring?.catch(() => {});
      await loading;
      await manager?.stopAll();
    });
  };
}

export default function (pi: ExtensionAPI): void { createBrowserExtension()(pi); }
