export function wrapExpression(expression: string): string {
  return `(() => { try { const __v = (${expression}); let __json; try { __json = JSON.stringify({ ok: true, value: __v === undefined ? null : __v }); if (!("value" in JSON.parse(__json))) throw new Error("Non-serializable value"); } catch (_) { __json = JSON.stringify({ ok: true, value: String(__v) }); } return __json; } catch (e) { return JSON.stringify({ ok: false, error: String((e && e.stack) || e) }); } })()`;
}

export function decodeEvaluation(raw: string): string {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { /* Engine syntax failures return null, not an MCP error. */ }
  if (!value || typeof value !== "object" || !("ok" in value) || typeof value.ok !== "boolean") {
    throw new Error("The expression could not be evaluated (syntax error or engine returned null). Use a single expression or an IIFE, for example (() => { return document.title; })().");
  }
  if (!value.ok) throw new Error("error" in value ? String(value.error) : "Browser evaluation failed");
  return JSON.stringify(value, null, 2);
}
