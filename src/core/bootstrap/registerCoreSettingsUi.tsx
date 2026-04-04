import { useEffect, useSyncExternalStore } from "react";
import type { AppRuntime, LoadedPackage, PackageSettingFieldSchema } from "../types/module";

type SettingsTabId = "global" | `package:${string}`;
type DraftValue = string | boolean;

interface PackageEditorState {
  drafts: Record<string, DraftValue>;
  errors: Record<string, string>;
}

interface SettingsUiState {
  activeTab: SettingsTabId;
  editorByPackage: Record<string, PackageEditorState>;
  footerNotice: string;
}

const settingsListeners = new Set<() => void>();
let settingsUiState: SettingsUiState = {
  activeTab: "global",
  editorByPackage: {},
  footerNotice: ""
};

function subscribeSettings(listener: () => void): () => void {
  settingsListeners.add(listener);
  return () => settingsListeners.delete(listener);
}

function emitSettings(): void {
  settingsListeners.forEach((listener) => listener());
}

function getSettingsUiState(): SettingsUiState {
  return settingsUiState;
}

function updateSettingsUiState(updater: (current: SettingsUiState) => SettingsUiState): void {
  settingsUiState = updater(settingsUiState);
  emitSettings();
}

function resetSettingsUiState(): void {
  settingsUiState = {
    activeTab: "global",
    editorByPackage: {},
    footerNotice: ""
  };
  emitSettings();
}

function sortedFields(cockpitPackage: LoadedPackage): PackageSettingFieldSchema[] {
  return [...cockpitPackage.settingsSchema.fields]
    .map((field, index) => ({ field, index }))
    .sort((left, right) => {
      const leftOrder = left.field.order ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = right.field.order ?? Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.index - right.index;
    })
    .map((entry) => entry.field);
}

function serializeFieldValue(value: unknown, field: PackageSettingFieldSchema): DraftValue {
  if (field.type === "boolean") {
    return value === true;
  }
  if (field.type === "json") {
    return JSON.stringify(value);
  }
  if (field.type === "number") {
    return typeof value === "number" ? String(value) : "";
  }
  return typeof value === "string" ? value : String(value ?? "");
}

function createEditorState(config: Record<string, unknown>, cockpitPackage: LoadedPackage): PackageEditorState {
  const drafts: Record<string, DraftValue> = {};
  for (const field of sortedFields(cockpitPackage)) {
    drafts[field.key] = serializeFieldValue(config[field.key], field);
  }
  return {
    drafts,
    errors: {}
  };
}

function parseFieldValue(raw: DraftValue, field: PackageSettingFieldSchema): { value?: unknown; error?: string } {
  if (field.type === "string") {
    return { value: String(raw) };
  }
  if (field.type === "number") {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      return { error: "Expected a valid number" };
    }
    return { value: parsed };
  }
  if (field.type === "boolean") {
    return { value: raw === true };
  }
  try {
    const parsed = JSON.parse(String(raw));
    return { value: parsed };
  } catch {
    return { error: "Invalid JSON value" };
  }
}

function applySchemaValidation(
  drafts: Record<string, DraftValue>,
  currentConfig: Record<string, unknown>,
  cockpitPackage: LoadedPackage
): { nextConfig: Record<string, unknown> | null; errors: Record<string, string> } {
  const nextConfig: Record<string, unknown> = { ...currentConfig };
  const errors: Record<string, string> = {};
  for (const field of sortedFields(cockpitPackage)) {
    const parsed = parseFieldValue(drafts[field.key], field);
    if (parsed.error) {
      errors[field.key] = parsed.error;
      continue;
    }
    nextConfig[field.key] = parsed.value;
  }
  if (Object.keys(errors).length > 0) {
    return { nextConfig: null, errors };
  }
  return { nextConfig, errors: {} };
}

function ensureSettingsState(runtime: AppRuntime): void {
  const packageIds = new Set(runtime.packages.map((entry) => entry.id));
  const current = getSettingsUiState();
  const nextEditorByPackage: Record<string, PackageEditorState> = { ...current.editorByPackage };
  let changed = false;

  runtime.packages.forEach((cockpitPackage) => {
    if (nextEditorByPackage[cockpitPackage.id]) return;
    const currentConfig = runtime.getPackageConfig<Record<string, unknown>>(cockpitPackage.id);
    nextEditorByPackage[cockpitPackage.id] = createEditorState(currentConfig, cockpitPackage);
    changed = true;
  });

  Object.keys(nextEditorByPackage).forEach((packageId) => {
    if (packageIds.has(packageId)) return;
    delete nextEditorByPackage[packageId];
    changed = true;
  });

  let nextActiveTab = current.activeTab;
  if (nextActiveTab !== "global") {
    const packageId = nextActiveTab.slice("package:".length);
    if (!packageIds.has(packageId)) {
      nextActiveTab = "global";
      changed = true;
    }
  }

  if (!changed) return;
  updateSettingsUiState(() => ({
    ...current,
    activeTab: nextActiveTab,
    editorByPackage: nextEditorByPackage
  }));
}

