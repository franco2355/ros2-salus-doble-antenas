import { Fragment } from "react";
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

  return (
    <footer className="shell-footer footer">
      {orderedItems.map((item, index) => {
        const isConnectionStatus = item.id.includes("connection-status");
        const isFirstRightItem = index === firstRightItemIndex;
        const nextItem = orderedItems[index + 1];
        const showSeparator =
          index < orderedItems.length - 1 &&
          !isConnectionStatus &&
          item.align !== "right" &&
          nextItem?.align !== "right";

        return (
          <Fragment key={item.id}>
            {isFirstRightItem ? <div className="footer-sp" aria-hidden="true" /> : null}
            {isConnectionStatus ? (
              <div className="footer-badge">
                <div className="footer-item footer-item-connection-status">{item.render()}</div>
              </div>
            ) : (
              <div className={`footer-item${item.align === "right" ? " footer-item-right" : ""}`}>{item.render()}</div>
            )}
            {showSeparator ? <div className="footer-sep" aria-hidden="true" /> : null}
          </Fragment>
        );
      })}
      {showConsoleToggle ? (
        <button
          type="button"
          className="footer-console-toggle"
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
