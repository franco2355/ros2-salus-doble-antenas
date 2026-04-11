import { describe, expect, it, vi, beforeEach } from "vitest";

const hostDialogMocks = vi.hoisted(() => ({
  showHostAlert: vi.fn(),
  showHostConfirm: vi.fn(),
  showHostPrompt: vi.fn()
}));

vi.mock("../platform/host/dialogs", () => hostDialogMocks);

import { DialogService } from "../packages/core/modules/runtime/service/impl/DialogService";

describe("dialog service", () => {
  beforeEach(() => {
    hostDialogMocks.showHostAlert.mockReset();
    hostDialogMocks.showHostConfirm.mockReset();
    hostDialogMocks.showHostPrompt.mockReset();
    hostDialogMocks.showHostAlert.mockResolvedValue(false);
    hostDialogMocks.showHostConfirm.mockResolvedValue(undefined);
    hostDialogMocks.showHostPrompt.mockResolvedValue(undefined);
  });

  it("uses host alert when available", async () => {
    hostDialogMocks.showHostAlert.mockResolvedValue(true);
    const service = new DialogService();

    await service.alert({ message: "hello" });

    expect(hostDialogMocks.showHostAlert).toHaveBeenCalledTimes(1);
    expect(service.getActiveDialog()).toBeNull();
  });

  it("falls back to queued alert when host is unavailable", async () => {
    hostDialogMocks.showHostAlert.mockResolvedValue(false);
    const service = new DialogService();

    const promise = service.alert({ message: "hello" });
    await Promise.resolve();
    expect(service.getActiveDialog()?.kind).toBe("alert");
    service.accept();
    await promise;
  });

  it("uses host confirm result", async () => {
    hostDialogMocks.showHostConfirm.mockResolvedValue(true);
    const service = new DialogService();

    const accepted = await service.confirm({ message: "continue?" });

    expect(accepted).toBe(true);
    expect(service.getActiveDialog()).toBeNull();
  });

  it("falls back to queued prompt when host is unavailable", async () => {
    hostDialogMocks.showHostPrompt.mockResolvedValue(undefined);
    const service = new DialogService();

    const promise = service.prompt({ message: "name" });
    await Promise.resolve();
    expect(service.getActiveDialog()?.kind).toBe("prompt");
    service.accept("Neo");

    await expect(promise).resolves.toBe("Neo");
  });
});
