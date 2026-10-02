import { spawn, type ChildProcess } from "node:child_process";
import type { BrowserConfig } from "./config.js";
import type { McpContent } from "./output.js";

export class BrowserRestartedError extends Error {
  constructor(reason = "The request deadline was exceeded") {
    super(`${reason}; the browser process was terminated and open tabs were lost.`);
    this.name = "BrowserRestartedError";
  }
}

export class BrowserAbortedError extends BrowserRestartedError {
  constructor() {
    super("The browser request was aborted");
    this.name = "BrowserAbortedError";
  }
}

/** Flags shared by the MCP server and the independent fetch CLI. */
export function obscuraGlobalArgs(config: BrowserConfig): string[] {
  const args: string[] = [];
  if (config.allowPrivateNetwork) args.push("--allow-private-network");
  if (config.stealth) args.push("--stealth");
  if (config.proxy) args.push("--proxy", config.proxy);
  return args;
}

export function buildObscuraArgs(config: BrowserConfig): string[] {
  const args = ["mcp", ...obscuraGlobalArgs(config)];
  if (config.userAgent) args.push("--user-agent", config.userAgent);
  return args;
}

export function buildChildEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(parentEnv).filter(([key, value]) =>
    value !== undefined && (["PATH", "HOME", "TMPDIR", "TMP", "TEMP"].includes(key) || key.startsWith("OBSCURA_"))));
}

export interface McpToolResult { content: McpContent[]; isError: boolean }
export interface McpTool { name: string; description?: string; inputSchema: Record<string, unknown> }
export interface CallOptions { deadlineMs?: number; signal?: AbortSignal }
export interface McpClientOptions {
  binary: string;
  config: BrowserConfig;
  version?: string;
  launch?: () => ChildProcess;
  env?: NodeJS.ProcessEnv;
  onStateChange?: (state: { running: boolean; pid: number | undefined }) => void;
}

interface Job {
  method: string;
  params: unknown;
  options: CallOptions;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
  cancelled?: Error;
}
interface Pending { id: number; resolve: (value: unknown) => void; reject: (error: Error) => void }

/** A single mutable browser is shared by all requests: even the handshake is serialized. */
export class ObscuraMcpClient {
  private child?: ChildProcess;
  private initialized = false;
  private disposed = false;
  private nextId = 1;
  private queue: Job[] = [];
  private active?: Job;
  private pumping = false;
  private pending?: Pending;
  private stderr = Buffer.alloc(0);
  private exitPromise: Promise<void> = Promise.resolve();
  private termination?: Promise<void>;
  private closePromise?: Promise<void>;

  constructor(private readonly options: McpClientOptions) {}

  get pid(): number | undefined { return this.isRunning ? this.child?.pid : undefined; }
  get isRunning(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null && !this.termination;
  }
  stderrTail(): string { return this.stderr.toString("utf8"); }

  async initialize(options: CallOptions = {}): Promise<void> { await this.enqueue("__initialize", {}, options); }
  async listTools(): Promise<McpTool[]> {
    const result = await this.enqueue("tools/list", {}, {}) as { tools?: McpTool[] };
    return result.tools ?? [];
  }
  async callTool(name: string, args: Record<string, unknown>, options: CallOptions = {}): Promise<McpToolResult> {
    const result = await this.enqueue("tools/call", { name, arguments: args }, options) as Partial<McpToolResult>;
    if (!Array.isArray(result.content)) throw new Error("Invalid MCP tools/call response: missing content");
    return { content: result.content, isError: result.isError === true };
  }

