import type { AppRuntime } from "../../core/types/module";
import type { ToolbarMenuDefinition } from "../../core/types/ui";

interface TopToolbarProps {
  runtime: AppRuntime;
  menus: ToolbarMenuDefinition[];
  openModal: (modalId: string) => void;
}

export function TopToolbar({ runtime, menus, openModal }: TopToolbarProps): JSX.Element {
  return (
    <header className="top-toolbar">
      <div>
        <strong>{runtime.env.appName}</strong>
      </div>
      <nav className="toolbar-menus">
        {menus.map((menu) => (
          <details key={menu.id} className="toolbar-menu">
            <summary>{menu.label}</summary>
            <div className="toolbar-dropdown">
              {menu.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    void item.onSelect({ runtime, openModal });
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </details>
        ))}
      </nav>
    </header>
  );
}

