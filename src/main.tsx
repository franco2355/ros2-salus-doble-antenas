import React from "react";
import ReactDOM from "react-dom/client";
import { AppShell } from "./app/AppShell";
import { bootstrapApp } from "./core/bootstrap/bootstrapApp";
import "./styles.css";

async function start(): Promise<void> {
  const runtime = await bootstrapApp();
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <AppShell runtime={runtime} />
    </React.StrictMode>
  );
}

void start();

