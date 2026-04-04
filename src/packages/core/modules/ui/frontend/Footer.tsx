import type { AppRuntime } from "../../../../../core/types/module";
import type { FooterItemDefinition } from "../../../../../core/types/ui";

interface FooterProps {
  runtime: AppRuntime;
  items: FooterItemDefinition[];
  consoleCollapsed: boolean;
  onToggleConsoleCollapse: () => void;
}

export function Footer({ runtime, items, consoleCollapsed, onToggleConsoleCollapse }: FooterProps): JSX.Element {
  return (
    <footer className="shell-footer">
      {items.map((item) => (
        <div key={item.id} className="footer-item">
          {item.render(runtime)}
        </div>
      ))}
      <button
        type="button"
        className="footer-console-toggle"
        onClick={onToggleConsoleCollapse}
        title={consoleCollapsed ? "Expandir consola" : "Colapsar consola"}
        aria-label={consoleCollapsed ? "Expandir consola" : "Colapsar consola"}
      >
        {consoleCollapsed ? "▲" : "▼"}
      </button>
    </footer>
  );
}
