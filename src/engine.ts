export type EngineName = "obscura" | "chrome";
export type Target = { ref: string } | { selector: string };
export interface PageElement { ref: string; kind: string; label: string }
export interface PageSummary { url: string; title: string; text: string; elements?: PageElement[]; raw?: string }
export interface EngineCapabilities {
  selectors: boolean; pdf: boolean; storageState: boolean; cookies: boolean; markdown: boolean;
  search: boolean; schemaExtract: boolean; forms: boolean; fullPageScreenshot: boolean;
  hover: boolean; upload: boolean; dialog: boolean; emulate: boolean; performance: boolean; networkDetail: boolean;
}
export class UnsupportedOperationError extends Error {
  constructor(engine: EngineName, operation: string, alternative?: EngineName) {
    super(`Not supported by the ${engine} engine: ${operation}.${alternative ? ` Use engine "${alternative}" (browser_navigate { engine }) instead.` : ""}`);
    this.name = "UnsupportedOperationError";
  }
}
export interface Cookie { name: string; value: string; domain: string; path?: string; secure?: boolean; httpOnly?: boolean }
export type TabAction = "list" | "new" | "switch" | "close" | "back" | "forward" | "reload";
export interface EngineStatus { running: boolean; pid?: number; detail: string; binary?: string }
export type ChromeNetwork = "Offline" | "Slow 3G" | "Fast 3G" | "Slow 4G" | "Fast 4G";
export interface EmulateOptions { cpu?: number; network?: ChromeNetwork; viewport?: string }
export interface PerfOptions { action: "start" | "stop" | "insight"; reload?: boolean; autoStop?: boolean; insightName?: string; insightSetId?: string }
/** Engine owns protocol names, argument mapping, ref validation and raw response decoding. */
export interface BrowserEngine {
  readonly name: EngineName;
  readonly capabilities: EngineCapabilities;
  navigate(url: string, opts: { waitUntil?: string; signal?: AbortSignal }): Promise<string>;
  summarize(opts: { maxChars: number; limit?: number; includeInteractive?: boolean; signal?: AbortSignal }): Promise<PageSummary>;
  click(target: Target, signal?: AbortSignal): Promise<string>;
  fill(target: Target, value: string, signal?: AbortSignal): Promise<string>;
  fillForm(fields: Array<Partial<Target> & { value?: string; type?: string }>, submit?: Target, signal?: AbortSignal): Promise<string>;
  type(target: Target, text: string, pressEnter: boolean, signal?: AbortSignal): Promise<string>;
  pressKey(key: string, target?: Target, signal?: AbortSignal): Promise<string>;
  select(target: Target, value: string, signal?: AbortSignal): Promise<string>;
  scroll(opts: { direction?: string; amount?: number; target?: Target }, signal?: AbortSignal): Promise<string>;
  waitFor(opts: { selector?: string; text?: string; timeoutMs: number }, signal?: AbortSignal): Promise<string>;
  screenshot(opts: { width?: number; height?: number; fullPage?: boolean }, signal?: AbortSignal): Promise<{ png: Buffer; text?: string }>;
  pdf(opts: Record<string, unknown>, signal?: AbortSignal): Promise<Buffer>;
  evaluate(expression: string, signal?: AbortSignal): Promise<string>;
  markdown(maxChars: number, signal?: AbortSignal): Promise<string>;
  links(limit?: number, internalOnly?: boolean, signal?: AbortSignal): Promise<string>;
  search(opts: { query: string; caseSensitive?: boolean; limit?: number; contextChars?: number }, signal?: AbortSignal): Promise<string>;
  extract(schema: object, signal?: AbortSignal): Promise<string>;
  forms(signal?: AbortSignal): Promise<string>;
  consoleMessages(signal?: AbortSignal): Promise<string>;
  networkRequests(signal?: AbortSignal): Promise<string>;
  tabs(action: TabAction, opts: { url?: string; tabId?: string }, signal?: AbortSignal): Promise<string>;
  cookies(domain?: string, signal?: AbortSignal): Promise<string>;
  setCookie(cookie: Cookie, signal?: AbortSignal): Promise<string>;
  clearCookies(signal?: AbortSignal): Promise<string>;
  storageState(signal?: AbortSignal): Promise<unknown>;
  setStorageState(state: unknown, signal?: AbortSignal): Promise<string>;
  hover?(target: Target, signal?: AbortSignal): Promise<string>;
  upload?(target: Target, paths: string[], signal?: AbortSignal): Promise<string>;
  dialog?(action: "accept" | "dismiss", promptText?: string, signal?: AbortSignal): Promise<string>;
  emulate?(options: EmulateOptions, signal?: AbortSignal): Promise<string>;
  perf?(options: PerfOptions, signal?: AbortSignal): Promise<string>;
  networkRequest?(idOrUrl: string, signal?: AbortSignal): Promise<string>;
  closeAll(signal?: AbortSignal): Promise<void>;
  restart(): Promise<void>;
  stop(): Promise<void>;
  status(): EngineStatus;
}
