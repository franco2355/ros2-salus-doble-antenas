import { hostRequest } from "./bridge";

export async function notify(title: string, body: string): Promise<void> {
  const hostResult = await hostRequest<unknown>("host.notify", { title, body });
  if (hostResult !== undefined) return;

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
