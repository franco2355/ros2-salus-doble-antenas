import type { CockpitModule } from "../types/module";
import { createDebugModule } from "../../modules/debug";
import { createMapModule } from "../../modules/map";
import { createNavigationModule } from "../../modules/navigation";
import { createSettingsModule } from "../../modules/settings";
import { createTelemetryModule } from "../../modules/telemetry";

export function getModuleCatalog(): CockpitModule[] {
  return [
    createNavigationModule(),
    createTelemetryModule(),
    createMapModule(),
    createDebugModule(),
    createSettingsModule()
  ];
}

