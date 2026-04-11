import { hostRequest } from "./bridge";

export async function isMainWindowFocused(): Promise<boolean> {
  const hostResult = await hostRequest<unknown>("host.focus.isFocused");
  if (typeof hostResult === "boolean") return hostResult;

  if (typeof document !== "undefined" && typeof document.hasFocus === "function") {
    return document.hasFocus();
  }
  return true;
}
