import type { ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type, type TSchema } from "@sinclair/typebox";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { managedBinaryPath, managedCacheDir, resolveObscuraBinary, type BinaryResolution } from "../binary.js";
import { DEFAULT_BROWSER_CONFIG, isValidProfileName, loadBrowserConfig, validateBrowserConfig, type BrowserConfig, type LoadedBrowserConfig } from "../config.js";
import { storageState } from "../actions.js";
import { installObscura, type InstallObscuraResult } from "../install.js";
import { buildObscuraArgs } from "../mcp-client.js";
import { registerFetchTool } from "../fetch.js";
import { defaultSpillDir, mcpContentToToolContent, type McpContent } from "../output.js";
import { checkedText, summarizePage } from "../page.js";
import { BrowserSession } from "../session.js";
import { registerInteractionTools } from "./tools.js";
import { decodeEvaluation, wrapExpression } from "../evaluate.js";
import { applyPendingStorage, restoreStorageState, validateRestorableState, type PendingStorage } from "../state.js";
export { decodeEvaluation, wrapExpression } from "../evaluate.js";

export interface BrowserExtensionOptions {
  agentDir?: string;
  launch?: () => ChildProcess;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  pathDirs?: string[];
  install?: typeof installObscura;
  launchFetch?: (args: string[]) => ChildProcess;
  fetchKillGraceMs?: number;
}

export const BROWSER_USAGE = "Usage: /browser status | stop | restart | install [version] | allow-private-network on|off | profile save|load|clear [name]";
const REF_GUIDELINE = "Browser refs (e1, e2, …) are invalidated by every action and navigation; use the refs from the latest result.";


