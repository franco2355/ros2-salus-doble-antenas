import React from "react";
import ReactDOM from "react-dom/client";
import { AppShell } from "./app/AppShell";
import { VscodeWebviewShell, type CockpitWebviewSlot } from "./app/VscodeWebviewShell";
import { bootstrapApp } from "./core/bootstrap/bootstrapApp";
import { isHostBridgeAvailable } from "./platform/host/bridge";
import "./app/base.css";

declare global {
  interface Window {
    __COCKPIT_WEBVIEW_SLOT__?: CockpitWebviewSlot;
  }
}

async function start(): Promise<void> {
  const runtime = await bootstrapApp();
  const slot = window.__COCKPIT_WEBVIEW_SLOT__ ?? "full";
  const useVscodeFullLayout = slot === "full" && isHostBridgeAvailable();
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      {slot === "full" ? (
        <AppShell runtime={runtime} layoutMode={useVscodeFullLayout ? "vscode" : "default"} />
      ) : (
        <VscodeWebviewShell runtime={runtime} slot={slot} />
      )}
    </React.StrictMode>
  );
}

void start();
