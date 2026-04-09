import type { ModalContribution } from "../../core/contributions/types";

interface ModalHostProps {
  dialogs: ModalContribution[];
  modalId: string | null;
  closeModal: () => void;
}

export function ModalHost({ dialogs, modalId, closeModal }: ModalHostProps): JSX.Element | null {
  if (!modalId) return null;
  const dialog = dialogs.find((entry) => entry.id === modalId);
  if (!dialog) return null;
  const headerContent = dialog.renderHeader ? dialog.renderHeader({ close: closeModal }) : null;
  const footerContent = dialog.renderFooter ? dialog.renderFooter({ close: closeModal }) : null;
  const dialogClassName = `modal-card modal-card-${dialog.id.replace(/\./g, "-")}`;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onClick={closeModal}>
      <div className={dialogClassName} onClick={(event) => event.stopPropagation()}>
        {headerContent ? (
          <div className="modal-header-shell">
            <div className="modal-header">{headerContent}</div>
            <button type="button" className="modal-close-btn" onClick={closeModal} aria-label="Cerrar">
              ⛌
            </button>
          </div>
        ) : (
          <div className="modal-header-shell">
            <div className="modal-header modal-header-default">
              <strong className="modal-title">{dialog.title}</strong>
            </div>
            <button type="button" className="modal-close-btn" onClick={closeModal} aria-label="Cerrar">
              ⛌
            </button>
          </div>
        )}
        <div className="modal-body">{dialog.render({ close: closeModal })}</div>
        {footerContent ? <div className="modal-footer">{footerContent}</div> : null}
      </div>
    </div>
  );
}
