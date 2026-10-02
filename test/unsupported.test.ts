import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage as reply } from "@earendil-works/pi-ai";
import { DEFAULT_BROWSER_CONFIG } from "../src/config.js";
import { UnsupportedOperationError, type EngineName } from "../src/engine.js";
import { OBSCURA_CAPABILITIES, ObscuraEngine } from "../src/engines/obscura.js";
import { createHarness, tool, type Harness } from "./helpers/harness.js";

/** Test-only engine identity; no external browser or MCP process is needed. */
class PdfLessEngine extends ObscuraEngine {
  override readonly name: EngineName = "chrome";
  override readonly capabilities = { ...OBSCURA_CAPABILITIES, pdf: false };
  override pdf = vi.fn(async () => { throw new Error("Unsupported PDF must not reach the engine method."); });
}

const open: Harness[] = [];
afterEach(async () => { for (const h of open.splice(0)) await h.dispose(); });

describe("unsupported engine operations", () => {
  it("provides a named error with the engine, operation and alternative navigation hint", () => {
    const error = new UnsupportedOperationError("chrome", "PDF", "obscura");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("UnsupportedOperationError");
    expect(error.message).toBe('Not supported by the chrome engine: PDF. Use engine "obscura" (browser_navigate { engine }) instead.');
    expect(new UnsupportedOperationError("obscura", "hover").message).toBe("Not supported by the obscura engine: hover.");
    expect(new UnsupportedOperationError("obscura", "full-page screenshot", "chrome").message)
      .toBe('Not supported by the obscura engine: full-page screenshot. Use engine "chrome" (browser_navigate { engine }) instead.');
  });

  it("propagates UnsupportedOperationError through browser_pdf without calling the unsupported engine method", async () => {
    const engine = new PdfLessEngine({ config: { ...DEFAULT_BROWSER_CONFIG } });
    const h = await createHarness({
      config: { exposure: "direct" },
      extension: { engineFactories: { chrome: () => engine }, engineAvailability: { chrome: () => ({ ok: true }) } },
      steps: [tool("browser_pdf", {}), reply("done")],
    });
    open.push(h);
    expect(await h.manager.select({ engine: "chrome" })).toBe(engine);
    await h.session.prompt("Export a PDF from the selected engine.");
    const result = h.session.messages.find(message => message.role === "toolResult");
    expect(result).toMatchObject({ role: "toolResult", toolName: "browser_pdf", isError: true });
    expect(result?.role === "toolResult" && result.content).toContainEqual({
      type: "text", text: 'Not supported by the chrome engine: PDF. Use engine "obscura" (browser_navigate { engine }) instead.',
    });
    expect(engine.pdf).not.toHaveBeenCalled();
    expect(h.children).toHaveLength(0);
    expect(h.errors).toEqual([]);
  });
});
