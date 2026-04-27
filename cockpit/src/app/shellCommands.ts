import type { AppRuntime } from "../core/types/module";
import type { Disposable } from "../core/commands/types";

export const ShellCommands = {
  toggleSidebar: "cockpit.shell.toggleSidebar",
  toggleConsole: "cockpit.shell.toggleConsole",
  openModal: "cockpit.shell.openModal",
  closeModal: "cockpit.shell.closeModal",
  dismiss: "cockpit.shell.dismiss",
  zoomIn: "cockpit.shell.zoomIn",
  zoomOut: "cockpit.shell.zoomOut",
  zoomReset: "cockpit.shell.zoomReset"
} as const;

export interface ShellCommandCallbacks {
  toggleSidebar: () => void;
  toggleConsole: () => void;
  openModal: (modalId: string) => void;
  closeModal: () => void;
  getActiveModalId: () => string | null;
  zoomIn: () => void | Promise<void>;
  zoomOut: () => void | Promise<void>;
  zoomReset: () => void | Promise<void>;
}

export function registerShellCommands(
  runtime: AppRuntime,
  callbacks: ShellCommandCallbacks
): Disposable[] {
  const disposables: Disposable[] = [];

  disposables.push(
    runtime.commands.register(
      { id: ShellCommands.toggleSidebar, title: "Toggle Sidebar", category: "Shell" },
      () => callbacks.toggleSidebar()
    )
  );

  disposables.push(
    runtime.commands.register(
      { id: ShellCommands.toggleConsole, title: "Toggle Console", category: "Shell" },
      () => callbacks.toggleConsole()
    )
  );

  disposables.push(
    runtime.commands.register(
      { id: ShellCommands.openModal, title: "Open Modal", category: "Shell" },
      (modalId: unknown) => {
        if (typeof modalId === "string") callbacks.openModal(modalId);
      }
    )
  );

  disposables.push(
    runtime.commands.register(
      { id: ShellCommands.closeModal, title: "Close Modal", category: "Shell" },
      () => callbacks.closeModal()
    )
  );

  disposables.push(
    runtime.commands.register(
      { id: ShellCommands.dismiss, title: "Dismiss", category: "Shell" },
      () => {
        if (callbacks.getActiveModalId()) {
          callbacks.closeModal();
        }
      }
    )
  );

  disposables.push(
    runtime.commands.register(
      { id: ShellCommands.zoomIn, title: "Zoom In", category: "Shell" },
      () => callbacks.zoomIn()
    )
  );

  disposables.push(
    runtime.commands.register(
      { id: ShellCommands.zoomOut, title: "Zoom Out", category: "Shell" },
      () => callbacks.zoomOut()
    )
  );

  disposables.push(
    runtime.commands.register(
      { id: ShellCommands.zoomReset, title: "Zoom Reset", category: "Shell" },
      () => callbacks.zoomReset()
    )
  );

  disposables.push(
    runtime.keybindings.register({
      key: "ctrl+b",
      commandId: ShellCommands.toggleSidebar,
      source: "default"
    })
  );

  disposables.push(
    runtime.keybindings.register({
      key: "ctrl+j",
      commandId: ShellCommands.toggleConsole,
      source: "default"
    })
  );

  disposables.push(
    runtime.keybindings.register({
      key: "escape",
      commandId: ShellCommands.dismiss,
      source: "default",
      when: "modalOpen"
    })
  );

  disposables.push(
    runtime.keybindings.register({
      key: "ctrl+=",
      commandId: ShellCommands.zoomIn,
      source: "default"
    })
  );

  disposables.push(
    runtime.keybindings.register({
      key: "ctrl+shift+=",
      commandId: ShellCommands.zoomIn,
      source: "default"
    })
  );

  disposables.push(
    runtime.keybindings.register({
      key: "ctrl+numpadadd",
      commandId: ShellCommands.zoomIn,
      source: "default"
    })
  );

  disposables.push(
    runtime.keybindings.register({
      key: "ctrl+-",
      commandId: ShellCommands.zoomOut,
      source: "default"
    })
  );

  disposables.push(
    runtime.keybindings.register({
      key: "ctrl+numpadsubtract",
      commandId: ShellCommands.zoomOut,
      source: "default"
    })
  );

  disposables.push(
    runtime.keybindings.register({
      key: "ctrl+0",
      commandId: ShellCommands.zoomReset,
      source: "default"
    })
  );

  return disposables;
}
