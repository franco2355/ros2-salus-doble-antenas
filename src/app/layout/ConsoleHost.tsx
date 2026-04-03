import type { AppRuntime } from "../../core/types/module";
import type { ConsoleTabDefinition } from "../../core/types/ui";

interface ConsoleHostProps {
  runtime: AppRuntime;
  tabs: ConsoleTabDefinition[];
  activeTabId: string;
  onSelectTab: (tabId: string) => void;
  collapsed: boolean;
  height: number;
  onToggleCollapse: () => void;
}

export function ConsoleHost({
  runtime,
  tabs,
  activeTabId,
  onSelectTab,
  collapsed,
  height,
  onToggleCollapse
}: ConsoleHostProps): JSX.Element {
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

  return (
    <section className={`console-host ${collapsed ? "collapsed" : ""}`} style={{ height }}>
      <div className="console-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={tab.id === activeTabId ? "active" : ""}
            onClick={() => onSelectTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
        <button type="button" className="console-collapse-btn" onClick={onToggleCollapse}>
          {collapsed ? "▲" : "▼"}
        </button>
      </div>
      <div className="console-tab-content">
        {activeTab ? activeTab.render(runtime) : "No console tabs registered."}
      </div>
    </section>
  );
}
