import { useEffect, useRef } from "react";
import type { AppRuntime } from "../../core/types/module";
import type { SidebarPanelDefinition } from "../../core/types/ui";

interface SidebarHostProps {
  runtime: AppRuntime;
  panel: SidebarPanelDefinition | null;
}

export function SidebarHost({ runtime, panel }: SidebarHostProps): JSX.Element {
  const hostRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!panel || !hostRef.current) return;
    const cleanups: Array<() => void> = [];
    hostRef.current.querySelectorAll<HTMLElement>(".panel-card").forEach((card) => {
      const heading = card.querySelector<HTMLElement>("h3, h4");
      if (!heading) return;
      heading.classList.add("collapsible-heading");
      heading.tabIndex = 0;
      heading.setAttribute("role", "button");
      heading.setAttribute("aria-expanded", "true");
      const toggle = (): void => {
        const collapsed = card.classList.toggle("collapsed");
        heading.setAttribute("aria-expanded", collapsed ? "false" : "true");
      };
      const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toggle();
      };
      heading.addEventListener("click", toggle);
      heading.addEventListener("keydown", onKeyDown);
      cleanups.push(() => {
        heading.removeEventListener("click", toggle);
        heading.removeEventListener("keydown", onKeyDown);
      });
    });

    return () => {
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [panel]);

  if (!panel) {
    return <aside className="sidebar-panel">No sidebar panel registered.</aside>;
  }
  return (
    <aside ref={hostRef} className="sidebar-panel">
      {panel.render(runtime)}
    </aside>
  );
}
