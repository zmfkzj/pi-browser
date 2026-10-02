import { spawn, type ChildProcess } from "node:child_process";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describeError, httpUrl } from "./actions.js";
import type { BrowserConfig } from "./config.js";
import { buildChildEnv, obscuraGlobalArgs } from "./mcp-client.js";
import { mcpContentToToolContent } from "./output.js";

export interface FetchToolDeps {
  getConfig: () => BrowserConfig;
  ensureBinary: (ctx: ExtensionContext, signal?: AbortSignal) => Promise<string>;
  env?: NodeJS.ProcessEnv;
  launchFetch?: (args: string[]) => ChildProcess;
  /** Extra time for obscura's own timeout before parent-driven termination. */
  killGraceMs?: number;
  guideline?: string;
}

export interface FetchParams {
  format?: "text" | "markdown" | "html" | "links";
  maxChars?: number;
  timeoutMs?: number;
  waitUntil?: "load" | "domcontentloaded" | "networkidle0";
  selector?: string;
}

/** Build argv without a shell; validate even when called outside the tool schema. */
export function buildFetchArgs(url: string, params: FetchParams, config: BrowserConfig): string[] {
  httpUrl(url, "browser_fetch");
  const timeoutMs = params.timeoutMs ?? 30000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error("timeoutMs must be an integer from 1000 to 120000.");
  const format = params.format ?? "markdown";
  if (!["text", "markdown", "html", "links"].includes(format)) throw new Error("Unsupported fetch format.");
  if (params.maxChars !== undefined && (!Number.isSafeInteger(params.maxChars) || params.maxChars < 1)) throw new Error("maxChars must be a positive integer.");
  if (params.waitUntil !== undefined && !["load", "domcontentloaded", "networkidle0"].includes(params.waitUntil)) throw new Error("Unsupported waitUntil value.");
  if (params.selector !== undefined && !params.selector.trim()) throw new Error("selector must be a non-empty string.");
  const args = ["fetch", url, "--dump", format, "--timeout", String(Math.ceil(timeoutMs / 1000))];
  if (params.waitUntil !== undefined) args.push("--wait-until", params.waitUntil);
  if (params.selector !== undefined) args.push("--selector", params.selector);
  args.push(...obscuraGlobalArgs(config));
  if (config.userAgent) args.push("--user-agent", config.userAgent);
  return args;
}

const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

export function collectFetch(child: ChildProcess, timeoutMs: number, signal?: AbortSignal, cwd?: string,
  options: { killGraceMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = Buffer.alloc(0);
    let forcedError: Error | undefined;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, output?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(hardKillTimer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(output ?? "");
    };
    const kill = (error: Error) => {
      if (finished) return;
      forcedError ??= error;
      // Cancellation and oversized output need no grace: there is no state to preserve.
      child.kill("SIGKILL");
    };
    const abort = () => kill(new Error("Browser fetch was aborted."));
    const killAfterMs = timeoutMs + (options.killGraceMs ?? 10000);
    timer = setTimeout(() => {
      if (finished) return;
      forcedError ??= new Error(`obscura fetch did not exit after ${killAfterMs} ms and was killed.`);
      // Schedule escalation before SIGTERM in case kill synchronously emits close/error.
      hardKillTimer = setTimeout(() => {
        if (!finished) child.kill("SIGKILL");
      }, 2000);
      child.kill("SIGTERM");
    }, killAfterMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (finished || forcedError) return;
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_STDOUT_BYTES) {
        kill(new Error("Browser fetch output exceeded 8 MiB; the child was terminated (output truncated). Use a selector to narrow the page."));
      } else chunks.push(buffer);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const buffer = Buffer.from(chunk);
      stderr = buffer.length >= 4096 ? buffer.subarray(-4096) : Buffer.concat([stderr, buffer]).subarray(-4096);
    });
    child.once("error", (error) => {
      if (finished) return;
      forcedError ??= new Error(`Cannot launch obscura fetch: ${error.message}`);
      // An error need not be followed by close (e.g. a broken custom launcher).
      // Kill any surviving child and settle now rather than waiting indefinitely.
      try { child.kill("SIGKILL"); } finally { finish(forcedError); }
    });
    // close, unlike exit, waits for stdout/stderr to drain.
    child.once("close", (code, exitSignal) => {
      if (forcedError) finish(forcedError);
      else if (code === 124) finish(new Error(`Fetch timed out after ${timeoutMs} ms`));
      else if (code !== 0) finish(new Error(describeError(`Obscura fetch exited (code ${code}, signal ${exitSignal}).\n${stderr.toString("utf8").trim()}`, cwd)));
      else finish(undefined, Buffer.concat(chunks, bytes).toString("utf8"));
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (!child.stdout || !child.stderr) kill(new Error("Fetch launcher must provide piped stdout and stderr."));
    if (signal?.aborted) abort();
  });
}

export function registerFetchTool(pi: ExtensionAPI, deps: FetchToolDeps): string {
  const name = "browser_fetch";
  const description = "Read an HTTP(S) page once as markdown, text, HTML, or links. Independent of the MCP session: no login state and no refs; prefer session tools for authenticated pages or interactions.";
  pi.registerTool({
    name, label: "Browser fetch", description, promptSnippet: description,
    exposure: deps.getConfig().exposure, executionMode: "sequential",
    ...(deps.guideline ? { promptGuidelines: [deps.guideline] } : {}),
    annotations: { openWorldHint: true, readOnlyHint: true },
    parameters: Type.Object({
      url: Type.String({ minLength: 1 }),
      format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("markdown"), Type.Literal("html"), Type.Literal("links")])),
      maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 2147483647 })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 120000 })),
      waitUntil: Type.Optional(Type.Union([Type.Literal("load"), Type.Literal("domcontentloaded"), Type.Literal("networkidle0")])),
      selector: Type.Optional(Type.String({ minLength: 1 })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const start = Date.now();
      if (signal?.aborted) throw new Error("Browser fetch was aborted.");
      // Validate before binary resolution, which may request download consent.
      buildFetchArgs(params.url, params, deps.getConfig());
      const binary = await deps.ensureBinary(ctx, signal);
      if (signal?.aborted) throw new Error("Browser fetch was aborted.");
      const config = deps.getConfig();
      const args = buildFetchArgs(params.url, params, config);
      const child = deps.launchFetch ? deps.launchFetch(args) : spawn(binary, args, {
        env: buildChildEnv(deps.env ?? process.env), stdio: ["ignore", "pipe", "pipe"],
      });
      const text = await collectFetch(child, params.timeoutMs ?? 30000, signal, ctx.cwd, { killGraceMs: deps.killGraceMs });
      const bounded = await mcpContentToToolContent([{ type: "text", text }], {
        maxChars: params.maxChars ?? config.maxOutputChars, label: name,
      });
      return { content: bounded.content, details: {
        tool: name, durationMs: Math.max(0, Date.now() - start),
        ...(bounded.spilledPath ? { spilledPath: bounded.spilledPath } : {}),
      } };
    },
  });
  return name;
}
