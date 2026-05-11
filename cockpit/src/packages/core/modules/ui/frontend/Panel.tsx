import type { SidebarContribution } from "../../../../../core/contributions/types";

interface PanelProps {
  panels: SidebarContribution[];
  activePanelId: string;
  onSelectPanel: (id: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  width: number;
  onResizeStart: (e: React.MouseEvent<HTMLDivElement>) => void;
}

function panelCode(panel: SidebarContribution): string {
  const id = panel.id;
  if (id.includes("connection")) return "CNX";
  if (id.includes("navigation")) return "NAV";
  if (id.includes("manual")) return "MAN";
  if (id.includes("camera")) return "CAM";
  if (id.includes("telemetry")) return "TLM";
  if (id.includes("zone")) return "ZON";
  if (id.includes("map")) return "MAP";
  if (id.includes("debug")) return "DBG";
  const label = panel.label.trim().replace(/\s+/gu, " ").toUpperCase();
  return label.slice(0, Math.min(3, label.length || 3));
}

function panelGlyph(panel: SidebarContribution): JSX.Element {
  const id = panel.id;

  if (id.includes("connection")) {
    return (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12.55a11 11 0 0 1 14.08 0" />
        <path d="M1.42 9a16 16 0 0 1 21.16 0" />
        <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
        <circle cx="12" cy="20" r="1" fill="currentColor" stroke="none" />
      </svg>
    );
  }

  if (id.includes("navigation")) {
    return (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="3 11 22 2 13 21 11 13 3 11" />
      </svg>
    );
  }

  if (id.includes("telemetry")) {
    return (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20V10" />
        <path d="M18 20V4" />
        <path d="M6 20v-6" />
      </svg>
    );
  }

  if (id.includes("debug")) {
    return (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="7" width="11" height="10" rx="2" />
        <path d="m15 11 5-3v8l-5-3" />
        <circle cx="7.5" cy="10.5" r="1" fill="currentColor" stroke="none" />
      </svg>
    );
  }

  if (id.includes("map") || id.includes("zone")) {
    return (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2V6z" />
        <path d="M9 4v14" />
        <path d="M15 6v14" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33" />
      <path d="M4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6" />
      <path d="M21 12h-2" />
      <path d="M5 12H3" />
    </svg>
  );
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
      <div className="sidebar-selector sel">
        {panels.map((panel) => (
          <button
            key={panel.id}
            type="button"
            className={`sel-btn ${panel.id === activePanelId ? "active" : ""}`}
            onClick={() => onSelectPanel(panel.id)}
            title={panelTooltip(panel.label)}
            aria-label={panelTooltip(panel.label)}
          >
            <span className="sidebar-button-glyph" aria-hidden="true">{panelGlyph(panel)}</span>
          </button>
        ))}
        <div className="sel-spacer" aria-hidden="true" />
        <button
          type="button"
          className="collapse-toggle sel-btn"
          onClick={onToggleCollapse}
          title={collapsed ? "Expandir panel lateral" : "Colapsar panel lateral"}
          aria-label={collapsed ? "Expandir panel lateral" : "Colapsar panel lateral"}
        >
          <span className="sidebar-button-glyph sidebar-button-glyph-collapse" aria-hidden="true">{collapsed ? "›" : "‹"}</span>
        </button>
      </div>
      {!collapsed ? (
        <aside className="sidebar-panel sidebar" style={{ width }}>
          {activePanel ? (
            <div className="sidebar-panel-shell">
              <div className="sidebar-panel-header sidebar-hdr">
                <div className="sidebar-panel-heading-row">
                  <span className="sidebar-panel-kicker sidebar-title">{activePanel.label}</span>
                  <span className="sidebar-panel-heading-badge" aria-hidden="true">{panelCode(activePanel)}</span>
                </div>
              </div>
              <div className="sidebar-panel-body sidebar-scroll">{activePanel.render()}</div>
            </div>
          ) : "No sidebar panel registered."}
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
