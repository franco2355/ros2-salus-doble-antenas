import { useEffect, useRef, useState } from "react";
import type { AppRuntime } from "../../core/types/module";
import { DIALOG_SERVICE_ID, type ActiveGlobalDialog, type DialogService } from "../../packages/core/services/impl/DialogService";

interface GlobalDialogHostProps {
  runtime: AppRuntime;
}

export function GlobalDialogHost({ runtime }: GlobalDialogHostProps): JSX.Element | null {
  let dialogService: DialogService | null = null;
  try {
    dialogService = runtime.registries.serviceRegistry.getService<DialogService>(DIALOG_SERVICE_ID);
  } catch {
    dialogService = null;
  }
  if (!dialogService) return null;

  const [activeDialog, setActiveDialog] = useState<ActiveGlobalDialog | null>(dialogService.getActiveDialog());
  const [promptValue, setPromptValue] = useState("");
  const promptInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => dialogService.subscribe((dialog) => setActiveDialog(dialog)), [dialogService]);

  useEffect(() => {
    setPromptValue(activeDialog?.defaultValue ?? "");
  }, [activeDialog]);

  useEffect(() => {
    if (activeDialog?.kind !== "prompt") return;
    promptInputRef.current?.focus();
    promptInputRef.current?.select();
  }, [activeDialog]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!activeDialog) return;
      if (event.key !== "Escape") return;
      dialogService.dismiss();
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeDialog, dialogService]);

  if (!activeDialog) return null;

  const confirm = (): void => {
    if (activeDialog.kind === "prompt") {
      dialogService.accept(promptValue);
      return;
    }
    dialogService.accept();
  };

  return (
    <div className="global-dialog-overlay" role="dialog" aria-modal="true" onClick={() => dialogService.dismiss()}>
      <div className="global-dialog-card" onClick={(event) => event.stopPropagation()}>
        <header className="global-dialog-header">
          <strong>{activeDialog.title}</strong>
        </header>
        <div className="global-dialog-body">
          <p className="global-dialog-message">{activeDialog.message}</p>
          {activeDialog.kind === "prompt" ? (
            <input
              ref={promptInputRef}
              className="global-dialog-input"
              type="text"
              value={promptValue}
              onChange={(event) => setPromptValue(event.target.value)}
              placeholder={activeDialog.placeholder}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  confirm();
                  event.preventDefault();
                }
              }}
            />
          ) : null}
        </div>
        <footer className="global-dialog-actions">
          {activeDialog.kind !== "alert" ? (
            <button type="button" onClick={() => dialogService.dismiss()}>
              {activeDialog.cancelLabel}
            </button>
          ) : null}
          <button type="button" className={activeDialog.danger ? "danger-btn" : ""} onClick={confirm}>
            {activeDialog.confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
