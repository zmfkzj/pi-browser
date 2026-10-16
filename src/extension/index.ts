import type { ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type, type TSchema } from "@sinclair/typebox";
import { getAgentDir, parseArgs, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { managedBinaryPath, managedCacheDir, resolveObscuraBinary, type BinaryResolution } from "../binary.js";
import { DEFAULT_BROWSER_CONFIG, isValidProfileName, loadBrowserConfig, validateBrowserConfig, type BrowserConfig, type Exposure, type LoadedBrowserConfig } from "../config.js";
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
import { answerWebFetch, isWorkerCapabilityRequest, WEB_FETCH_CAPABILITY, WORKER_CAPABILITY_CHANNEL } from "../worker.js";
import { formatDependencyReport, registerDependencyProvider, type DependencyProvider, type DependencyReport } from "../dependencies.js";
import { createBrowserDependencyProvider, type BrowserDependencyProbes } from "../doctor.js";
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
  /** Test/embedding seam for `/browser doctor` and `/browser install-deps` (glibc, probes, npm, Chrome detection). */
  dependencies?: BrowserDependencyProbes;
}

export const BROWSER_USAGE = "Usage: /browser status | doctor | install-deps | engine [obscura|chrome] | stop | restart | install [version] | allow-private-network on|off | profile save|load|clear [name] (stop: all engines; restart: active engine)";
const REF_GUIDELINE = "Browser refs are engine-specific and are invalidated by every action and navigation; use the refs from the latest result.";
/** Session entry recording the exposure mode the active browser tools follow, so a change applies to a resumed or reloaded session. */
const EXPOSURE_ENTRY = "browser-exposure";


