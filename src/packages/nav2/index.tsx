import type { CockpitPackage } from "../../core/types/module";
import { createDebugModule } from "./frontend/debug";
import { createMapModule } from "./frontend/map";
import { createNavigationModule } from "./frontend/navigation";
import { createTelemetryModule } from "./frontend/telemetry";

export function createPackage(): CockpitPackage {
  return {
    id: "nav2",
    version: "1.0.0",
    enabledByDefault: true,
    modules: [
      createNavigationModule(),
      createTelemetryModule(),
      createMapModule(),
      createDebugModule()
    ]
  };
}
