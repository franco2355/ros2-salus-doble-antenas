import type { ToolbarItemContribution } from "../../../../../core/contributions/types";

interface ToolbarMenuItemProps {
  item: ToolbarItemContribution;
  onExecute: (commandId: string) => void;
  onClose: () => void;
}

export function ToolbarMenuItem({ item, onExecute, onClose }: ToolbarMenuItemProps): JSX.Element {
  return (
    <button
      type="button"
      className="dd-item"
      onClick={() => {
        onClose();
        onExecute(item.commandId);
      }}
    >
      <span className="dd-item-ico" aria-hidden="true">•</span>
      {item.label}
    </button>
  );
}
