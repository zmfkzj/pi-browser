import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession, createToolSearchExtension, DefaultResourceLoader, SessionManager, SettingsManager,
  type ExtensionAPI, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage as reply, fauxToolCall as call, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { createBrowserExtension, type BrowserExtensionOptions } from "../../src/extension/index.js";
import { fauxRuntime } from "./faux.js";
import type { EngineManager } from "../../src/manager.js";

export const tool = (name: string, args: ToolCall["arguments"]) => reply([call(name, args)], { stopReason: "toolUse" });
const fakeServer = fileURLToPath(new URL("./fake-mcp-server.mjs", import.meta.url));
export const fakeChromeServer = fileURLToPath(new URL("./fake-chrome-mcp.mjs", import.meta.url));

/** Real AgentSession, independent faux runtime, and a test-owned stdio MCP child. */
export async function createHarness(options: {
  steps?: FauxResponseStep[];
  config?: Record<string, unknown>;
  extension?: BrowserExtensionOptions;
  /** Enable the fake Chrome engine, or supply an explicit real/fake child launcher. */
  chrome?: boolean;
  launchChrome?: () => ChildProcess;
  confirm?: boolean | ((title: string, message: string) => boolean | Promise<boolean>);
  hasUI?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "browser-extension-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "browser.config.json"), JSON.stringify({ binaryPath: process.execPath, ...options.config }));
  const main = await fauxRuntime(options.steps);
  const children: ChildProcess[] = [];
  let extensionApi: ExtensionAPI;
  let manager: EngineManager;
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [createToolSearchExtension(), (pi) => {
      extensionApi = pi;
      createBrowserExtension({
        engineAvailability: { chrome: () => ({ ok: false, reason: "chrome engine disabled in config" }) },
        ...(options.chrome || options.launchChrome ? {
          engineAvailability: { chrome: () => ({ ok: true }) },
          launchChrome: () => {
            const child = options.launchChrome?.() ?? spawn(process.execPath, [fakeChromeServer], { stdio: "pipe", detached: true });
            children.push(child); return child;
          },
        } : {}),
        agentDir, launch: () => {
          const child = spawn(process.execPath, [fakeServer], { stdio: "pipe" });
          children.push(child);
          return child;
        }, ...options.extension,
        onManager: (value) => { manager = value; options.extension?.onManager?.(value); },
      })(pi);
    }],
  });
  await resourceLoader.reload();
  const model = main.runtime.getModel(main.faux.provider.id, main.faux.getModel().id)!;
  const { session } = await createAgentSession({
    cwd, agentDir, modelRuntime: main.runtime, model, thinkingLevel: "off", resourceLoader,
    settingsManager, sessionManager: SessionManager.inMemory(cwd),
  });
  const notifications: { message: string; type?: string }[] = [];
  const statuses: { key: string; text?: string }[] = [];
  const errors: string[] = [];
  const confirmations: { title: string; message: string }[] = [];
  const uiContext = {
    notify: (message: string, type?: string) => { notifications.push({ message, type }); },
    setStatus: (key: string, text?: string) => { statuses.push({ key, text }); },
    confirm: async (title: string, message: string) => {
      confirmations.push({ title, message });
      return typeof options.confirm === "function" ? options.confirm(title, message) : options.confirm ?? false;
    },
  } as unknown as ExtensionUIContext;
  session.extensionRunner.onError((error) => { errors.push(error.error); });
  await session.bindExtensions(options.hasUI === false ? {} : { uiContext });
  return {
    session, main, children, cwd, agentDir, notifications, statuses, errors, confirmations,
    get manager() { return manager!; },
    getMcpServers: () => extensionApi!.getMcpServers(),
    async shutdown() { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); },
    async dispose() {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      // Test-failure safety net; extension lifecycle assertions run before this cleanup.
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    },
  };
}
export type Harness = Awaited<ReturnType<typeof createHarness>>;
