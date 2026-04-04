import type { ReactNode } from "react";

interface PanelSectionProps {
  title?: string;
  className?: string;
  children: ReactNode;
}

function joinClassNames(...values: Array<string | undefined | false>): string {
  return values.filter(Boolean).join(" ");
}

export function PanelSection({ title, className, children }: PanelSectionProps): JSX.Element {
  return (
    <section className={joinClassNames("panel-card", "panel-section", className)}>
      {title ? <h4 className="panel-section-title">{title}</h4> : null}
      <div className="panel-section-body">{children}</div>
    </section>
  );
}
