export const NAV_EVENTS = {
  swapWorkspaceRequest: "workspace.camera-gps.swap.request",
  snapshotCaptureRequest: "navigation.snapshot.capture.request",
  snapshotDownloadRequest: "navigation.snapshot.download.request",
  snapshotDownloadResult: "navigation.snapshot.download.result"
} as const;

export const CORE_EVENTS = {
  packageConfigUpdated: "core.package-config.updated"
} as const;
