import type { CockpitPackage } from "../../core/types/module";
import { createCameraModule } from "./modules/camera/frontend";
import { createDebugModule } from "./modules/debug/frontend";
import { createMapModule } from "./modules/map/frontend";
import { createNavigationModule } from "./modules/navigation/frontend";
import { createProcessesModule } from "./modules/processes/frontend";
import { createTelemetryModule } from "./modules/telemetry/frontend";

export function createPackage(): CockpitPackage {
  return {
    id: "nav2",
    version: "1.0.0",
    enabledByDefault: true,
    modules: [
      createNavigationModule(),
      createTelemetryModule(),
      createProcessesModule(),
      createMapModule(),
      createCameraModule(),
      createDebugModule()
    ]
  };
}