function useSettingsUi(runtime: AppRuntime): SettingsUiState {
  const snapshot = useSyncExternalStore(subscribeSettings, getSettingsUiState, getSettingsUiState);
  useEffect(() => {
    ensureSettingsState(runtime);
  }, [runtime]);
  return snapshot;
}

function resolveActivePackage(runtime: AppRuntime, activeTab: SettingsTabId): LoadedPackage | null {
  if (activeTab === "global") return null;
  const packageId = activeTab.slice("package:".length);
  return runtime.packages.find((entry) => entry.id === packageId) ?? null;
}

function SettingsModalHeader({ runtime, close }: { runtime: AppRuntime; close: () => void }): JSX.Element {
  const state = useSettingsUi(runtime);

  return (
    <div className="settings-modal-header">
      <div className="console-tabs settings-header-tabs">
        <button
          type="button"
          className={state.activeTab === "global" ? "active" : ""}
          onClick={() => {
            updateSettingsUiState((current) => ({
              ...current,
              activeTab: "global",
              footerNotice: ""
            }));
          }}
        >
          Global
        </button>
        {runtime.packages.map((cockpitPackage) => (
          <button
            key={cockpitPackage.id}
            type="button"
            className={state.activeTab === `package:${cockpitPackage.id}` ? "active" : ""}
            onClick={() => {
              updateSettingsUiState((current) => ({
                ...current,
                activeTab: `package:${cockpitPackage.id}`,
                footerNotice: ""
              }));
            }}
          >
            {cockpitPackage.id}
          </button>
        ))}
      </div>
      <button type="button" onClick={close}>
        X
      </button>
    </div>
  );
}

