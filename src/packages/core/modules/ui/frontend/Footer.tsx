import type { AppRuntime } from "../../../../../core/types/module";
import type { FooterItemDefinition } from "../../../../../core/types/ui";

interface FooterProps {
  runtime: AppRuntime;
  items: FooterItemDefinition[];
  consoleCollapsed: boolean;
  onToggleConsoleCollapse: () => void;
}

function orderFooterItems(items: FooterItemDefinition[]): FooterItemDefinition[] {
  const ordered = [...items];
  for (const item of [...ordered]) {
    if (!item.beforeId) continue;
    const fromIndex = ordered.findIndex((entry) => entry.id === item.id);
    const targetIndex = ordered.findIndex((entry) => entry.id === item.beforeId);
    if (fromIndex < 0 || targetIndex < 0 || fromIndex < targetIndex) continue;
    const [moved] = ordered.splice(fromIndex, 1);
    const nextTargetIndex = ordered.findIndex((entry) => entry.id === item.beforeId);
    if (nextTargetIndex < 0) {
      ordered.push(moved);
      continue;
    }
    ordered.splice(nextTargetIndex, 0, moved);
  }
  return ordered;
}

export function Footer({ runtime, items, consoleCollapsed, onToggleConsoleCollapse }: FooterProps): JSX.Element {
  const orderedItems = orderFooterItems(items);
  const firstRightItemIndex = orderedItems.findIndex((item) => item.align === "right");
  const hasRightAlignedItems = firstRightItemIndex >= 0;

  return (
    <footer className="shell-footer">
      {orderedItems.map((item, index) => (
        <div
          key={item.id}
          className={`footer-item${item.align === "right" ? " footer-item-right" : ""}${
            index === firstRightItemIndex ? " footer-item-right-anchor" : ""
          }`}
        >
          {item.render(runtime)}
        </div>
      ))}
      <button
        type="button"
        className={`footer-console-toggle${hasRightAlignedItems ? "" : " footer-console-toggle--auto"}`}
        onClick={onToggleConsoleCollapse}
        title={consoleCollapsed ? "Expandir consola" : "Colapsar consola"}
        aria-label={consoleCollapsed ? "Expandir consola" : "Colapsar consola"}
      >
        {consoleCollapsed ? "▲" : "▼"}
      </button>
    </footer>
  );
}
