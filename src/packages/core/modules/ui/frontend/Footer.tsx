import type { FooterContribution } from "../../../../../core/contributions/types";

interface FooterProps {
  items: FooterContribution[];
  consoleCollapsed: boolean;
  onToggleConsoleCollapse: () => void;
  showConsoleToggle?: boolean;
}

function orderFooterItems(items: FooterContribution[]): FooterContribution[] {
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

export function Footer({
  items,
  consoleCollapsed,
  onToggleConsoleCollapse,
  showConsoleToggle = true
}: FooterProps): JSX.Element {
  const orderedItems = orderFooterItems(items);
  const firstRightItemIndex = orderedItems.findIndex((item) => item.align === "right");
  const hasRightAlignedItems = firstRightItemIndex >= 0;

  return (
    <footer className="shell-footer">
      {orderedItems.map((item, index) => (
        <div
          key={item.id}
          className={`footer-item${item.id.includes("connection-status") ? " footer-item-connection-status" : ""}${
            item.align === "right" ? " footer-item-right" : ""
          }${
            index === firstRightItemIndex ? " footer-item-right-anchor" : ""
          }`}
        >
          {item.render()}
        </div>
      ))}
      {showConsoleToggle ? (
        <button
          type="button"
          className={`footer-console-toggle${hasRightAlignedItems ? "" : " footer-console-toggle--auto"}`}
          onClick={onToggleConsoleCollapse}
          title={consoleCollapsed ? "Expandir consola" : "Colapsar consola"}
          aria-label={consoleCollapsed ? "Expandir consola" : "Colapsar consola"}
        >
          {consoleCollapsed ? "▲" : "▼"}
        </button>
      ) : null}
    </footer>
  );
}
