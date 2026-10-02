import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface BrowserConfig {
  binaryPath: string | null;
  version: string;
  variant: "render" | "stealth";
  autoInstall: "ask" | "never";
  profile: string | null;
  rawMcp: boolean;
  allowPrivateNetwork: boolean;
  stealth: boolean;
  proxy: string | null;
  userAgent: string | null;
  timeoutMs: number;
  evaluateTimeoutMs: number;
  idleMs: number;
  maxOutputChars: number;
  actionSummaryChars: number;
  artifactsDir: string | null;
  exposure: "direct" | "deferred";
}

export const DEFAULT_BROWSER_CONFIG: Readonly<BrowserConfig> = Object.freeze({
  binaryPath: null,
  version: "0.2.3",
  variant: "render",
  autoInstall: "ask",
  profile: null,
  rawMcp: false,
  allowPrivateNetwork: false,
  stealth: false,
  proxy: null,
  userAgent: null,
  timeoutMs: 45_000,
  evaluateTimeoutMs: 30_000,
  idleMs: 600_000,
  maxOutputChars: 12_000,
  actionSummaryChars: 3000,
  artifactsDir: null,
  exposure: "direct",
});

export interface LoadedBrowserConfig {
  config: BrowserConfig;
  /** Valid, applied files in ascending precedence order. */
  sources: string[];
  errors: string[];
}

export function isValidProfileName(value: unknown): value is string {
  return typeof value === "string" && /^[\w.-]{1,64}$/.test(value);
}

function validate(value: unknown): Partial<BrowserConfig> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected a JSON object");
  }
  const problems: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (!Object.hasOwn(DEFAULT_BROWSER_CONFIG, key)) {
      problems.push(`unknown key "${key}"`);
      continue;
    }
    let valid = false;
    let expected = "";
    switch (key) {
      case "binaryPath":
      case "proxy":
      case "userAgent":
      case "artifactsDir":
        valid = entry === null || (typeof entry === "string" && entry.trim().length > 0);
        expected = "a non-empty string or null";
        break;
      case "version":
        // Versions form a cache directory name; never permit path traversal.
        valid = typeof entry === "string" && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(entry);
        expected = "a release version such as 0.2.3";
        break;
      case "variant":
        valid = entry === "render" || entry === "stealth";
        expected = '"render" or "stealth"';
        break;
      case "autoInstall":
        valid = entry === "ask" || entry === "never";
        expected = '"ask" or "never"';
        break;
      case "profile":
        valid = entry === null || isValidProfileName(entry);
        expected = 'a profile name matching /^[\\w.-]{1,64}$/ or null';
        break;
      case "exposure":
        valid = entry === "direct" || entry === "deferred";
        expected = '"direct" or "deferred"';
        break;
      case "allowPrivateNetwork":
      case "stealth":
      case "rawMcp":
        valid = typeof entry === "boolean";
        expected = "a boolean";
        break;
      default:
        // Node timers overflow above 2^31-1 ms. Keep all numeric limits finite
        // and integral rather than accepting coercions or disabling deadlines.
        valid = typeof entry === "number" && Number.isInteger(entry) && entry >= 1 && entry <= 2_147_483_647;
        expected = "an integer from 1 to 2147483647";
    }
    if (!valid) problems.push(`${key} must be ${expected}`);
  }
  if (problems.length > 0) throw new Error(problems.join("; "));
  return value as Partial<BrowserConfig>;
}

export { validate as validateBrowserConfig };

/** Merge defaults, user config, then trusted project config; ignore an invalid file atomically. */
export async function loadBrowserConfig(options: {
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
}): Promise<LoadedBrowserConfig> {
  const result: LoadedBrowserConfig = { config: { ...DEFAULT_BROWSER_CONFIG }, sources: [], errors: [] };
  const paths = [join(options.agentDir, "browser.config.json")];
  if (options.projectTrusted) paths.push(join(options.cwd, ".pi", "browser.config.json"));
  for (const path of paths) {
    try {
      const values = validate(JSON.parse(await readFile(path, "utf8")) as unknown);
      Object.assign(result.config, values);
      result.sources.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      result.errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}
