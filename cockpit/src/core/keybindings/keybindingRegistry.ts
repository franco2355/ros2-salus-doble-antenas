import type { KeybindingContext, KeybindingDescriptor, KeybindingRegistry } from "./types";
import { evaluateWhenClause } from "./whenClause";

export function createKeybindingRegistry(): KeybindingRegistry {
  const bindings: KeybindingDescriptor[] = [];

  return {
    register(binding) {
      bindings.push(binding);
      return {
        dispose() {
          const index = bindings.indexOf(binding);
          if (index !== -1) bindings.splice(index, 1);
        }
      };
    },

    getBindingsForCommand(commandId) {
      return bindings.filter((b) => b.commandId === commandId);
    },

    getBindingForKey(key, context) {
      const matches = bindings.filter(
        (b) => b.key === key && evaluateWhenClause(b.when, context)
      );
      if (matches.length === 0) return undefined;
      if (matches.length === 1) return matches[0];
      return matches.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0];
    },

    list() {
      return [...bindings];
    }
  };
}
