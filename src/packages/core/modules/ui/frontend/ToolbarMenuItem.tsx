import type { AppRuntime } from "../../../../../core/types/module";
import type { ToolbarMenuItemDefinition } from "../../../../../core/types/ui";

interface ToolbarMenuItemProps {
  item: ToolbarMenuItemDefinition;
  runtime: AppRuntime;
  openModal: (modalId: string) => void;
  onClose: () => void;
}

export function ToolbarMenuItem({ item, runtime, openModal, onClose }: ToolbarMenuItemProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => {
        onClose();
        void item.onSelect({ runtime, openModal });
      }}
    >
      {item.label}
    </button>
  );
}
