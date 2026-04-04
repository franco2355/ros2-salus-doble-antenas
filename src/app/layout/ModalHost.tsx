import type { AppRuntime } from "../../core/types/module";
import type { ModalDialogDefinition } from "../../core/types/ui";

interface ModalHostProps {
  runtime: AppRuntime;
  dialogs: ModalDialogDefinition[];
  modalId: string | null;
  closeModal: () => void;
}

export function ModalHost({ runtime, dialogs, modalId, closeModal }: ModalHostProps): JSX.Element | null {
  if (!modalId) return null;
  const dialog = dialogs.find((entry) => entry.id === modalId);
  if (!dialog) return null;
  const headerContent = dialog.renderHeader ? dialog.renderHeader({ runtime, close: closeModal }) : null;
  const footerContent = dialog.renderFooter ? dialog.renderFooter({ runtime, close: closeModal }) : null;
  const dialogClassName = `modal-card modal-card-${dialog.id.replace(/\./g, "-")}`;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onClick={closeModal}>
      <div className={dialogClassName} onClick={(event) => event.stopPropagation()}>
        {headerContent ? (
          <div className="modal-header">{headerContent}</div>
        ) : (
          <div className="modal-header">
            <strong>{dialog.title}</strong>
            <button type="button" onClick={closeModal}>
              X
            </button>
          </div>
        )}
        <div className="modal-body">{dialog.render({ runtime, close: closeModal })}</div>
        {footerContent ? <div className="modal-footer">{footerContent}</div> : null}
      </div>
    </div>
  );
}
