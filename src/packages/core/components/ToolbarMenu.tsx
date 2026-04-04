import { useEffect, useRef, useState } from "react";
import type { AppRuntime } from "../../../core/types/module";
import type { ToolbarMenuDefinition } from "../../../core/types/ui";
import { ToolbarMenuItem } from "./ToolbarMenuItem";
import logo from "../../../../logo.png";

interface ToolbarMenuProps {
  runtime: AppRuntime;
  menus: ToolbarMenuDefinition[];
  openModal: (modalId: string) => void;
}

export function ToolbarMenu({ runtime, menus, openModal }: ToolbarMenuProps): JSX.Element {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current) return;
      if (event.target instanceof Node && rootRef.current.contains(event.target)) return;
      setOpenMenuId(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || !openMenuId) return;
      setOpenMenuId(null);
      event.preventDefault();
      event.stopPropagation();
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [openMenuId]);

  return (
    <header ref={rootRef} className="top-toolbar">
      <div className="toolbar-left">
        <img src={logo} alt={runtime.env.appName} className="app-logo" />
        <nav className="toolbar-menus">
          {menus.map((menu) => (
            <div key={menu.id} className={`toolbar-menu ${openMenuId === menu.id ? "open" : ""}`}>
              <button
                type="button"
                className="toolbar-menu-trigger"
                onClick={async () => {
                  if (menu.onSelect) {
                    setOpenMenuId(null);
                    await menu.onSelect({ runtime, openModal });
                    return;
                  }
                  setOpenMenuId((current) => (current === menu.id ? null : menu.id));
                }}
              >
                {menu.label}
              </button>
              {openMenuId === menu.id && (menu.items?.length ?? 0) > 0 ? (
                <div className="toolbar-dropdown">
                  {(menu.items ?? []).map((item) => (
                    <ToolbarMenuItem
                      key={item.id}
                      item={item}
                      runtime={runtime}
                      openModal={openModal}
                      onClose={() => setOpenMenuId(null)}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </nav>
      </div>
    </header>
  );
}