export function createBrowserExtension(options: BrowserExtensionOptions = {}) {
  return function browserExtension(pi: ExtensionAPI): void {
    const agentDir = options.agentDir ?? getAgentDir();
    const now = options.now ?? Date.now;
    // Until session_start reads the config, tools register deferred: Pi then activates none of them on its own (a fresh
    // session, or the extension tools Pi re-activates on /reload), and the session's config activates its direct ones.
    let loaded: LoadedBrowserConfig = { config: { ...DEFAULT_BROWSER_CONFIG, exposure: "deferred" }, sources: [], errors: [] };
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
    const install = (ctx: ExtensionContext, version: string, signal?: AbortSignal, variant: BrowserConfig["variant"] = loaded.config.variant): Promise<InstallObscuraResult> => {
      if (installing) return installing;
      installController = new AbortController();
      const abort = () => installController?.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      installing = Promise.resolve().then(() => (options.install ?? installObscura)({
        version, variant, platform: process.platform, arch: process.arch, agentDir,
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
      seedExposure(ctx);
      updateExposure(false);
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
    // Exposure each browser tool had when the active set last followed the config, and the session's recorded mode. A
    // tool leaves the active set only when the config stops declaring it directly: Pi restores a resumed session's tools
    // and keeps them across /reload, including deferred ones a tool_search loaded, and it must not lose them here.
    const applied = new Map<string, "direct" | "deferred">();
    let recordedExposure: Exposure = DEFAULT_BROWSER_CONFIG.exposure;
    /** Tools to deactivate that the config no longer declares directly, waiting for the next run (see updateExposure). */
    const demote = new Set<string>();
    const seedExposure = (ctx: ExtensionContext) => {
      recordedExposure = DEFAULT_BROWSER_CONFIG.exposure;
      for (const entry of ctx.sessionManager.getBranch()) {
        const exposure = entry.type === "custom" && entry.customType === EXPOSURE_ENTRY ? (entry.data as { exposure?: unknown } | undefined)?.exposure : undefined;
        if (exposure === "hybrid" || exposure === "direct" || exposure === "deferred") recordedExposure = exposure;
      }
      applied.clear();
      demote.clear();
      for (const name of registeredNames) applied.set(name, toolExposure(name, recordedExposure));
    };
    // setActiveTools is an explicit activation API, not a default selector. Preserve negative default modifiers when
    // auto-enabling browser defaults/search. CLI options are not exposed by ExtensionContext; use Pi's public parser,
    // not a second flag grammar. Hard exclusions/allowlists (--no-tools included) remain enforced by Pi's registry.
    const defaultDisabled = () => {
      const cli = parseArgs(process.argv.slice(2));
      const entries = [...(pi.getSettings?.().defaultTools ?? []), ...(cli.tools ?? [])];
      const disabled = new Set<string>();
      for (const entry of entries) {
        if (entry.startsWith("-")) disabled.add(entry.slice(1));
        else disabled.delete(entry.startsWith("+") ? entry.slice(1) : entry);
      }
      return disabled;
    };
    /**
     * Activate config defaults without replacing restored/search-enabled tools. Deactivation waits until the first run:
     * setActiveTools would otherwise clear Pi's pending restoration of other extensions' late (for example MCP) tools.
     */
    const updateExposure = (deactivate = true) => {
      const mode = loaded.config.exposure;
      const disabled = defaultDisabled();
      for (const name of registeredNames) {
        const exposure = toolExposure(name, mode);
        if (applied.get(name) === "direct" && exposure !== "direct") demote.add(name);
        if (exposure === "direct") demote.delete(name);
        if (disabled.has(name)) demote.add(name);
        applied.set(name, exposure);
      }
      const active = pi.getActiveTools();
      const next = active.filter(name => !(deactivate && demote.has(name)));
      for (const name of registeredNames) if (toolExposure(name, mode) === "direct" && !disabled.has(name) && !next.includes(name)) next.push(name);
      // Pi 0.99.2 registers tool_search inactive. Browser's deferred surface needs it unless the user opts out.
      if (!disabled.has("tool_search") && [...registeredNames].some(name => toolExposure(name, mode) !== "direct") && pi.getAllTools().some(t => t.name === "tool_search") && !next.includes("tool_search")) next.push("tool_search");
      if (next.length !== active.length || next.some(name => !active.includes(name))) pi.setActiveTools(next);
      if (deactivate) demote.clear();
      if (mode !== recordedExposure) { pi.appendEntry(EXPOSURE_ENTRY, { exposure: mode }); recordedExposure = mode; }
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
    // `/browser doctor`, `/browser install-deps` and the umbrella's `/oh-my-pi doctor|install-deps` (src/doctor.ts).
    // check() reads the config files on disk; install() downloads obscura only through the verified `install` path above.
    const dependencyCore = createBrowserDependencyProvider<ExtensionContext>({
      agentDir, env: options.env, pathDirs: options.pathDirs, ...options.dependencies,
      installObscura: async (ctx, config) => {
        const installed = await install(ctx, config.version, undefined, config.variant);
        resolveBinary(); registerRaw();
        return installed;
      },
    });
    let installingDependencies: Promise<DependencyReport> | undefined;
    const dependencyProvider: DependencyProvider<ExtensionContext> = {
      ...dependencyCore,
      install: ctx => installingDependencies ??= (async () => {
        if (ctx.hasUI) ctx.ui.setStatus("browser", "browser: installing dependencies…");
        try { return await dependencyCore.install(ctx); }
        finally {
          const state = manager?.active()?.status();
          if (ctx.hasUI) ctx.ui.setStatus("browser", state?.running ? `browser: running (pid ${state.pid})` : "browser: idle");
        }
      })().finally(() => { installingDependencies = undefined; }),
    };
    registerDependencyProvider(pi.events, dependencyProvider);
    pi.registerCommand("browser", {
      description: BROWSER_USAGE,
      getArgumentCompletions: completeBrowserArguments,
      async handler(args, ctx) {
        const command = args.trim();
        // Exact words only: `install` and `install <version>` keep their grammar (`install-deps` never matched it).
        if (command === "doctor" || command === "install-deps") {
          const mode = command === "doctor" ? "check" : "install";
          try {
            const report = mode === "check" ? await dependencyProvider.check(ctx) : await dependencyProvider.install(ctx);
            const { text, level } = formatDependencyReport(dependencyProvider.label, report, mode);
            ctx.ui.notify(text, level);
          } catch (error) { ctx.ui.notify(`browser: ${command} failed: ${error instanceof Error ? error.message : String(error)}`, "error"); }
          return;
        }
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
    // orche workers: their own stateless browser_fetch (src/worker.ts). Nothing of this session's engines, tabs, profile
    // or download consent is shared; session browsing for workers goes through pi-gui's private desktop instead.
    pi.events.on(WORKER_CAPABILITY_CHANNEL, data => {
      if (!isWorkerCapabilityRequest(data) || data.capability !== WEB_FETCH_CAPABILITY) return;
      answerWebFetch(data, { config: loaded.config, agentDir, env: options.env, pathDirs: options.pathDirs, launchFetch: options.launchFetch, killGraceMs: options.fetchKillGraceMs });
    });
    pi.on("session_start", async (_event, ctx) => {
      loading = load(ctx).finally(() => { loading = undefined; });
      await loading;
    });
    // A config change found when the session started takes effect with its first run (see updateExposure).
    pi.on("before_agent_start", () => { if (demote.size > 0) updateExposure(); });
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
