// orche worker capability `web-fetch`: the main session's extension answers with a worker-own browser_fetch (never its
// engines, tabs, profile or install consent), and the factory gives a worker session a working direct browser_fetch.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage as reply } from "@earendil-works/pi-ai";
import { DEFAULT_BROWSER_CONFIG } from "../src/config.js";
import {
  answerWebFetch, WEB_FETCH_CAPABILITY, WORKER_CAPABILITY_CHANNEL, WORKER_FETCH_INSTRUCTIONS, workerFetchExtension,
  type WorkerCapabilityAnswer,
} from "../src/worker.js";
import { createHarness, tool, type Harness } from "./helpers/harness.js";
import { fauxRuntime } from "./helpers/faux.js";

const cli = fileURLToPath(new URL("./helpers/fake-obscura-cli.mjs", import.meta.url));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type Answer = WorkerCapabilityAnswer | { error: string } | undefined;
function ask(h: Harness, capability: string): Answer {
  let answer: Answer;
  h.events.emit(WORKER_CAPABILITY_CHANNEL, { capability, cwd: h.cwd, workerId: "W1", role: "answer", readOnly: true, provide: (value: Answer) => { answer ??= value; } });
  return answer;
}
async function mainHarness(options: Parameters<typeof createHarness>[0] = {}) {
  const h = await createHarness(options);
  cleanups.push(() => h.dispose());
  return h;
}

/** A worker-like session: only the capability's factory, no UI, no tool_search, an explicit tool allowlist. */
async function workerSession(options: { config?: Record<string, unknown>; env?: NodeJS.ProcessEnv; pathDirs?: string[]; steps: Parameters<typeof fauxRuntime>[0] }) {
  const root = await mkdtemp(join(tmpdir(), "browser-worker-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "browser.config.json"), JSON.stringify({ binaryPath: process.execPath, ...options.config }));
  const children: ChildProcess[] = [];
  const launches: string[][] = [];
  const launchFetch = (args: string[]) => { launches.push(args); const child = spawn(process.execPath, [cli, ...args], { stdio: "pipe" }); children.push(child); return child; };
  const { runtime, faux } = await fauxRuntime(options.steps);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [workerFetchExtension({ agentDir, env: options.env ?? {}, pathDirs: options.pathDirs ?? [], launchFetch })],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd, agentDir, modelRuntime: runtime, model: runtime.getModel(faux.provider.id, faux.getModel().id)!, thinkingLevel: "off",
    resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(cwd), tools: ["read", "browser_fetch"],
  });
  await session.bindExtensions({});
  cleanups.push(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  });
  const results = () => session.messages.filter(message => message.role === "toolResult");
  return { session, children, launches, results };
}
const textOf = (message: { content: { type: string; text?: string }[] }) => message.content.filter(item => item.type === "text").map(item => item.text).join("\n");

describe("web-fetch worker capability", () => {
  it("answers with a worker-own browser_fetch only, and ignores other capabilities", async () => {
    const h = await mainHarness();
    const answer = ask(h, WEB_FETCH_CAPABILITY);
    expect(answer && !("error" in answer)).toBe(true);
    const provided = answer as WorkerCapabilityAnswer;
    expect(provided.tools).toEqual(["browser_fetch"]);
    expect(provided.extensionFactories).toHaveLength(1);
    expect(JSON.parse(provided.key)).toEqual({ tool: "browser_fetch", binary: process.execPath });
    expect(provided.instructions).toBe(WORKER_FETCH_INSTRUCTIONS);
    expect(provided.instructions).toMatch(/no other browser_\* tool and no tool_search/);
    expect(provided.instructions).toMatch(/gui: true/);
    expect(provided.toolTimeoutsMs).toEqual({ browser_fetch: 135_000 });
    expect(ask(h, "gui")).toBeUndefined();
    // Answering starts nothing of the main session's browser.
    expect(h.children).toHaveLength(0);
    expect(h.manager.status().active).toBeUndefined();
  });

  it("refuses when obscura is missing instead of offering a tool that would need the user's download consent", async () => {
    const h = await mainHarness({ config: { binaryPath: "/nonexistent/obscura", autoInstall: "ask" }, extension: { env: {}, pathDirs: [] } });
    const answer = ask(h, WEB_FETCH_CAPABILITY);
    expect(answer).toEqual({ error: expect.stringMatching(/^browser_fetch unavailable: obscura is not installed, and a worker cannot approve its download\. Run \/browser install in the main session/) });
    expect(h.confirmations).toEqual([]);
  });

  it("gives the worker session a direct, public-only browser_fetch that runs, whatever the configured exposure", async () => {
    const w = await workerSession({ config: { exposure: "deferred", allowPrivateNetwork: true }, steps: [tool("browser_fetch", { url: "https://example.com/docs", format: "text" }), reply("done")] });
    expect(w.session.getActiveToolNames().sort()).toEqual(["browser_fetch", "read"]);
    expect(w.session.getAllTools().map(item => item.name)).not.toContain("tool_search");
    await w.session.prompt("Read the docs page");
    const result = w.results().at(-1)!;
    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain("text https://example.com/docs");
    // The user's allowPrivateNetwork opt-in belongs to the main session.
    expect(w.launches).toEqual([["fetch", "https://example.com/docs", "--dump", "text", "--timeout", "30"]]);
  });

  it("kills the fetch child when the worker's run is aborted, and is unaffected by the main session stopping its browser", async () => {
    const h = await mainHarness();
    const w = await workerSession({ steps: [tool("browser_fetch", { url: "https://hang.example" }), reply("done")] });
    const running = w.session.prompt("Read a slow page");
    await expect.poll(() => w.children.length).toBe(1);
    await h.manager.stopAll();
    expect(w.children[0]!.exitCode === null && w.children[0]!.signalCode === null).toBe(true);
    await w.session.abort();
    await running.catch(() => undefined);
    await expect.poll(() => w.children[0]!.signalCode).toBe("SIGKILL");
  });

  it("fails the worker's call clearly, without prompting, when obscura disappears", async () => {
    const w = await workerSession({ config: { binaryPath: "/nonexistent/obscura" }, steps: [tool("browser_fetch", { url: "https://example.com" }), reply("done")] });
    await w.session.prompt("Read a page");
    const result = w.results().at(-1)!;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/browser_fetch unavailable: obscura is not installed/);
    expect(w.children).toHaveLength(0);
  });

  it("answers directly from the current config", () => {
    let answer: Answer;
    answerWebFetch({ capability: WEB_FETCH_CAPABILITY, cwd: "/", provide: value => { answer = value; } },
      { config: { ...DEFAULT_BROWSER_CONFIG, binaryPath: process.execPath }, agentDir: "/nonexistent-agent", env: {}, pathDirs: [] });
    expect((answer as WorkerCapabilityAnswer).tools).toEqual(["browser_fetch"]);
  });
});
