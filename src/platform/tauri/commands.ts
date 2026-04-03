export async function invokeCommand<TResult = unknown>(
  command: string,
  payload?: Record<string, unknown>
): Promise<TResult | undefined> {
  try {
    const api = await import("@tauri-apps/api/core");
    return await api.invoke<TResult>(command, payload);
  } catch {
    return undefined;
  }
}