export function createBrowserExtension(options: BrowserExtensionOptions = {}) {
  return function browserExtension(pi: ExtensionAPI): void {
    const agentDir = options.agentDir ?? getAgentDir();
    const now = options.now ?? Date.now;
    let loaded: LoadedBrowserConfig = { config: { ...DEFAULT_BROWSER_CONFIG }, sources: [], errors: [] };
    let resolution: BinaryResolution | undefined;
    let session: BrowserSession | undefined;
    let context: ExtensionContext | undefined;
    let loading: Promise<void> | undefined;
    let installing: Promise<InstallObscuraResult> | undefined;
    let ensuring: Promise<string> | undefined;
    let installController: AbortController | undefined;
    let rawRegistration: string | undefined;
    const profileWarnings = new Set<string>();
    const pendingStorage: PendingStorage = new Map();
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
    const missingHint = (message: string) => `${message} Run /browser install to download a verified release.`;
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
        setStatus(session?.status().running ?? false, session?.status().pid);
      });
      return installing;
    };
    const ensureConfig = async (ctx: ExtensionContext) => {
      if (loading) await loading;
      if (!session) { loading = load(ctx).finally(() => { loading = undefined; }); await loading; }
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
            if (loaded.config.autoInstall === "never" || !ctx.hasUI) throw new Error(missingHint(found.message));
            const approved = await ctx.ui.confirm("Download obscura?", `pi-browser needs the obscura browser (v${loaded.config.version}, ~70 MB, Apache-2.0) from GitHub releases. Download to ${managedBinaryPath(agentDir, loaded.config.version)}?`);
            if (!approved) throw new Error("Obscura download declined. Run /browser install, set binaryPath or PI_BROWSER_OBSCURA_BIN, or put obscura on PATH.");
            signal?.throwIfAborted();
            await install(ctx, loaded.config.version, signal);
          }
          const installed = resolveBinary();
          if (!installed.ok) throw new Error(missingHint(installed.message));
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
      await session?.stop();
      pendingStorage.clear();
      loaded = await loadBrowserConfig({ cwd: ctx.cwd, agentDir, projectTrusted: ctx.isProjectTrusted() });
      resolveBinary();
      const profile = loaded.config.profile;
      session = new BrowserSession({
        config: loaded.config, resolveBinary: () => resolution!, launch: options.launch, env: options.env, now,
        onStateChange: ({ running, pid }) => { if (!running) pendingStorage.clear(); setStatus(running, pid); },
        ...(profile ? {
          onAfterStart: async (call) => {
            let state;
            try { state = await readProfile(profile); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
            await restoreStorageState({ call }, state, { cwd: ctx.cwd, pending: pendingStorage });
          },
          onBeforeStop: async (call) => {
            await writeProfile(profile, JSON.parse(checkedText(await call("browser_storage_state", {}))));
          },
          onHookError: (error: unknown, phase: "restore" | "save") => {
            const key = `${profile}/${phase}`;
            if (!profileWarnings.has(key)) {
              profileWarnings.add(key);
              context?.ui.notify(`browser: profile ${profile} ${phase} failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
            }
          },
        } : {}),
      });
      registerTools();
      if (loaded.config.exposure === "deferred") {
        pi.setActiveTools(pi.getActiveTools().filter((name) => !registeredNames.has(name)));
      }
      for (const error of loaded.errors) ctx.ui.notify(`browser: ${error}`, "warning");
      if (resolution && !resolution.ok) ctx.ui.notify(missingHint(resolution.message), "warning");
      registerRaw();
      setStatus(false);
    };
    const getSession = async (ctx: ExtensionContext, needsBinary = true, signal?: AbortSignal) => {
      await ensureConfig(ctx);
      if (needsBinary) await ensureBinary(ctx, signal);
      return session!;
    };
    const result = async (tool: string, start: number, content: McpContent[]) => {
      const bounded = await mcpContentToToolContent(content, { maxChars: loaded.config.maxOutputChars, label: tool });
      return { content: bounded.content, details: { tool, durationMs: Math.max(0, now() - start), ...(bounded.spilledPath ? { spilledPath: bounded.spilledPath } : {}) } };
    };
    const registerTools = () => {
      const common = { exposure: loaded.config.exposure, executionMode: "sequential" as const, promptGuidelines: [REF_GUIDELINE] };
      const register = <T extends TSchema>(tool: ToolDefinition<T>) => { registeredNames.add(tool.name); pi.registerTool(tool); };
      for (const name of registerInteractionTools(pi, { config: () => loaded.config, getSession: (ctx, signal) => getSession(ctx, true, signal), now, guideline: REF_GUIDELINE, pendingStorage })) registeredNames.add(name);
      registeredNames.add(registerFetchTool(pi, { getConfig: () => loaded.config, ensureBinary, env: options.env, launchFetch: options.launchFetch, killGraceMs: options.fetchKillGraceMs ?? 10_000, guideline: REF_GUIDELINE }));
      register({
        ...common, name: "browser_navigate", label: "Browser navigate", description: "Open an HTTP(S) page and return its text and current interactive refs.",
        promptSnippet: "Open a web page and inspect its current interactive refs.", annotations: { openWorldHint: true, readOnlyHint: false },
        parameters: Type.Object({ url: Type.String({ minLength: 1 }), waitUntil: Type.Optional(Type.Union([Type.Literal("load"), Type.Literal("domcontentloaded"), Type.Literal("networkidle0")])) }),
        async execute(_id, params, signal, _update, ctx) {
          const start = now();
          let url: URL;
          try { url = new URL(params.url); } catch { throw new Error("browser_navigate requires a valid http: or https: URL."); }
          if (!["http:", "https:"].includes(url.protocol)) throw new Error("browser_navigate supports only http: and https: URLs; other schemes are not allowed.");
          const browser = await getSession(ctx, true, signal);
          checkedText(await browser.call("browser_navigate", { url: params.url, ...(params.waitUntil ? { waitUntil: params.waitUntil } : {}) }, { signal }), ctx.cwd);
          const applied = await applyPendingStorage(browser, pendingStorage, { signal });
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
          const text = await summarizePage(await getSession(ctx, true, signal), { maxChars: params.maxChars ?? loaded.config.maxOutputChars, includeInteractive: params.interactive, limit: params.limit, signal });
          return result("browser_snapshot", start, [{ type: "text", text }]);
        },
      });
      register({
        ...common, name: "browser_evaluate", label: "Browser evaluate", description: "Evaluate one JavaScript expression in the page, returning explicit ok/value or an error. Can mutate the page; refresh refs afterward.",
        promptSnippet: "Evaluate a JavaScript expression in the current page.", annotations: { openWorldHint: true, readOnlyHint: false },
        parameters: Type.Object({ expression: Type.String({ minLength: 1 }) }),
        async execute(_id, params, signal, _update, ctx) {
          const start = now();
          const raw = checkedText(await (await getSession(ctx, true, signal)).call("browser_evaluate", { expression: wrapExpression(params.expression) }, { signal, deadlineMs: loaded.config.evaluateTimeoutMs }));
          return result("browser_evaluate", start, [{ type: "text", text: decodeEvaluation(raw) }]);
        },
      });
    };
    registerTools();
    pi.registerCommand("browser", {
      description: BROWSER_USAGE,
      async handler(args, ctx) {
        const command = args.trim();
        const installMatch = /^install(?:\s+(\d+\.\d+\.\d+(?:-[\w.-]+)?))?$/.exec(command);
        const networkMatch = /^allow-private-network\s+(on|off)$/.exec(command);
        const profileMatch = /^profile\s+(save|load|clear)(?:\s+(\S+))?$/.exec(command);
        if (!["status", "stop", "restart"].includes(command) && !installMatch && !networkMatch && !profileMatch) {
          ctx.ui.notify(BROWSER_USAGE, "warning"); return;
        }
        try {
          const browser = await getSession(ctx, false);
          if (command === "stop") { await browser.stop(); pendingStorage.clear(); ctx.ui.notify("browser: stopped (tabs lost)", "info"); return; }
          if (installMatch) {
            const version = installMatch[1] ?? loaded.config.version;
            await browser.stop();
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
            else if (!found.ok) ctx.ui.notify(missingHint(found.message), "warning");
            return;
          }
          if (networkMatch) {
            await updateUserConfig({ allowPrivateNetwork: networkMatch[1] === "on" });
            const wasRunning = browser.status().running;
            loading = load(ctx).finally(() => { loading = undefined; });
            await loading;
            if (wasRunning) { await ensureBinary(ctx); await session!.ensureStarted(); }
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
              await ensureBinary(ctx);
              if (action === "save") await writeProfile(name, JSON.parse(checkedText(await browser.call("browser_storage_state", {}))));
              else restoreText = (await restoreStorageState(browser, await readProfile(name), { signal: AbortSignal.timeout(10_000), cwd: ctx.cwd, pending: pendingStorage })).text;
            }
            ctx.ui.notify(`browser: profile ${name} ${action === "save" ? "saved" : action === "load" ? "loaded" : "cleared"} (${path})${restoreText ? `\n${restoreText}` : ""}`, "info");
            return;
          }
          if (command === "restart") {
            // Track config reload too, so shutdown cannot miss a newly created session.
            loading = load(ctx).finally(() => { loading = undefined; });
            await loading;
            await ensureBinary(ctx);
            await session!.ensureStarted();
            ctx.ui.notify("browser: restarted (tabs lost)", "info");
            return;
          }
          const state = browser.status();
          resolveBinary();
          const binary = resolution?.ok ? `${resolution.path} (${resolution.source})` : resolution?.message ?? "unresolved";
          ctx.ui.notify(`browser: ${state.running ? "running" : "idle"}\nPID: ${state.pid ?? "none"}\nBinary: ${binary}\nConfig sources: ${loaded.sources.join(", ") || "defaults"}\nConfig errors: ${loaded.errors.join("; ") || "none"}\nCalls: ${state.calls}\nautoInstall: ${loaded.config.autoInstall}\nprofile: ${loaded.config.profile ?? "none"}\nrawMcp: ${loaded.config.rawMcp}\nartifactsDir: ${loaded.config.artifactsDir ?? defaultSpillDir()}\nManaged cache: ${managedCacheDir(agentDir)}`, "info");
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
      await session?.stop();
    });
  };
}

export default function (pi: ExtensionAPI): void { createBrowserExtension()(pi); }
