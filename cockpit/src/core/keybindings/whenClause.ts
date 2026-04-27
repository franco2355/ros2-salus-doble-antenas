import type { KeybindingContext } from "./types";

export function evaluateWhenClause(when: string | undefined, context: KeybindingContext): boolean {
  if (!when) return true;

  const tokens = when.split("&&").map((t) => t.trim());
  for (const token of tokens) {
    if (!evaluateToken(token, context)) return false;
  }
  return true;
}

function evaluateToken(token: string, context: KeybindingContext): boolean {
  const negated = token.startsWith("!");
  const key = negated ? token.slice(1).trim() : token.trim();
  const value = lookupContextKey(key, context);
  return negated ? !value : !!value;
}

function lookupContextKey(key: string, context: KeybindingContext): boolean {
  switch (key) {
    case "modalOpen":
      return context.modalOpen;
    case "editing":
      return context.editing;
    case "manualMode":
      return context.manualMode ?? false;
    case "connected":
      return context.connected ?? false;
    default:
      return false;
  }
}
