/** Argument completions for `/browser`: every candidate is a complete argument string the command handler accepts. */
export interface CommandCompletion { value: string; label: string; description?: string }

export const BROWSER_COMPLETIONS: readonly CommandCompletion[] = [
  { value: "status", label: "status", description: "Binary, engine and config status" },
  { value: "engine", label: "engine", description: "Show the active engine" },
  { value: "engine obscura", label: "engine obscura", description: "Switch to the obscura engine" },
  { value: "engine chrome", label: "engine chrome", description: "Switch to the Chrome engine" },
  { value: "stop", label: "stop", description: "Stop all engines (tabs lost)" },
  { value: "restart", label: "restart", description: "Restart the active engine" },
  { value: "install", label: "install", description: "Install the configured obscura version (optionally: install <version>)" },
  { value: "allow-private-network on", label: "allow-private-network on", description: "Allow private-network URLs (user config)" },
  { value: "allow-private-network off", label: "allow-private-network off", description: "Block private-network URLs (user config)" },
  { value: "profile save", label: "profile save", description: "Save cookies/storage to a profile (optionally: profile save <name>)" },
  { value: "profile load", label: "profile load", description: "Load a saved profile (optionally: profile load <name>)" },
  { value: "profile clear", label: "profile clear", description: "Delete a saved profile (optionally: profile clear <name>)" },
];

/**
 * Pi passes everything after `/browser ` and replaces it with the chosen value. Candidates that start with the typed text are offered;
 * a lone exact match is dropped so Enter submits the command instead of re-applying the same text.
 */
export function completeBrowserArguments(prefix: string): CommandCompletion[] | null {
  const typed = prefix.trimStart();
  const items = BROWSER_COMPLETIONS.filter(item => item.value.startsWith(typed));
  if (items.length === 0 || (items.length === 1 && items[0]!.value === typed)) return null;
  return items.map(item => ({ ...item }));
}
