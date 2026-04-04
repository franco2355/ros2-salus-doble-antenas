import { useState, type KeyboardEvent, type ReactNode } from "react";

interface PanelCollapsibleSectionProps {
  title: string;
  defaultCollapsed?: boolean;
  className?: string;
  actions?: ReactNode;
  children: ReactNode;
}

function joinClassNames(...values: Array<string | undefined | false>): string {
  return values.filter(Boolean).join(" ");
}

export function PanelCollapsibleSection({
  title,
  defaultCollapsed = false,
  className,
  actions,
  children
}: PanelCollapsibleSectionProps): JSX.Element {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  const toggle = (): void => {
    setCollapsed((current) => !current);
  };

  const onHeaderKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggle();
  };

  return (
    <section className={joinClassNames("panel-card", "collapsible-section", collapsed && "collapsed", className)}>
      <div className="collapsible-section-header-row">
        <div
          className="collapsible-section-header"
          role="button"
          tabIndex={0}
          aria-expanded={collapsed ? "false" : "true"}
          onClick={toggle}
          onKeyDown={onHeaderKeyDown}
        >
          <span className="collapsible-section-chevron" aria-hidden="true" />
          <h4 className="collapsible-section-title">{title}</h4>
        </div>
        {actions ? <div className="collapsible-section-actions">{actions}</div> : null}
      </div>
      {!collapsed ? <div className="collapsible-section-body">{children}</div> : null}
    </section>
  );
}