  private enqueue(method: string, params: unknown, options: CallOptions): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("Browser MCP client is closed"));
    if (options.signal?.aborted) {
      const error = new BrowserAbortedError();
      this.failAll(error);
      void this.terminate();
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.failAll(new BrowserAbortedError());
        void this.terminate();
      };
      const job: Job = { method, params, options, resolve, reject,
        cleanup: () => options.signal?.removeEventListener("abort", abort) };
      options.signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(job);
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length && !this.disposed) {
        const job = this.queue.shift()!;
        this.active = job;
        let timer: NodeJS.Timeout | undefined;
        try {
          // Deadline includes initialization as well as the actual request.
          const deadline = job.options.deadlineMs ?? this.options.config.timeoutMs;
          timer = setTimeout(() => {
            this.failAll(new BrowserRestartedError(`Browser request exceeded ${deadline} ms`));
            void this.terminate();
          }, deadline);
          await this.start(job);
          if (job.cancelled) throw job.cancelled;
          const result = job.method === "__initialize" ? undefined : await this.request(job.method, job.params);
          job.resolve(result);
        } catch (error) {
          job.reject(error instanceof Error ? error : new Error(String(error)));
        } finally {
          if (timer) clearTimeout(timer);
          job.cleanup();
          this.active = undefined;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async start(job: Job): Promise<void> {
    if (this.termination) await this.termination;
    if (this.child && !this.isRunning) await this.exitPromise;
    if (job.cancelled) throw job.cancelled;
    if (this.disposed) throw new Error("Browser MCP client is closed");
    if (this.initialized && this.isRunning) return;
    this.stderr = Buffer.alloc(0);
    const child = this.options.launch?.() ?? spawn(this.options.binary, buildObscuraArgs(this.options.config), {
      stdio: ["pipe", "pipe", "pipe"], env: buildChildEnv(this.options.env ?? process.env),
    });
    this.child = child;
    this.initialized = false;
    let buffer = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        this.receive(line);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr = Buffer.concat([this.stderr, Buffer.from(chunk)]).subarray(-4096);
    });
    this.exitPromise = new Promise<void>((resolve) => {
      let finished = false;
      const finish = (reason: string) => {
        if (finished) return;
        finished = true;
        this.initialized = false;
        if (!this.termination) this.failAll(new Error(`${reason}. Browser process exited; open tabs were lost.\n${this.stderrTail()}`));
        this.options.onStateChange?.({ running: false, pid: undefined });
        resolve();
      };
      // 'close' fires after stderr drains, so diagnostics include the last output.
      child.once("close", (code, signal) => finish(`Obscura exited (code ${code}, signal ${signal})`));
      child.once("error", (error) => finish(`Cannot launch obscura: ${error.message}`));
    });
    child.stdin?.on("error", (error) => {
      if (!this.termination) this.failAll(new Error(`Obscura stdin failed: ${error.message}\n${this.stderrTail()}`));
      void this.terminate();
    });
    if (!child.stdin || !child.stdout || !child.stderr) {
      void this.terminate();
      throw new Error("Browser launcher must provide piped stdin, stdout, and stderr");
    }
    try {
      await this.request("initialize", {
        protocolVersion: "2024-11-05", capabilities: {},
        clientInfo: { name: "pi-browser", version: this.options.version ?? "0.1.0" },
      });
      if (job.cancelled) throw job.cancelled;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      this.initialized = true;
      this.options.onStateChange?.({ running: true, pid: child.pid });
    } catch (error) {
      if (!job.cancelled) this.failAll(error instanceof Error ? error : new Error(String(error)));
      void this.terminate();
      throw error;
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending = { id, resolve, reject };
      this.child!.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (error && this.pending?.id === id) {
          this.pending = undefined;
          reject(error);
        }
      });
    });
  }

  private receive(line: string): void {
    let response: { id?: unknown; result?: unknown; error?: { code?: number; message?: string } };
    try { response = JSON.parse(line); } catch { return; }
    if (!response || !this.pending || response.id !== this.pending.id) return;
    const pending = this.pending;
    this.pending = undefined;
    if (response.error) pending.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
    else pending.resolve(response.result);
  }

  private failAll(error: Error): void {
    this.pending?.reject(error);
    this.pending = undefined;
    if (this.active) this.active.cancelled = error;
    this.active?.reject(error);
    this.active?.cleanup();
    for (const job of this.queue.splice(0)) { job.cleanup(); job.reject(error); }
  }

  private terminate(): Promise<void> {
    if (this.termination) return this.termination;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return this.exitPromise;
    this.initialized = false;
    this.options.onStateChange?.({ running: false, pid: undefined });
    child.stdin?.end();
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    timer.unref();
    this.termination = this.exitPromise.finally(() => {
      clearTimeout(timer);
      this.termination = undefined;
    });
    return this.termination;
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.disposed = true;
      this.failAll(new Error("Browser process was terminated; open tabs were lost (client closed)."));
      this.closePromise = this.terminate();
    }
    return this.closePromise;
  }
}
