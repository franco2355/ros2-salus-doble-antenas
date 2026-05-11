import { useEffect, useState } from "react";
import type { ConsoleContribution } from "../../../../../core/contributions/types";

interface ConsolePanelProps {
  tabs: ConsoleContribution[];
  activeTabId: string;
  onSelectTab: (tabId: string) => void;
  collapsed: boolean;
  height: number;
}

function consoleTabIcon(id: string, label: string): JSX.Element {
  const normalized = `${id} ${label}`.toLowerCase();
  const baseProps = {
    viewBox: "0 0 24 24",
    width: 14,
    height: 14,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const
  };

  if (normalized.includes("telemetry")) {
    return (
      <svg {...baseProps}>
        <path d="M4 12h4l2-5 4 10 2-5h4" />
      </svg>
    );
  }

  if (normalized.includes("terminal")) {
    return (
      <svg {...baseProps}>
        <path d="m5 8 4 4-4 4" />
        <path d="M11 17h8" />
      </svg>
    );
  }

  return (
    <svg {...baseProps}>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </svg>
  );
}

export function ConsolePanel({ tabs, activeTabId, onSelectTab, collapsed, height }: ConsolePanelProps): JSX.Element {
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const [mountedTabIds, setMountedTabIds] = useState<Set<string>>(() => (
    activeTabId ? new Set([activeTabId]) : new Set()
  ));

  useEffect(() => {
    if (!activeTabId) return;
    setMountedTabIds((current) => {
      if (current.has(activeTabId)) return current;
      const next = new Set(current);
      next.add(activeTabId);
      return next;
    });
    window.dispatchEvent(new CustomEvent("cockpit:console-tab-active", { detail: { tabId: activeTabId } }));
  }, [activeTabId]);

  useEffect(() => {
    const validIds = new Set(tabs.map((tab) => tab.id));
    setMountedTabIds((current) => {
      const next = new Set(Array.from(current).filter((id) => validIds.has(id)));
      if (activeTabId) next.add(activeTabId);
      if (next.size === current.size && Array.from(next).every((id) => current.has(id))) return current;
      return next;
    });
  }, [activeTabId, tabs]);

  return (
    <section className={`console-host console ${collapsed ? "collapsed" : ""}`} style={{ height }}>
      <div className="console-tabs con-tabs" aria-label="Console tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`con-tab ${tab.id === activeTabId ? "active" : ""}`}
            onClick={() => onSelectTab(tab.id)}
          >
            <span className="con-tab-icon" aria-hidden="true">{consoleTabIcon(tab.id, tab.label)}</span>
            <span className="con-tab-label">{tab.label}</span>
          </button>
        ))}
        <div className="con-sp" aria-hidden="true" />
      </div>
      <div className="console-tab-content con-body">
        {activeTab ? (
          tabs
            .filter((tab) => mountedTabIds.has(tab.id))
            .map((tab) => (
              <div
                key={tab.id}
                className={`con-pane ${tab.id === activeTabId ? "con-pane--active" : ""}`}
                hidden={tab.id !== activeTabId}
              >
                {tab.render()}
              </div>
            ))
        ) : (
          "No console tabs registered."
        )}
      </div>
    </section>
  );
}
