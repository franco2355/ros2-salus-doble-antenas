import type { AppRuntime } from "../../../../../core/types/module";
import type { SidebarPanelDefinition } from "../../../../../core/types/ui";

interface PanelProps {
  runtime: AppRuntime;
  panels: SidebarPanelDefinition[];
  activePanelId: string;
  onSelectPanel: (id: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  width: number;
  onResizeStart: (e: React.MouseEvent<HTMLDivElement>) => void;
}

function panelIcon(panel: SidebarPanelDefinition): string {
  if (panel.icon) return panel.icon;
  const id = panel.id;
  if (id.includes("connection")) return "🔌";
  if (id.includes("navigation")) return "🧭";
  if (id.includes("manual")) return "🎮";
  if (id.includes("camera")) return "📷";
  if (id.includes("telemetry")) return "📡";
  if (id.includes("zone")) return "🗺️";
  if (id.includes("map")) return "🗺️";
  return "🧩";
}

function panelTooltip(label: string): string {
  const normalized = label.trim();
  const labels: Record<string, string> = {
    Connection: "Conexión",
    Navigation: "Navegación",
    Telemetry: "Telemetría",
    Debug: "Depuración",
    Settings: "Configuración",
    Map: "Mapa",
    Zones: "Zonas",
    "Zone List": "Lista de zonas",
    "Speed limits": "Límites de velocidad",
    "Camera PTZ": "Cámara PTZ"
  };
  return labels[normalized] ?? normalized;
}

export function Panel({
  runtime,
  panels,
  activePanelId,
  onSelectPanel,
  collapsed,
  onToggleCollapse,
  width,
  onResizeStart
}: PanelProps): JSX.Element {
  const activePanel = panels.find((p) => p.id === activePanelId) ?? null;

  return (
    <>
      <div className="sidebar-selector">
        {panels.map((panel) => (
          <button
            key={panel.id}
            type="button"
            className={panel.id === activePanelId ? "active" : ""}
            onClick={() => onSelectPanel(panel.id)}
            title={panelTooltip(panel.label)}
            aria-label={panelTooltip(panel.label)}
          >
            <span aria-hidden="true">{panelIcon(panel)}</span>
          </button>
        ))}
        <button
          type="button"
          className="collapse-toggle"
          onClick={onToggleCollapse}
          title={collapsed ? "Expandir panel lateral" : "Colapsar panel lateral"}
          aria-label={collapsed ? "Expandir panel lateral" : "Colapsar panel lateral"}
        >
          {collapsed ? "▶" : "◀"}
        </button>
      </div>
      {!collapsed ? (
        <aside className="sidebar-panel" style={{ width }}>
          {activePanel ? activePanel.render(runtime) : "No sidebar panel registered."}
        </aside>
      ) : null}
      {!collapsed ? (
        <div
          className="splitter-vertical"
          onMouseDown={onResizeStart}
          role="separator"
          aria-orientation="vertical"
        />
      ) : null}
    </>
  );
}
