import { useEffect } from "react";
import type { AppRuntime } from "../../core/types/module";
import type { KeybindingContext } from "../../core/keybindings/types";
import { normalizeKeyCombo } from "../../core/keybindings/normalizeKey";

interface KeybindingHostProps {
  runtime: AppRuntime;
  context: KeybindingContext;
}

function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  // if (target.closest(".terminal-xterm-host")) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function KeybindingHost({ runtime, context }: KeybindingHostProps): null {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isEditingTarget(event.target)) return;

      const key = normalizeKeyCombo(event);
      const binding = runtime.keybindings.getBindingForKey(key, context);
      if (!binding) return;

      event.preventDefault();
      void runtime.commands.execute(binding.commandId, ...(binding.args ?? []));
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      if (isEditingTarget(event.target)) return;

      const key = normalizeKeyCombo(event) + ":up";
      const binding = runtime.keybindings.getBindingForKey(key, context);
      if (!binding) return;

      event.preventDefault();
      void runtime.commands.execute(binding.commandId, ...(binding.args ?? []));
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [runtime, context]);

  return null;
}
