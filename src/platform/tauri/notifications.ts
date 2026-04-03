import { invokeCommand } from "./commands";

export async function notify(title: string, body: string): Promise<void> {
  const tauriResult = await invokeCommand("notify_system", { title, body });
  if (tauriResult !== undefined) return;

  if (typeof window !== "undefined" && "Notification" in window) {
    if (Notification.permission === "granted") {
      new Notification(title, { body });
      return;
    }
    if (Notification.permission !== "denied") {
      const permission = await Notification.requestPermission();
      if (permission === "granted") {
        new Notification(title, { body });
      }
    }
  }
}

