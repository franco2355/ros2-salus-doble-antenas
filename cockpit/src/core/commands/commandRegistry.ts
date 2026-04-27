import type { CommandDescriptor, CommandHandler, CommandRegistry } from "./types";

export function createCommandRegistry(): CommandRegistry {
  const commands = new Map<string, { descriptor: CommandDescriptor; handler: CommandHandler }>();
  const listeners = new Set<() => void>();

  const notify = (): void => {
    listeners.forEach((fn) => fn());
  };

  return {
    register(descriptor, handler) {
      if (commands.has(descriptor.id)) {
        throw new Error(`Command already registered: '${descriptor.id}'`);
      }
      commands.set(descriptor.id, { descriptor, handler });
      notify();
      return {
        dispose() {
          commands.delete(descriptor.id);
          notify();
        }
      };
    },

    async execute(commandId, ...args) {
      const entry = commands.get(commandId);
      if (!entry) {
        throw new Error(`Command not found: '${commandId}'`);
      }
      await entry.handler(...args);
    },

    has: (id) => commands.has(id),

    getDescriptor: (id) => commands.get(id)?.descriptor,

    list: () => [...commands.values()].map((e) => e.descriptor),

    onChange(listener) {
      listeners.add(listener);
      return {
        dispose() {
          listeners.delete(listener);
        }
      };
    }
  };
}
