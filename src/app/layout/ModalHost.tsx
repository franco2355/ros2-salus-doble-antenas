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

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onClick={closeModal}>
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <strong>{dialog.title}</strong>
          <button type="button" onClick={closeModal}>
            Close
          </button>
        </div>
        <div className="modal-body">{dialog.render({ runtime, close: closeModal })}</div>
        <div className="modal-footer">
          {dialog.renderFooter ? dialog.renderFooter({ runtime, close: closeModal }) : null}
          <button type="button" onClick={closeModal}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

