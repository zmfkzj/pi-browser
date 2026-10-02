import type { ChildProcess } from "node:child_process";
import type { BinaryResolution, BinarySource } from "./binary.js";
import type { BrowserConfig } from "./config.js";
import { ObscuraMcpClient, type CallOptions, type McpToolResult } from "./mcp-client.js";

export type SessionHookCall = (tool: string, args: Record<string, unknown>) => Promise<McpToolResult>;

export interface BrowserSessionOptions {
  config: BrowserConfig;
  resolveBinary?: () => BinaryResolution | Promise<BinaryResolution>;
  binary?: string;
  source?: BinarySource;
  launch?: () => ChildProcess;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  onStateChange?: (state: { running: boolean; pid: number | undefined }) => void;
  /** Best effort; use the supplied call function, not session.call (which would recurse). */
  onAfterStart?: (call: SessionHookCall) => Promise<void>;
  onBeforeStop?: (call: SessionHookCall) => Promise<void>;
  onHookError?: (error: unknown, phase: "restore" | "save") => void;
}

export interface BrowserStatus {
  running: boolean;
  pid: number | undefined;
  binary: string | undefined;
  source: BinarySource | undefined;
  startedAt: number | undefined;
  calls: number;
}

export class BrowserSession {
  private client?: ObscuraMcpClient;
  private starting?: Promise<void>;
  private preparing?: Promise<ObscuraMcpClient>;
  private stopping?: Promise<void>;
  private idleTimer?: NodeJS.Timeout;
  private binary?: string;
  private source?: BinarySource;
  private startedAt?: number;
  private calls = 0;
  private activeCalls = 0;
  private readyPid?: number;
  private restoring?: Promise<void>;

  constructor(private readonly options: BrowserSessionOptions) {
    this.binary = options.binary;
    this.source = options.source;
  }

  ensureStarted(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async start(): Promise<void> {
    const client = await this.getClient();
    await this.initialize(client);
    if (this.activeCalls === 0 && client.isRunning) this.armIdle();
  }

  private async runHook(client: ObscuraMcpClient, phase: "restore" | "save"): Promise<void> {
    const hook = phase === "restore" ? this.options.onAfterStart : this.options.onBeforeStop;
    if (!hook) return;
    const deadlineMs = phase === "restore" ? 10_000 : 5_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        hook((tool, args) => client.callTool(tool, args, { deadlineMs })),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Profile ${phase} exceeded ${deadlineMs} ms`)), deadlineMs); }),
      ]);
    } catch (error) {
      // Neither a profile nor an error-reporting callback may prevent lifecycle cleanup.
      try { this.options.onHookError?.(error, phase); } catch { /* Best effort. */ }
    } finally { if (timer) clearTimeout(timer); }
  }

  private async initialize(client: ObscuraMcpClient, options: CallOptions = {}): Promise<void> {
    await client.initialize(options);
    if (this.readyPid === client.pid) return;
    if (!this.restoring) {
      this.restoring = this.runHook(client, "restore").then(() => { this.readyPid = client.pid; })
        .finally(() => { this.restoring = undefined; });
    }
    await this.restoring;
  }

  private getClient(): Promise<ObscuraMcpClient> {
    if (this.stopping) return this.stopping.then(() => this.getClient());
    if (this.preparing) return this.preparing;
    if (this.client) return Promise.resolve(this.client);
    this.preparing = this.prepare().finally(() => { this.preparing = undefined; });
    return this.preparing;
  }

  private async prepare(): Promise<ObscuraMcpClient> {
    const resolution = this.options.resolveBinary ? await this.options.resolveBinary() :
      this.binary ? { ok: true as const, path: this.binary, source: this.source ?? "config" as const } :
        { ok: false as const, message: "Obscura executable not found. Configure binaryPath or PI_BROWSER_OBSCURA_BIN, put obscura on PATH, or run /browser install." };
    if (!resolution.ok) throw new Error(resolution.message);
    this.binary = resolution.path;
    this.source = resolution.source;
    this.client = new ObscuraMcpClient({
      binary: resolution.path, config: this.options.config, launch: this.options.launch, env: this.options.env,
      onStateChange: (state) => {
        if (state.running) {
          this.startedAt = (this.options.now ?? Date.now)();
          if (!this.options.onAfterStart) this.readyPid = state.pid;
        } else { this.startedAt = undefined; this.readyPid = undefined; this.clearIdle(); }
        this.options.onStateChange?.(state);
      },
    });
    return this.client;
  }

  async call(tool: string, args: Record<string, unknown>, options: CallOptions = {}): Promise<McpToolResult> {
    this.activeCalls++;
    this.clearIdle();
    try {
      const client = await this.getClient();
      const callOptions = {
        ...options,
        deadlineMs: options.deadlineMs ?? (tool === "browser_evaluate" ? this.options.config.evaluateTimeoutMs : this.options.config.timeoutMs),
      };
      // Retain the MCP client's queued handshake/deadline behavior when no restore is needed.
      if (this.options.onAfterStart) await this.initialize(client, callOptions);
      this.calls++;
      return await client.callTool(tool, args, callOptions);
    } finally {
      this.activeCalls--;
      if (this.activeCalls === 0 && this.client?.isRunning) this.armIdle();
    }
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private armIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => { void this.stop(); }, this.options.config.idleMs);
    this.idleTimer.unref();
  }

  async restart(): Promise<void> { await this.stop(); await this.ensureStarted(); }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.clearIdle();
    const starting = this.starting;
    const preparing = this.preparing;
    this.stopping = (async () => {
      // Save only a successfully initialized, live child, never a hung/killed one.
      if (this.client?.isRunning && this.readyPid === this.client.pid) await this.runHook(this.client, "save");
      // A concurrent handshake is owned by this session, too.
      if (this.client) await this.client.close();
      if (preparing) await preparing.catch(() => {});
      if (this.client) await this.client.close();
      if (starting) await starting.catch(() => {});
      this.client = undefined;
      this.readyPid = undefined;
      this.startedAt = undefined;
      this.options.onStateChange?.({ running: false, pid: undefined });
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  status(): BrowserStatus {
    return { running: this.client?.isRunning ?? false, pid: this.client?.pid,
      binary: this.binary, source: this.source, startedAt: this.startedAt, calls: this.calls };
  }
}
