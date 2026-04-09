import { useEffect, useSyncExternalStore } from "react";
import type { AppRuntime, LoadedPackage, PackageSettingFieldSchema } from "../types/module";
import { CORE_EVENTS } from "../events/topics";
import {
  DEFAULT_CORE_NOTIFICATION_SETTINGS,
  loadCoreNotificationSettings,
  resetCoreNotificationSettings,
  saveCoreNotificationSettings
} from "../config/globalNotificationConfig";
import type { CoreNotificationSettings } from "../types/settings";
import { ShellCommands } from "../../app/shellCommands";

type SettingsTabId = "global" | `package:${string}`;
type DraftValue = string | boolean;

interface PackageEditorState {
  drafts: Record<string, DraftValue>;
  errors: Record<string, string>;
}

interface SettingsUiState {
  activeTab: SettingsTabId;
  globalConfig: CoreNotificationSettings | null;
  globalEditor: PackageEditorState | null;
  globalLoading: boolean;
  editorByPackage: Record<string, PackageEditorState>;
  footerNotice: string;
}

const settingsListeners = new Set<() => void>();
const OPEN_SETTINGS_COMMAND_ID = "core.settings.openModal";
let settingsUiState: SettingsUiState = {
  activeTab: "global",
  globalConfig: null,
  globalEditor: null,
  globalLoading: false,
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
    globalConfig: null,
    globalEditor: null,
    globalLoading: false,
    editorByPackage: {},
    footerNotice: ""
  };
  emitSettings();
}

const GLOBAL_SETTINGS_FIELDS: PackageSettingFieldSchema[] = [
  { key: "notifications_enabled", label: "Notifications Enabled", type: "boolean" },
  { key: "notify_on_route_complete", label: "Notify Route Complete", type: "boolean" },
  { key: "notify_on_obstacle", label: "Notify Obstacle", type: "boolean" },
  { key: "notify_on_connection_lost", label: "Notify Connection Lost", type: "boolean" },
  { key: "connected_reminder_enabled", label: "Connected Reminder Enabled", type: "boolean" },
  {
    key: "connected_reminder_interval_ms",
    label: "Connected Reminder Interval (ms)",
    type: "number",
    placeholder: "180000"
  },
  { key: "notification_cooldown_ms", label: "Notification Cooldown (ms)", type: "number", placeholder: "30000" },
  {
    key: "obstacle_keywords",
    label: "Obstacle Keywords (JSON array)",
    type: "json",
    placeholder: "[\"obstacle\",\"blocked\",\"collision\",\"stuck\",\"path_blocked\"]"
  }
];

const GLOBAL_SETTINGS_PACKAGE: LoadedPackage = {
  id: "core.notifications",
  version: "1.0.0",
  enabled: true,
  moduleIds: [],
  settingsSchema: {
    title: "Global Notifications",
    fields: GLOBAL_SETTINGS_FIELDS
  }
};

