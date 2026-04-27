import type { ContributionRegistry, UIContribution, UISlot } from "./types";

export function createContributionRegistry(): ContributionRegistry {
  const items = new Map<string, UIContribution>();
  const listeners = new Set<() => void>();

  const notify = (): void => {
    listeners.forEach((fn) => fn());
  };

  return {
    register(contribution) {
      if (items.has(contribution.id)) {
        throw new Error(`Contribution already registered: '${contribution.id}'`);
      }
      items.set(contribution.id, contribution);
      notify();
      return {
        dispose() {
          items.delete(contribution.id);
          notify();
        }
      };
    },

    unregister(id) {
      items.delete(id);
      notify();
    },

    has: (id) => items.has(id),

    get: (id) => items.get(id),

    query<S extends UISlot>(slot: S): Extract<UIContribution, { slot: S }>[] {
      const result = [...items.values()]
        .filter((c): c is Extract<UIContribution, { slot: S }> => c.slot === slot)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      return result;
    },

    onChange(listener) {
      listeners.add(listener);
      return {
        dispose() {
          listeners.delete(listener);
        }
      };
    }
  };
}
