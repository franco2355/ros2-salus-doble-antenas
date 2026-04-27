export interface Disposable {
  dispose(): void;
}

export interface CommandDescriptor {
  readonly id: string;
  readonly title: string;
  readonly category?: string;
  readonly icon?: string;
  readonly enabledWhen?: () => boolean;
}

export type CommandHandler = (...args: unknown[]) => void | Promise<void>;

export interface CommandRegistry {
  register(descriptor: CommandDescriptor, handler: CommandHandler): Disposable;
  execute(commandId: string, ...args: unknown[]): Promise<void>;
  has(commandId: string): boolean;
  getDescriptor(commandId: string): CommandDescriptor | undefined;
  list(): CommandDescriptor[];
  onChange(listener: () => void): Disposable;
}
