import { useState, useEffect } from "react";
import type { ContributionRegistry, UIContribution, UISlot } from "./types";

export function useSlot<S extends UISlot>(
  registry: ContributionRegistry,
  slot: S
): Extract<UIContribution, { slot: S }>[] {
  const [items, setItems] = useState(() => registry.query(slot));

  useEffect(() => {
    const disposable = registry.onChange(() => {
      setItems(registry.query(slot));
    });
    return () => disposable.dispose();
  }, [registry, slot]);

  return items;
}
