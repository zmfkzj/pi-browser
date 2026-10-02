import { existsSync, readFileSync } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
let isUmbrella = false;
try {
  isUmbrella = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).name === "oh-my-pi-extensions"
    && existsSync(join(repoRoot, "orche/package.json"));
} catch { /* Standalone checkouts have no umbrella manifest. */ }

it.skipIf(!isUmbrella)("loads root batch-install extensions and discovers the browser skill through Pi", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-root-manifest-"));
  try {
    const manifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { pi: { extensions: string[]; skills: string[] } };
    expect(manifest.pi.skills).toEqual(["./browser/skills"]);
    const browserManifest = JSON.parse(await readFile(join(repoRoot, "browser/package.json"), "utf8")) as { pi: { skills: string[] } };
    expect(browserManifest.pi.skills).toEqual(["./skills"]);
    const skillPath = join(repoRoot, "browser/skills/browser/SKILL.md");
    const skillText = await readFile(skillPath, "utf8");
    expect(skillText).toMatch(/^---\nname: browser\ndescription: [^\n]+\n---\n/);
    expect(skillText.trimEnd().split("\n").length).toBeLessThanOrEqual(120);
    expect(manifest.pi.extensions).toEqual(expect.arrayContaining(["./orche/src/extension/index.ts", "./browser/src/extension/index.ts"]));
    for (const path of manifest.pi.extensions) await access(join(repoRoot, path));
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: join(root, "agent"), settingsManager: SettingsManager.inMemory({ packages: [] }),
      additionalExtensionPaths: [repoRoot], noSkills: false, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    // getExtensions() exposes both loaded paths and registration maps; no session or child starts here.
    const loaded = loader.getExtensions();
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions.map((extension) => extension.resolvedPath)).toEqual(expect.arrayContaining([
      join(repoRoot, "orche/src/extension/index.ts"), join(repoRoot, "browser/src/extension/index.ts"),
    ]));
    const tools = loaded.extensions.flatMap((extension) => [...extension.tools.keys()]);
    expect(tools).toEqual(expect.arrayContaining(["orche_run", "browser_navigate", "browser_snapshot", "browser_evaluate"]));
    // Exercise manifest-based skill discovery, not a separately injected skill path.
    const skillResources = loader.getSkills();
    const browserSkill = skillResources.skills.find((skill) => skill.name === "browser");
    expect(browserSkill).toMatchObject({
      name: "browser", filePath: skillPath, baseDir: join(repoRoot, "browser/skills/browser"), disableModelInvocation: false,
    });
    expect(browserSkill?.description).toBe(skillText.match(/^description: (.+)$/m)?.[1]);
    expect(skillResources.diagnostics.filter((diagnostic) => diagnostic.path === skillPath)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);