function listedFields(cockpitPackage: LoadedPackage): PackageSettingFieldSchema[] {
  return [...cockpitPackage.settingsSchema.fields];
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
  for (const field of listedFields(cockpitPackage)) {
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
  for (const field of listedFields(cockpitPackage)) {
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

let globalSettingsLoadInFlight = false;

async function ensureGlobalSettingsState(): Promise<void> {
  const current = getSettingsUiState();
  if (current.globalConfig || current.globalLoading || globalSettingsLoadInFlight) return;
  globalSettingsLoadInFlight = true;
  updateSettingsUiState((state) => ({
    ...state,
    globalLoading: true
  }));
  try {
    const loaded = await loadCoreNotificationSettings();
    updateSettingsUiState((state) => ({
      ...state,
      globalConfig: loaded,
      globalEditor: createEditorState(loaded, GLOBAL_SETTINGS_PACKAGE),
      globalLoading: false
    }));
  } finally {
    globalSettingsLoadInFlight = false;
  }
}

function useSettingsUi(runtime: AppRuntime): SettingsUiState {
  const snapshot = useSyncExternalStore(subscribeSettings, getSettingsUiState, getSettingsUiState);
  useEffect(() => {
    ensureSettingsState(runtime);
    void ensureGlobalSettingsState();
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
    </div>
  );
}

function SettingsModalBody({ runtime }: { runtime: AppRuntime }): JSX.Element {
  const state = useSettingsUi(runtime);
  const activePackage = resolveActivePackage(runtime, state.activeTab);

  if (!activePackage) {
    if (state.globalLoading || !state.globalConfig || !state.globalEditor) {
      return (
        <div className="stack settings-modal-layout">
          <div className="panel-card">
            <p className="muted">Loading global settings...</p>
          </div>
        </div>
      );
    }
    const globalValidation = applySchemaValidation(
      state.globalEditor.drafts,
      state.globalConfig,
      GLOBAL_SETTINGS_PACKAGE
    );
    return (
      <div className="stack settings-modal-layout">
        <div className="panel-card">
          <div className="settings-table">
            {listedFields(GLOBAL_SETTINGS_PACKAGE).map((field) => (
              <div key={field.key} className="settings-row">
                <label htmlFor={`global-${field.key}`} className="settings-key">
                  {field.label}
                </label>
                <div className="settings-value-column">
                  {field.type === "boolean" ? (
                    <label className="settings-boolean-toggle" htmlFor={`global-${field.key}`}>
                      <input
                        id={`global-${field.key}`}
                        type="checkbox"
                        checked={state.globalEditor!.drafts[field.key] === true}
                        onChange={(event) => {
                          const nextDrafts = {
                            ...state.globalEditor!.drafts,
                            [field.key]: event.target.checked
                          };
                          const validation = applySchemaValidation(
                            nextDrafts,
                            state.globalConfig!,
                            GLOBAL_SETTINGS_PACKAGE
                          );
                          updateSettingsUiState((current) => ({
                            ...current,
                            footerNotice: "",
                            globalEditor: {
                              drafts: nextDrafts,
                              errors: validation.errors
                            }
                          }));
                        }}
                      />
                      <span>{state.globalEditor!.drafts[field.key] === true ? "true" : "false"}</span>
                    </label>
                  ) : field.type === "json" ? (
                    <textarea
                      id={`global-${field.key}`}
                      className={state.globalEditor!.errors[field.key] ? "input-error" : ""}
                      value={String(state.globalEditor!.drafts[field.key] ?? "")}
                      placeholder={field.placeholder}
                      rows={3}
                      spellCheck={false}
                      onChange={(event) => {
                        const nextDrafts = {
                          ...state.globalEditor!.drafts,
                          [field.key]: event.target.value
                        };
                        const validation = applySchemaValidation(
                          nextDrafts,
                          state.globalConfig!,
                          GLOBAL_SETTINGS_PACKAGE
                        );
                        updateSettingsUiState((current) => ({
                          ...current,
                          footerNotice: "",
                          globalEditor: {
                            drafts: nextDrafts,
                            errors: validation.errors
                          }
                        }));
                      }}
                    />
                  ) : (
                    <input
                      id={`global-${field.key}`}
                      className={state.globalEditor!.errors[field.key] ? "input-error" : ""}
                      value={String(state.globalEditor!.drafts[field.key] ?? "")}
                      placeholder={field.placeholder}
                      onChange={(event) => {
                        const nextDrafts = {
                          ...state.globalEditor!.drafts,
                          [field.key]: event.target.value
                        };
                        const validation = applySchemaValidation(
                          nextDrafts,
                          state.globalConfig!,
                          GLOBAL_SETTINGS_PACKAGE
                        );
                        updateSettingsUiState((current) => ({
                          ...current,
                          footerNotice: "",
                          globalEditor: {
                            drafts: nextDrafts,
                            errors: validation.errors
                          }
                        }));
                      }}
                    />
                  )}
                  {field.description ? <p className="muted settings-description">{field.description}</p> : null}
                  {state.globalEditor!.errors[field.key] ? (
                    <p className="muted settings-error">{state.globalEditor!.errors[field.key]}</p>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          {Object.keys(globalValidation.errors).length > 0 ? (
            <p className="muted settings-error">Fix validation errors before saving.</p>
          ) : null}
        </div>
      </div>
    );
  }

  const config = runtime.getPackageConfig<Record<string, unknown>>(activePackage.id);
  const editorState = state.editorByPackage[activePackage.id] ?? createEditorState(config, activePackage);
  const fields = listedFields(activePackage);

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
  const editorState = activePackage ? state.editorByPackage[activePackage.id] : state.globalEditor;
  const hasErrors = editorState ? Object.keys(editorState.errors).length > 0 : false;

  return (
    <div className="settings-footer">
      <button
        type="button"
        disabled={activePackage ? hasErrors : false}
        onClick={async () => {
          if (!activePackage) {
            if (!state.globalConfig || !state.globalEditor) return;
            const validation = applySchemaValidation(
              state.globalEditor.drafts,
              state.globalConfig,
              GLOBAL_SETTINGS_PACKAGE
            );
            if (!validation.nextConfig) {
              updateSettingsUiState((current) => ({
                ...current,
                globalEditor: {
                  drafts: state.globalEditor!.drafts,
                  errors: validation.errors
                },
                footerNotice: ""
              }));
              return;
            }
            const saved = await saveCoreNotificationSettings(validation.nextConfig);
            updateSettingsUiState((current) => ({
              ...current,
              globalConfig: saved,
              globalEditor: createEditorState(saved, GLOBAL_SETTINGS_PACKAGE),
              footerNotice: "Saved"
            }));
            runtime.eventBus.emit(CORE_EVENTS.globalNotificationSettingsUpdated, {
              settings: saved
            });
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
            const defaults = await resetCoreNotificationSettings();
            updateSettingsUiState((current) => ({
              ...current,
              globalConfig: defaults,
              globalEditor: createEditorState(defaults, GLOBAL_SETTINGS_PACKAGE),
              footerNotice: "Reset to defaults"
            }));
            runtime.eventBus.emit(CORE_EVENTS.globalNotificationSettingsUpdated, {
              settings: defaults
            });
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
  runtime.contributions.register({
    id: "modal.settings",
    slot: "modal",
    title: "Settings",
    renderHeader: ({ close }) => <SettingsModalHeader runtime={runtime} close={close} />,
    render: () => <SettingsModalBody runtime={runtime} />,
    renderFooter: () => <SettingsModalFooter runtime={runtime} />
  });

  runtime.commands.register(
    { id: OPEN_SETTINGS_COMMAND_ID, title: "Open Settings Modal", category: "Settings" },
    () => {
      resetSettingsUiState();
      return runtime.commands.execute(ShellCommands.openModal, "modal.settings");
    }
  );

  runtime.contributions.register({
    id: "toolbar.settings",
    slot: "toolbar",
    label: "Settings",
    commandId: OPEN_SETTINGS_COMMAND_ID
  });
}
