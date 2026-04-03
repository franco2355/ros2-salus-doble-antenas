import { invokeCommand } from "./commands";

export interface OpenWindowInput {
  label: string;
  route: string;
  title: string;
  width?: number;
  height?: number;
}

export async function openWindow(input: OpenWindowInput): Promise<void> {
  const tauriResult = await invokeCommand("open_aux_window", {
    label: input.label,
    route: input.route,
    title: input.title,
    width: input.width ?? 900,
    height: input.height ?? 600
  });
  if (tauriResult !== undefined) return;

  if (typeof window !== "undefined") {
    window.open(input.route, input.label);
  }
}

