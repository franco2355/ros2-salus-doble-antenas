import type { ReactNode } from "react";
import type { Disposable } from "../commands/types";

export type UISlot = "sidebar" | "workspace" | "console" | "footer" | "modal" | "toolbar";

export interface BaseContribution {
  readonly id: string;
  readonly slot: UISlot;
  readonly order?: number;
  readonly command?: string;
  readonly statusBarPriority?: number;
  readonly viewContext?: string;
}

export interface SidebarContribution extends BaseContribution {
  readonly slot: "sidebar";
  readonly label: string;
  readonly icon?: string;
  readonly render: () => ReactNode;
}

export interface WorkspaceContribution extends BaseContribution {
  readonly slot: "workspace";
  readonly label: string;
  readonly render: () => ReactNode;
}

export interface ConsoleContribution extends BaseContribution {
  readonly slot: "console";
  readonly label: string;
  readonly render: () => ReactNode;
}

export interface FooterContribution extends BaseContribution {
  readonly slot: "footer";
  readonly align?: "left" | "right";
  readonly beforeId?: string;
  readonly render: () => ReactNode;
}

export interface ModalContribution extends BaseContribution {
  readonly slot: "modal";
  readonly title: string;
  readonly render: (ctx: { close: () => void }) => ReactNode;
  readonly renderHeader?: (ctx: { close: () => void }) => ReactNode;
  readonly renderFooter?: (ctx: { close: () => void }) => ReactNode;
}

export interface ToolbarContribution extends BaseContribution {
  readonly slot: "toolbar";
  readonly label: string;
  readonly commandId?: string;
  readonly items?: ToolbarItemContribution[];
}

export interface ToolbarItemContribution {
  readonly id: string;
  readonly label: string;
  readonly commandId: string;
}

export type UIContribution =
  | SidebarContribution
  | WorkspaceContribution
  | ConsoleContribution
  | FooterContribution
  | ModalContribution
  | ToolbarContribution;

export interface ContributionRegistry {
  register(contribution: UIContribution): Disposable;
  unregister(id: string): void;
  has(id: string): boolean;
  get(id: string): UIContribution | undefined;
  query<S extends UISlot>(slot: S): Extract<UIContribution, { slot: S }>[];
  onChange(listener: () => void): Disposable;
}
