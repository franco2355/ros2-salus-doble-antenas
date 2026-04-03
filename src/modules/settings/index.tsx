import type { CockpitModule, ModuleContext } from "../../core/types/module";
import { readConfig, writeConfig } from "../../platform/tauri/configFs";

function SettingsModal(runtime: ModuleContext): JSX.Element {
  const source = runtime.moduleConfig.source;
  return (
    <div className="panel-card">
      <h3>Settings</h3>
      <p className="muted">Module config source: {source}</p>
      <button
        type="button"
        onClick={async () => {
          const current = (await readConfig("app.json")) ?? "{}";
          await writeConfig("app.json", current);
          runtime.eventBus.emit("console.event", {
            level: "info",
            text: "Config file persisted",
            timestamp: Date.now()
          });
        }}
      >
        Persist config
      </button>
    </div>
  );
}

export function createSettingsModule(): CockpitModule {
  return {
    id: "settings",
    version: "1.0.0",
    enabledByDefault: true,
    register(ctx: ModuleContext): void {
      ctx.registries.modalRegistry.registerModalDialog({
        id: "modal.settings",
        title: "Settings",
        order: 20,
        render: () => SettingsModal(ctx)
      });

      ctx.registries.toolbarMenuRegistry.registerToolbarMenu({
        id: "toolbar.settings",
        label: "Settings",
        order: 50,
        items: [
          {
            id: "settings.open-modal",
            label: "Open settings",
            onSelect: ({ openModal }) => openModal("modal.settings")
          }
        ]
      });
    }
  };
}

