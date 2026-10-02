import type { Exposure } from "./config.js";

/** Hybrid policy. Add future curated tools here; unknown tools are deferred by default. */
export const BROWSER_TOOL_EXPOSURE: Record<string, "direct" | "deferred"> = {
  browser_navigate: "direct",
  browser_snapshot: "direct",
  browser_click: "direct",
  browser_fill: "direct",
  browser_type: "direct",
  browser_wait: "direct",
  browser_screenshot: "direct",
  browser_evaluate: "direct",
  browser_fetch: "direct",
  browser_tabs: "deferred",
  browser_extract: "deferred",
  browser_state: "deferred",
  browser_pdf: "deferred",
  browser_press_key: "deferred",
  browser_select: "deferred",
  browser_scroll: "deferred",
  browser_hover: "deferred",
  browser_upload: "deferred",
  browser_dialog: "deferred",
  browser_emulate: "deferred",
  browser_perf: "deferred",
  browser_network_request: "deferred",
};

export const DIRECT_TOOL_NAMES = Object.keys(BROWSER_TOOL_EXPOSURE)
  .filter((name) => BROWSER_TOOL_EXPOSURE[name] === "direct");
export const DEFERRED_TOOL_NAMES = Object.keys(BROWSER_TOOL_EXPOSURE)
  .filter((name) => BROWSER_TOOL_EXPOSURE[name] === "deferred");

export function toolExposure(name: string, mode: Exposure): "direct" | "deferred" {
  if (mode !== "hybrid") return mode;
  return BROWSER_TOOL_EXPOSURE[name] ?? "deferred";
}

/** Compute from the table so added engine-specific tools are discoverable too. */
export function deferredToolNames(mode: Exposure = "hybrid"): string[] {
  return Object.keys(BROWSER_TOOL_EXPOSURE).filter((name) => toolExposure(name, mode) === "deferred");
}

export function deferredToolGuideline(mode: Exposure = "hybrid"): string {
  const names = deferredToolNames(mode);
  return names.length > 0 ? `More browser tools are available through tool_search: ${names.join(", ")}.` : "";
}
