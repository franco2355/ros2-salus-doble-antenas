import { useEffect, useRef, useState } from "react";
import type { ToolbarContribution } from "../../../../../core/contributions/types";
import type { AppRuntime } from "../../../../../core/types/module";
import { ShellCommands } from "../../../../../app/shellCommands";
import logo from "../../../../../../icon2-backgroundless.png";
import { ToolbarMenuItem } from "./ToolbarMenuItem";

export interface ToolbarStatusItem {
  id: string;
  label: string;
  value: string;
  detail?: string;
  tone?: "ok" | "warn" | "bad" | "neutral";
}

interface ToolbarMenuProps {
  runtime: AppRuntime;
  menus: ToolbarContribution[];
  statusItems?: ToolbarStatusItem[];
}

export function ToolbarMenu({ runtime, menus, statusItems = [] }: ToolbarMenuProps): JSX.Element {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const connectionItem = statusItems.find((item) => item.id === "link") ?? null;
  const secondaryItems = statusItems.filter((item) => item.id !== "link");

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
    <header ref={rootRef} className="top-toolbar toolbar">
      <div className="toolbar-left">
        <div className="toolbar-brand">
          <img src={logo} alt={runtime.env.appName} className="app-logo toolbar-logo" />
          <div className="toolbar-brand-copy toolbar-brand-text">
            <strong className="toolbar-brand-name">{runtime.env.appName}</strong>
            <span className="toolbar-brand-sub">robotics control surface</span>
          </div>
        </div>
        <nav className="toolbar-menus">
          {menus.map((menu) => (
            <div key={menu.id} className={`toolbar-menu dd-wrap ${openMenuId === menu.id ? "open" : ""}`}>
              <button
                type="button"
                className="toolbar-menu-trigger toolbar-btn"
                onClick={() => {
                  if (menu.commandId) {
                    setOpenMenuId(null);
                    void runtime.commands.execute(menu.commandId);
                    return;
                  }
                  setOpenMenuId((current) => (current === menu.id ? null : menu.id));
                }}
              >
                {menu.label}
              </button>
              {openMenuId === menu.id && (menu.items?.length ?? 0) > 0 ? (
                <div className="toolbar-dropdown dd-menu">
                  {(menu.items ?? []).map((item) => (
                    <ToolbarMenuItem
                      key={item.id}
                      item={item}
                      onExecute={(commandId) => {
                        void runtime.commands.execute(commandId);
                      }}
                      onClose={() => setOpenMenuId(null)}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </nav>
      </div>
      <div className="toolbar-right" aria-label="Cockpit status">
        {connectionItem ? (
          <div
            className={`conn-badge ${connectionItem.tone ?? "neutral"}`}
            title={connectionItem.detail ?? connectionItem.label}
            aria-label={`${connectionItem.label}: ${connectionItem.value}`}
          >
            <span className={`conn-dot ${connectionItem.tone === "warn" ? "pulse" : ""}`} aria-hidden="true" />
            <span>{connectionItem.value}</span>
          </div>
        ) : null}
        {secondaryItems.map((item) => (
          <div
            key={item.id}
            className={`toolbar-mini-badge toolbar-mini-badge-${item.tone ?? "neutral"} toolbar-mini-badge-id-${item.id}`}
            title={item.detail ?? item.label}
            aria-label={`${item.label}: ${item.value}`}
          >
            <span className="toolbar-mini-label">{item.label}</span>
            <span className="toolbar-mini-value">{item.value}</span>
          </div>
        ))}
        <button
          type="button"
          className="toolbar-icon-btn"
          title="Zoom out"
          aria-label="Zoom out"
          onClick={() => {
            void runtime.commands.execute(ShellCommands.zoomOut);
          }}
        >
          －
        </button>
        <button
          type="button"
          className="toolbar-icon-btn"
          title="Zoom reset"
          aria-label="Zoom reset"
          onClick={() => {
            void runtime.commands.execute(ShellCommands.zoomReset);
          }}
        >
          ⊡
        </button>
        <button
          type="button"
          className="toolbar-icon-btn"
          title="Zoom in"
          aria-label="Zoom in"
          onClick={() => {
            void runtime.commands.execute(ShellCommands.zoomIn);
          }}
        >
          ＋
        </button>
      </div>
    </header>
  );
}
