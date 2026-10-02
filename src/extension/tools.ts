import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { abortableSleep, actionResult, artifactPath, httpUrl, optionalTarget, selectorTarget, storageState, targetArgs, writeArtifact } from "../actions.js";
import type { BrowserConfig } from "../config.js";
import { mcpContentToToolContent, type McpContent } from "../output.js";
import { checkedText } from "../page.js";
import type { BrowserSession } from "../session.js";
import { applyPendingStorage, restoreStorageState, type PendingStorage } from "../state.js";

const string = () => Type.String({ minLength: 1 });
const integer = (minimum = 1, maximum = 2147483647) => Type.Integer({ minimum, maximum });
const target = { ref: Type.Optional(string()), selector: Type.Optional(string()) };
const snapshot = { snapshot: Type.Optional(Type.Boolean()) };
const literals = <T extends string[]>(...values: T) => Type.Union(values.map((value) => Type.Literal(value)));
interface ToolOutput { text?: string; content?: McpContent[]; details?: Record<string, unknown> }

export function registerInteractionTools(pi: ExtensionAPI, options: {
  config: () => BrowserConfig;
  getSession: (ctx: ExtensionContext, signal?: AbortSignal) => Promise<BrowserSession>;
  now: () => number;
  guideline: string;
  pendingStorage?: PendingStorage;
}): string[] {
  const names: string[] = [];
  const config = options.config;
  const pendingStorage = options.pendingStorage ?? new Map();
  function register<T extends TSchema>(name: string, description: string, parameters: T, readOnly: boolean,
    run: (params: Static<T>, browser: BrowserSession, signal: AbortSignal | undefined, ctx: ExtensionContext) => Promise<ToolOutput>) {
    names.push(name);
    pi.registerTool({
      name, label: name.replaceAll("_", " "), description, parameters,
      exposure: config().exposure, executionMode: "sequential", promptGuidelines: [options.guideline],
      promptSnippet: description, annotations: { openWorldHint: true, readOnlyHint: readOnly },
      async execute(_id, params, signal, _update, ctx) {
        const start = options.now();
        const output = await run(params, await options.getSession(ctx, signal), signal, ctx);
        const bounded = await mcpContentToToolContent(output.content ?? [{ type: "text", text: output.text ?? "" }], { maxChars: config().maxOutputChars, label: name });
        return { content: bounded.content, details: { tool: name, durationMs: Math.max(0, options.now() - start), ...(bounded.spilledPath ? { spilledPath: bounded.spilledPath } : {}), ...output.details } };
      },
    });
  }
  async function call(browser: BrowserSession, name: string, args: Record<string, unknown>, signal?: AbortSignal, cwd?: string, deadlineMs?: number): Promise<string> {
    return checkedText(await browser.call(name, args, { signal, ...(deadlineMs !== undefined ? { deadlineMs } : {}) }), cwd);
  }
  async function action(browser: BrowserSession, name: string, args: Record<string, unknown>, params: { snapshot?: boolean }, signal?: AbortSignal, cwd?: string): Promise<ToolOutput> {
    return { text: await actionResult(browser, await call(browser, name, args, signal, cwd), params, config(), signal) };
  }

  register("browser_click", "Click an element by its current ref or CSS selector and return a fresh page summary unless snapshot is false.",
    Type.Object({ ...target, ...snapshot }), false, async (params, browser, signal, ctx) => action(browser, "browser_click", targetArgs(params), params, signal, ctx.cwd));

  register("browser_fill", "Fill one target with value, or fill a non-empty fields array with an optional submit target. Form results include any per-field errors verbatim, followed by a summary unless snapshot is false.",
    Type.Object({ ...target, value: Type.Optional(Type.String()), fields: Type.Optional(Type.Array(Type.Object({ ...target, value: Type.Optional(Type.String()), type: Type.Optional(literals("text", "check", "uncheck", "select")) }), { minItems: 1 })), submit: Type.Optional(Type.Object(target)), ...snapshot }), false,
    async (params, browser, signal, ctx) => {
      const single = params.ref !== undefined || params.selector !== undefined || params.value !== undefined;
      const form = params.fields !== undefined;
      if (single === form) throw new Error("Provide exactly one fill mode: ref or selector with value, or a non-empty fields array.");
      if (form) {
        if (!params.fields!.length) throw new Error("fields must be non-empty.");
        const fields = params.fields!.map((field) => ({ ...targetArgs(field), ...(field.value !== undefined ? { value: field.value } : {}), ...(field.type !== undefined ? { type: field.type } : {}) }));
        const submit = params.submit ? targetArgs(params.submit) : undefined;
        return action(browser, "browser_fill_form", { fields, ...(submit && "ref" in submit ? { submit_ref: submit.ref } : {}), ...(submit && "selector" in submit ? { submit_selector: submit.selector } : {}) }, params, signal, ctx.cwd);
      }
      const selected = targetArgs(params);
      if (params.value === undefined) throw new Error("Single fill mode requires value.");
      if (params.submit !== undefined) throw new Error("submit is only supported in form fill mode.");
      return action(browser, "browser_fill", { ...selected, value: params.value }, params, signal, ctx.cwd);
    });

  register("browser_type", "Type text into a ref or selector, optionally press Enter, and return a page summary unless snapshot is false.",
    Type.Object({ ...target, text: Type.String(), pressEnter: Type.Optional(Type.Boolean()), ...snapshot }), false, async (params, browser, signal, ctx) => {
      const selected = targetArgs(params);
      let headline = await call(browser, "browser_type", { ...selected, text: params.text }, signal, ctx.cwd);
      if (params.pressEnter) headline += `\n${await call(browser, "browser_press_key", { key: "Enter", ...selectorTarget(params) }, signal, ctx.cwd)}`;
      return { text: await actionResult(browser, headline, params, config(), signal) };
    });

  register("browser_press_key", "Press a key on an optional ref or selector and return a page summary unless snapshot is false.",
    Type.Object({ key: string(), ...target, ...snapshot }), false, async (params, browser, signal, ctx) => {
      const selected = optionalTarget(params);
      return action(browser, "browser_press_key", { key: params.key, ...(Object.keys(selected).length ? selectorTarget(params) : {}) }, params, signal, ctx.cwd);
    });

  register("browser_select", "Select an option value in a ref or selector and return a page summary unless snapshot is false.",
    Type.Object({ ...target, value: Type.String(), ...snapshot }), false, async (params, browser, signal, ctx) => action(browser, "browser_select_option", { ...selectorTarget(params), value: params.value }, params, signal, ctx.cwd));

  register("browser_scroll", "Scroll the page or an optional target and return a page summary unless snapshot is false.",
    Type.Object({ direction: Type.Optional(literals("top", "bottom", "up", "down", "left", "right")), amount: Type.Optional(Type.Number({ minimum: 0 })), ...target, ...snapshot }), false,
    async (params, browser, signal, ctx) => action(browser, "browser_scroll", { ...optionalTarget(params), ...(params.direction !== undefined ? { direction: params.direction } : {}), ...(params.amount !== undefined ? { amount: params.amount } : {}) }, params, signal, ctx.cwd));

  register("browser_wait", "Wait for exactly one selector, text, or a 1–30000 ms delay. No summary is returned unless snapshot is true.",
    Type.Object({ selector: Type.Optional(string()), text: Type.Optional(string()), ms: Type.Optional(integer(1, 30000)), timeoutMs: Type.Optional(integer(1, 2147478647)), ...snapshot }), true,
    async (params, browser, signal, ctx) => {
      if ([params.selector, params.text, params.ms].filter((value) => value !== undefined).length !== 1) throw new Error("Provide exactly one of selector, text or ms.");
      let headline: string;
      if (params.ms !== undefined) {
        await abortableSleep(params.ms, signal);
        headline = `Waited ${params.ms} ms.`;
      } else {
        const timeoutMs = params.timeoutMs ?? 30000;
        const timeout = Math.max(1, Math.ceil(timeoutMs / 1000));
        headline = await call(browser, params.selector !== undefined ? "browser_wait_for" : "browser_wait_for_text", { ...(params.selector !== undefined ? { selector: params.selector } : { text: params.text }), timeout }, signal, ctx.cwd, timeoutMs + 5000);
      }
      return { text: await actionResult(browser, headline, { snapshot: params.snapshot ?? false }, config(), signal) };
    });

  register("browser_screenshot", "Save a PNG screenshot and return its path, actual pixel dimensions, and one image block.",
    Type.Object({ width: Type.Optional(integer(1, 32768)), height: Type.Optional(integer(1, 32768)), path: Type.Optional(string()) }), true,
    async (params, browser, signal, ctx) => {
      const raw = await browser.call("browser_screenshot", { ...(params.width !== undefined ? { width: params.width } : {}), ...(params.height !== undefined ? { height: params.height } : {}) }, { signal });
      checkedText(raw, ctx.cwd);
      const image = raw.content.find((item) => item.type === "image" && item.mimeType === "image/png");
      if (!image || image.type !== "image") throw new Error("Obscura screenshot did not return a PNG image.");
      const bytes = Buffer.from(image.data, "base64");
      if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("Obscura screenshot returned an invalid PNG.");
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
      const path = await artifactPath(config(), ctx.cwd, "screenshot", "png", params.path);
      await writeArtifact(path, bytes);
      return { content: [{ type: "text", text: `Screenshot saved to ${path} (${width}×${height} px, ${bytes.length} bytes)` }, image], details: { path, width, height, bytes: bytes.length } };
    });

  register("browser_pdf", "Save the current page as a PDF and return only its path and byte count.",
    Type.Object({ path: Type.Optional(string()), landscape: Type.Optional(Type.Boolean()), printBackground: Type.Optional(Type.Boolean()), scale: Type.Optional(Type.Number({ minimum: 0.1, maximum: 2 })), paperWidth: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 200 })), paperHeight: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 200 })), marginTop: Type.Optional(Type.Number({ minimum: 0 })), marginBottom: Type.Optional(Type.Number({ minimum: 0 })), marginLeft: Type.Optional(Type.Number({ minimum: 0 })), marginRight: Type.Optional(Type.Number({ minimum: 0 })) }), true,
    async (params, browser, signal, ctx) => {
      const args: Record<string, unknown> = {};
      const mapping = { landscape: "landscape", printBackground: "print_background", scale: "scale", paperWidth: "paper_width", paperHeight: "paper_height", marginTop: "margin_top", marginBottom: "margin_bottom", marginLeft: "margin_left", marginRight: "margin_right" } as const;
      for (const key of Object.keys(mapping) as (keyof typeof mapping)[]) if (params[key] !== undefined) args[mapping[key]] = params[key];
      const raw = await browser.call("browser_pdf", args, { signal });
      checkedText(raw, ctx.cwd);
      const resource = raw.content.find((item) => item.type === "resource" && item.resource.blob !== undefined && (item.resource.mimeType === "application/pdf" || item.resource.uri === "obscura://capture/current-page.pdf"));
      if (!resource || resource.type !== "resource" || resource.resource.blob === undefined) throw new Error("Obscura PDF did not return an embedded PDF resource.");
      const bytes = Buffer.from(resource.resource.blob, "base64");
      if (bytes.toString("ascii", 0, 4) !== "%PDF") throw new Error("Obscura PDF returned an invalid PDF.");
      const path = await artifactPath(config(), ctx.cwd, "page", "pdf", params.path);
      await writeArtifact(path, bytes);
      return { text: `PDF saved to ${path} (${bytes.length} bytes)`, details: { path, bytes: bytes.length } };
    });

  register("browser_extract", "Read markdown, links, search results, schema data, forms, console messages, or network requests. Schema maps field names to CSS selectors: field[] produces an array and selector@attr reads an attribute.",
    Type.Object({ mode: literals("markdown", "links", "search", "schema", "forms", "console", "network"), maxChars: Type.Optional(integer()), limit: Type.Optional(integer()), internalOnly: Type.Optional(Type.Boolean()), query: Type.Optional(string()), caseSensitive: Type.Optional(Type.Boolean()), contextChars: Type.Optional(integer(0)), schema: Type.Optional(Type.Record(Type.String(), Type.String())) }), true,
    async (params, browser, signal, ctx) => {
      let name: string, args: Record<string, unknown>;
      switch (params.mode) {
        case "markdown": name = "browser_markdown"; args = { max_chars: params.maxChars ?? config().maxOutputChars }; break;
        case "links": name = "browser_links"; args = { ...(params.limit !== undefined ? { limit: params.limit } : {}), ...(params.internalOnly !== undefined ? { internal_only: params.internalOnly } : {}) }; break;
        case "search":
          if (!params.query?.trim()) throw new Error("Search mode requires query.");
          name = "browser_search"; args = { query: params.query, ...(params.caseSensitive !== undefined ? { case_sensitive: params.caseSensitive } : {}), ...(params.limit !== undefined ? { limit: params.limit } : {}), ...(params.contextChars !== undefined ? { context_chars: params.contextChars } : {}) }; break;
        case "schema":
          if (params.schema === undefined || params.schema === null || Array.isArray(params.schema)) throw new Error("Schema mode requires a schema object.");
          name = "browser_extract"; args = { schema: params.schema }; break;
        case "forms": name = "browser_detect_forms"; args = {}; break;
        case "console": name = "browser_console_messages"; args = {}; break;
        case "network": name = "browser_network_requests"; args = {}; break;
        default: throw new Error("Unknown extract mode.");
      }
      return { text: await call(browser, name, args, signal, ctx.cwd), details: { mode: params.mode } };
    });

  register("browser_tabs", "List, new, switch, close, back, forward, or reload tabs; actions except list/close return a summary unless snapshot is false. Inactive tabs keep their DOM but JavaScript state is suspended: timers, in-memory variables, and sessionStorage may be lost.",
    Type.Object({ action: literals("list", "new", "switch", "close", "back", "forward", "reload"), url: Type.Optional(string()), tabId: Type.Optional(string()), ...snapshot }), false,
    async (params, browser, signal, ctx) => {
      let name: string, args: Record<string, unknown> = {};
      switch (params.action) {
        case "list": name = "browser_tab_list"; break;
        case "new":
          if (params.url !== undefined) { httpUrl(params.url, "browser_tabs new"); args.url = params.url; }
          name = "browser_tab_new"; break;
        case "switch":
          if (!params.tabId?.trim()) throw new Error("Switch action requires tabId.");
          name = "browser_tab_switch"; args.tab_id = params.tabId; break;
        case "close": name = "browser_tab_close"; if (params.tabId !== undefined) args.tab_id = params.tabId; break;
        case "back": name = "browser_back"; break;
        case "forward": name = "browser_forward"; break;
        case "reload": name = "browser_reload"; break;
        default: throw new Error("Unknown tabs action.");
      }
      let headline = await call(browser, name, args, signal, ctx.cwd);
      if (params.action !== "list" && params.action !== "close") {
        const applied = await applyPendingStorage(browser, pendingStorage, { signal });
        if (applied) headline += `\n${applied}`;
      }
      return { text: params.action === "list" || params.action === "close" ? headline : await actionResult(browser, headline, params, config(), signal), details: { action: params.action } };
    });

  register("browser_state", "Read or modify cookies, export/import JSON storage state, or reset the browser (reset loses all tabs and restarts the process). Exports include only the active page's origin storage; imports apply matching origin storage and queue other origins until navigation there.",
    Type.Object({ action: literals("cookies", "set_cookie", "clear_cookies", "export", "import", "reset"), domain: Type.Optional(string()), cookie: Type.Optional(Type.Object({ name: string(), value: Type.String(), domain: string(), path: Type.Optional(string()), secure: Type.Optional(Type.Boolean()), httpOnly: Type.Optional(Type.Boolean()) })), path: Type.Optional(string()) }), false,
    async (params, browser, signal, ctx) => {
      const details: Record<string, unknown> = { action: params.action };
      switch (params.action) {
        case "cookies": return { text: await call(browser, "browser_get_cookies", params.domain !== undefined ? { domain: params.domain } : {}, signal, ctx.cwd), details };
        case "set_cookie": {
          if (!params.cookie) throw new Error("set_cookie action requires cookie.");
          const { httpOnly, ...cookie } = params.cookie;
          return { text: await call(browser, "browser_set_cookie", { ...cookie, ...(httpOnly !== undefined ? { http_only: httpOnly } : {}) }, signal, ctx.cwd), details };
        }
        case "clear_cookies": return { text: await call(browser, "browser_clear_cookies", {}, signal, ctx.cwd), details };
        case "export": {
          const state = storageState(JSON.parse(await call(browser, "browser_storage_state", {}, signal, ctx.cwd)));
          const path = await artifactPath(config(), ctx.cwd, "state", "json", params.path);
          await writeArtifact(path, JSON.stringify(state, null, 2));
          return { text: `Storage state saved to ${path} (${state.cookies.length} cookies, ${state.origins.length} origins). Only the active page's origin storage is included.`, details: { ...details, path, cookies: state.cookies.length, origins: state.origins.length } };
        }
        case "import": {
          if (!params.path?.trim()) throw new Error("Import action requires path.");
          const path = resolve(ctx.cwd, params.path);
          const state = JSON.parse(await readFile(path, "utf8"));
          const report = await restoreStorageState(browser, state, { signal, cwd: ctx.cwd, pending: pendingStorage });
          const { text, ...counts } = report;
          return { text, details: { ...details, path, origins: state.origins.length, ...counts } };
        }
        case "reset": {
          pendingStorage.clear();
          const previousPid = browser.status().pid;
          await call(browser, "browser_clear_cookies", {}, signal, ctx.cwd);
          await call(browser, "browser_close", {}, signal, ctx.cwd);
          await browser.restart();
          pendingStorage.clear();
          return { text: "Browser reset: cookies cleared, tabs closed, process restarted.", details: { ...details, previousPid, pid: browser.status().pid } };
        }
        default: throw new Error("Unknown state action.");
      }
    });
  return names;
}
