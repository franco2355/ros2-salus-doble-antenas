import type { AppRuntime } from "../../../../../core/types/module";
import type { ConsoleTabDefinition } from "../../../../../core/types/ui";

interface ConsolePanelProps {
  runtime: AppRuntime;
  tabs: ConsoleTabDefinition[];
  activeTabId: string;
  onSelectTab: (tabId: string) => void;
  collapsed: boolean;
  height: number;
}

export function ConsolePanel({
  runtime,
  tabs,
  activeTabId,
  onSelectTab,
  collapsed,
  height
}: ConsolePanelProps): JSX.Element {
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
      </div>
      <div className="console-tab-content">
        {activeTab ? activeTab.render(runtime) : "No console tabs registered."}
      </div>
    </section>
  );
}
