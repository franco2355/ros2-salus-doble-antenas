import type { Disposable } from "../commands/types";

export interface KeybindingDescriptor {
  readonly commandId: string;
  readonly key: string;
  readonly when?: string;
  readonly args?: unknown[];
  readonly source: "default" | "user";
  readonly weight?: number;
}

export interface KeybindingContext {
  modalOpen: boolean;
  editing: boolean;
  manualMode?: boolean;
  connected?: boolean;
}

export interface KeybindingRegistry {
  register(binding: KeybindingDescriptor): Disposable;
  getBindingsForCommand(commandId: string): KeybindingDescriptor[];
  getBindingForKey(key: string, context: KeybindingContext): KeybindingDescriptor | undefined;
  list(): KeybindingDescriptor[];
}
