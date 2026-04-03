import type { ReactNode } from "react";
import type { AppRuntime } from "./module";

export interface ToolbarMenuItemDefinition {
  id: string;
  label: string;
  onSelect: (ctx: { runtime: AppRuntime; openModal: (modalId: string) => void }) => void | Promise<void>;
}

export interface ToolbarMenuDefinition {
  id: string;
  label: string;
  order?: number;
  items: ToolbarMenuItemDefinition[];
}

export interface SidebarPanelDefinition {
  id: string;
  label: string;
  order?: number;
  render: (runtime: AppRuntime) => ReactNode;
}

export interface WorkspaceViewDefinition {
  id: string;
  label: string;
  order?: number;
  render: (runtime: AppRuntime) => ReactNode;
}

export interface ConsoleTabDefinition {
  id: string;
  label: string;
  order?: number;
  render: (runtime: AppRuntime) => ReactNode;
}

export interface ModalDialogDefinition {
  id: string;
  title: string;
  order?: number;
  render: (ctx: { runtime: AppRuntime; close: () => void }) => ReactNode;
  renderFooter?: (ctx: { runtime: AppRuntime; close: () => void }) => ReactNode;
}