function SettingsModalBody({ runtime }: { runtime: AppRuntime }): JSX.Element {
  const source = runtime.moduleConfig.source;
  const state = useSettingsUi(runtime);
  const activePackage = resolveActivePackage(runtime, state.activeTab);

  if (!activePackage) {
    return (
      <div className="stack settings-modal-layout">
        <div className="panel-card">
          <p className="muted">No implementado aún.</p>
          <p className="muted">Config source: {source}</p>
        </div>
      </div>
    );
  }

  const config = runtime.getPackageConfig<Record<string, unknown>>(activePackage.id);
  const editorState = state.editorByPackage[activePackage.id] ?? createEditorState(config, activePackage);
  const fields = sortedFields(activePackage);

  return (
    <div className="stack settings-modal-layout">
      <div className="panel-card">
        <div className="settings-table">
          {fields.map((field) => (
            <div key={field.key} className="settings-row">
              <label htmlFor={`pkg-${activePackage.id}-${field.key}`} className="settings-key">
                {field.label}
              </label>
              <div className="settings-value-column">
                {field.type === "boolean" ? (
                  <label className="settings-boolean-toggle" htmlFor={`pkg-${activePackage.id}-${field.key}`}>
                    <input
                      id={`pkg-${activePackage.id}-${field.key}`}
                      type="checkbox"
                      checked={editorState.drafts[field.key] === true}
                      onChange={(event) => {
                        const nextDrafts = { ...editorState.drafts, [field.key]: event.target.checked };
                        const validation = applySchemaValidation(nextDrafts, config, activePackage);
                        updateSettingsUiState((current) => ({
                          ...current,
                          footerNotice: "",
                          editorByPackage: {
                            ...current.editorByPackage,
                            [activePackage.id]: {
                              drafts: nextDrafts,
                              errors: validation.errors
                            }
                          }
                        }));
                      }}
                    />
                    <span>{editorState.drafts[field.key] === true ? "true" : "false"}</span>
                  </label>
                ) : field.type === "json" ? (
                  <textarea
                    id={`pkg-${activePackage.id}-${field.key}`}
                    className={editorState.errors[field.key] ? "input-error" : ""}
                    value={String(editorState.drafts[field.key] ?? "")}
                    placeholder={field.placeholder}
                    rows={3}
                    spellCheck={false}
                    onChange={(event) => {
                      const nextDrafts = { ...editorState.drafts, [field.key]: event.target.value };
                      const validation = applySchemaValidation(nextDrafts, config, activePackage);
                      updateSettingsUiState((current) => ({
                        ...current,
                        footerNotice: "",
                        editorByPackage: {
                          ...current.editorByPackage,
                          [activePackage.id]: {
                            drafts: nextDrafts,
                            errors: validation.errors
                          }
                        }
                      }));
                    }}
                  />
                ) : (
                  <input
                    id={`pkg-${activePackage.id}-${field.key}`}
                    className={editorState.errors[field.key] ? "input-error" : ""}
                    value={String(editorState.drafts[field.key] ?? "")}
                    placeholder={field.placeholder}
                    onChange={(event) => {
                      const nextDrafts = { ...editorState.drafts, [field.key]: event.target.value };
                      const validation = applySchemaValidation(nextDrafts, config, activePackage);
                      updateSettingsUiState((current) => ({
                        ...current,
                        footerNotice: "",
                        editorByPackage: {
                          ...current.editorByPackage,
                          [activePackage.id]: {
                            drafts: nextDrafts,
                            errors: validation.errors
                          }
                        }
                      }));
                    }}
                  />
                )}
                {field.description ? <p className="muted settings-description">{field.description}</p> : null}
                {editorState.errors[field.key] ? <p className="muted settings-error">{editorState.errors[field.key]}</p> : null}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SettingsModalFooter({ runtime }: { runtime: AppRuntime }): JSX.Element {
  const state = useSettingsUi(runtime);
  const activePackage = resolveActivePackage(runtime, state.activeTab);
  const editorState = activePackage ? state.editorByPackage[activePackage.id] : null;
  const hasErrors = editorState ? Object.keys(editorState.errors).length > 0 : false;

  return (
    <div className="settings-footer">
      <button
        type="button"
        disabled={activePackage ? hasErrors : false}
        onClick={async () => {
          if (!activePackage) {
            updateSettingsUiState((current) => ({
              ...current,
              footerNotice: "Global configuration is not implemented yet."
            }));
            return;
          }

          const currentState = getSettingsUiState();
          const currentEditor = currentState.editorByPackage[activePackage.id];
          if (!currentEditor) return;

          const currentConfig = runtime.getPackageConfig<Record<string, unknown>>(activePackage.id);
          const validation = applySchemaValidation(currentEditor.drafts, currentConfig, activePackage);
          if (!validation.nextConfig) {
            updateSettingsUiState((current) => ({
              ...current,
              editorByPackage: {
                ...current.editorByPackage,
                [activePackage.id]: {
                  drafts: currentEditor.drafts,
                  errors: validation.errors
                }
              },
              footerNotice: ""
            }));
            return;
          }

          await runtime.setPackageConfig(activePackage.id, validation.nextConfig);
          updateSettingsUiState((current) => ({
            ...current,
            editorByPackage: {
              ...current.editorByPackage,
              [activePackage.id]: createEditorState(validation.nextConfig!, activePackage)
            },
            footerNotice: "Saved"
          }));
        }}
      >
        Save
      </button>
      <button
        type="button"
        onClick={async () => {
          if (!activePackage) {
            updateSettingsUiState((current) => ({
              ...current,
              footerNotice: "Global configuration is not implemented yet."
            }));
            return;
          }

          await runtime.resetPackageConfig(activePackage.id);
          const resetConfig = runtime.getPackageConfig<Record<string, unknown>>(activePackage.id);
          updateSettingsUiState((current) => ({
            ...current,
            editorByPackage: {
              ...current.editorByPackage,
              [activePackage.id]: createEditorState(resetConfig, activePackage)
            },
            footerNotice: "Reset to package defaults"
          }));
        }}
      >
        Reset
      </button>
      {state.footerNotice ? <span className="muted">{state.footerNotice}</span> : null}
    </div>
  );
}

export function registerCoreSettingsUi(runtime: AppRuntime): void {
  runtime.registries.modalRegistry.registerModalDialog({
    id: "modal.settings",
    title: "Settings",
    order: 20,
    renderHeader: ({ runtime: modalRuntime, close }) => <SettingsModalHeader runtime={modalRuntime} close={close} />,
    render: ({ runtime: modalRuntime }) => <SettingsModalBody runtime={modalRuntime} />,
    renderFooter: ({ runtime: modalRuntime }) => <SettingsModalFooter runtime={modalRuntime} />
  });

  runtime.registries.toolbarMenuRegistry.registerToolbarMenu({
    id: "toolbar.settings",
    label: "Settings",
    order: 50,
    onSelect: ({ openModal }) => {
      resetSettingsUiState();
      openModal("modal.settings");
    }
  });
}
