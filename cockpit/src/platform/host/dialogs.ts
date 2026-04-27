import { hostRequest } from "./bridge";

export interface HostDialogOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  defaultValue?: string;
  placeholder?: string;
}

export async function showHostAlert(options: HostDialogOptions): Promise<boolean> {
  const result = await hostRequest<unknown>("host.dialog.alert", {
    title: options.title,
    message: options.message,
    confirmLabel: options.confirmLabel,
    danger: options.danger
  });
  return result !== undefined;
}

export async function showHostConfirm(options: HostDialogOptions): Promise<boolean | undefined> {
  const result = await hostRequest<unknown>("host.dialog.confirm", {
    title: options.title,
    message: options.message,
    confirmLabel: options.confirmLabel,
    cancelLabel: options.cancelLabel,
    danger: options.danger
  });
  if (typeof result === "boolean") return result;
  return undefined;
}

export async function showHostPrompt(options: HostDialogOptions): Promise<string | null | undefined> {
  const result = await hostRequest<unknown>("host.dialog.prompt", {
    title: options.title,
    message: options.message,
    confirmLabel: options.confirmLabel,
    cancelLabel: options.cancelLabel,
    defaultValue: options.defaultValue,
    placeholder: options.placeholder
  });
  if (typeof result === "string" || result === null) return result;
  return undefined;
}
