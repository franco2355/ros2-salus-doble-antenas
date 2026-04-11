import { hostRequest } from "./bridge";

export interface HostTerminalOpenInput {
  name?: string;
  cwd?: string;
  shellPath?: string;
  shellArgs?: string[];
}

export async function openHostTerminal(input: HostTerminalOpenInput = {}): Promise<void> {
  await hostRequest("host.terminal.open", {
    name: input.name,
    cwd: input.cwd,
    shellPath: input.shellPath,
    shellArgs: input.shellArgs
  });
}

export async function sendHostTerminalText(text: string, addNewLine = true): Promise<void> {
  await hostRequest("host.terminal.sendText", {
    text,
    addNewLine
  });
}

export async function revealHostTerminal(preserveFocus = false): Promise<void> {
  await hostRequest("host.terminal.reveal", {
    preserveFocus
  });
}
