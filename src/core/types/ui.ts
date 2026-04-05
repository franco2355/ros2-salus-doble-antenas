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
  onSelect?: (ctx: { runtime: AppRuntime; openModal: (modalId: string) => void }) => void | Promise<void>;
  items?: ToolbarMenuItemDefinition[];
}

export interface SidebarPanelDefinition {
  id: string;
  label: string;
  icon?: string;
  render: (runtime: AppRuntime) => ReactNode;
}

export interface WorkspaceViewDefinition {
  id: string;
  label: string;
  render: (runtime: AppRuntime) => ReactNode;
}

export interface ConsoleTabDefinition {
  id: string;
  label: string;
  render: (runtime: AppRuntime) => ReactNode;
}

export interface FooterItemDefinition {
  id: string;
  align?: "left" | "right";
  beforeId?: string;
  render: (runtime: AppRuntime) => ReactNode;
}

export interface ModalDialogDefinition {
  id: string;
  title: string;
  renderHeader?: (ctx: { runtime: AppRuntime; close: () => void }) => ReactNode;
  render: (ctx: { runtime: AppRuntime; close: () => void }) => ReactNode;
  renderFooter?: (ctx: { runtime: AppRuntime; close: () => void }) => ReactNode;
}
