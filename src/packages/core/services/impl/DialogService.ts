export type GlobalDialogKind = "alert" | "confirm" | "prompt";
export const DIALOG_SERVICE_ID = "service.dialog";

export interface GlobalDialogOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  defaultValue?: string;
  placeholder?: string;
}

export interface ActiveGlobalDialog {
  id: number;
  kind: GlobalDialogKind;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
  defaultValue: string;
  placeholder: string;
}

interface DialogQueueItem {
  active: ActiveGlobalDialog;
  resolve: (value: unknown) => void;
}

type DialogListener = (dialog: ActiveGlobalDialog | null) => void;

export class DialogService {
  private readonly listeners = new Set<DialogListener>();
  private readonly queue: DialogQueueItem[] = [];
  private current: DialogQueueItem | null = null;
  private sequence = 0;

  subscribe(listener: DialogListener): () => void {
    this.listeners.add(listener);
    listener(this.getActiveDialog());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getActiveDialog(): ActiveGlobalDialog | null {
    return this.current ? { ...this.current.active } : null;
  }

  alert(options: GlobalDialogOptions): Promise<void> {
    return this.enqueue("alert", options) as Promise<void>;
  }

  confirm(options: GlobalDialogOptions): Promise<boolean> {
    return this.enqueue("confirm", options) as Promise<boolean>;
  }

  prompt(options: GlobalDialogOptions): Promise<string | null> {
    return this.enqueue("prompt", options) as Promise<string | null>;
  }

  accept(value?: string): void {
    if (!this.current) return;
    const active = this.current;
    this.current = null;
    if (active.active.kind === "confirm") {
      active.resolve(true);
    } else if (active.active.kind === "prompt") {
      active.resolve(typeof value === "string" ? value : "");
    } else {
      active.resolve(undefined);
    }
    this.emit();
    this.pump();
  }

  dismiss(): void {
    if (!this.current) return;
    const active = this.current;
    this.current = null;
    if (active.active.kind === "confirm") {
      active.resolve(false);
    } else if (active.active.kind === "prompt") {
      active.resolve(null);
    } else {
      active.resolve(undefined);
    }
    this.emit();
    this.pump();
  }

  private enqueue(kind: GlobalDialogKind, options: GlobalDialogOptions): Promise<unknown> {
    return new Promise<unknown>((resolve) => {
      this.sequence += 1;
      const active: ActiveGlobalDialog = {
        id: this.sequence,
        kind,
        title: options.title?.trim() || (kind === "confirm" ? "Confirm" : kind === "prompt" ? "Input required" : "Notice"),
        message: options.message,
        confirmLabel: options.confirmLabel?.trim() || (kind === "alert" ? "OK" : "Confirm"),
        cancelLabel: options.cancelLabel?.trim() || "Cancel",
        danger: options.danger === true,
        defaultValue: options.defaultValue ?? "",
        placeholder: options.placeholder ?? ""
      };
      this.queue.push({ active, resolve });
      this.pump();
    });
  }

  private pump(): void {
    if (this.current || this.queue.length === 0) return;
    this.current = this.queue.shift() ?? null;
    this.emit();
  }

  private emit(): void {
    const snapshot = this.getActiveDialog();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}
