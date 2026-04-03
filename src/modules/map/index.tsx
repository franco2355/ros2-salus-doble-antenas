import { useEffect, useState } from "react";
import type { CockpitModule, ModuleContext } from "../../core/types/module";
import { MapDispatcher } from "../../dispatcher/impl/MapDispatcher";
import { MapService, type MapToolMode, type MapWorkspaceState } from "../../services/impl/MapService";
import { GoogleMapsTransport } from "../../transport/impl/GoogleMapsTransport";

const TRANSPORT_ID = "transport.googlemaps";
const DISPATCHER_ID = "dispatcher.map";
const SERVICE_ID = "service.map";

function ZonesSidebarPanel({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const service = runtime.registries.serviceRegistry.getService<MapService>(SERVICE_ID);
  const [state, setState] = useState<MapWorkspaceState>(service.getState());
  const [zoneName, setZoneName] = useState("");

  useEffect(() => service.subscribe((next) => setState(next)), [service]);

  return (
    <div className="stack">
      <div className="panel-card">
        <h3>Zones</h3>
        <p className="muted">Gestion de zonas editable separada del transport.</p>
        <div className="action-grid">
          <button
            type="button"
            onClick={() => {
              service.refreshZones();
              runtime.eventBus.emit("console.event", {
                level: "info",
                text: "Zones refreshed",
                timestamp: Date.now()
              });
            }}
          >
            Refresh
          </button>
          <button
            type="button"
            className="danger-btn"
            onClick={() => {
              service.clearZones();
              runtime.eventBus.emit("console.event", {
                level: "warn",
                text: "Zones cleared",
                timestamp: Date.now()
              });
            }}
          >
            Clear
          </button>
        </div>
        <div className="action-grid">
          <button
            type="button"
            onClick={() => {
              const payload = service.saveZones();
              if (typeof window !== "undefined") {
                window.localStorage.setItem("cockpit.map.zones.v1", payload);
              }
              runtime.eventBus.emit("console.event", {
                level: "info",
                text: "Zones saved",
                timestamp: Date.now()
              });
            }}
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              const stored = typeof window !== "undefined" ? window.localStorage.getItem("cockpit.map.zones.v1") : null;
              try {
                service.loadZones(stored ?? undefined);
                runtime.eventBus.emit("console.event", {
                  level: "info",
                  text: "Zones loaded",
                  timestamp: Date.now()
                });
              } catch (error) {
                runtime.eventBus.emit("console.event", {
                  level: "error",
                  text: `Load zones failed: ${String(error)}`,
                  timestamp: Date.now()
                });
              }
            }}
          >
            Load
          </button>
        </div>
        <label className="check-row">
          <input type="checkbox" checked={state.autoSync} onChange={(event) => service.setAutoSync(event.target.checked)} />
          Auto-sync edits
        </label>
        <div className="row">
          <input
            className="grow"
            value={zoneName}
            onChange={(event) => setZoneName(event.target.value)}
            placeholder="Zone name"
          />
          <button
            type="button"
            onClick={() => {
              const zone = service.addZone(zoneName);
              setZoneName("");
              runtime.eventBus.emit("console.event", {
                level: "info",
                text: `Zone added: ${zone.name}`,
                timestamp: Date.now()
              });
            }}
          >
            Add
          </button>
        </div>
      </div>
      <div className="panel-card">
        <h4>Zone List</h4>
        {state.zones.length === 0 ? (
          <p className="muted">No zones.</p>
        ) : (
          <ul className="zone-list">
            {state.zones.map((zone) => (
              <li key={zone.id} className="zone-item">
                <div>
                  <strong>{zone.name}</strong>
                  <div className="muted">
                    vertices={zone.vertices} · {new Date(zone.updatedAt).toLocaleTimeString()}
                  </div>
                </div>
                <button type="button" className="danger-btn" onClick={() => service.removeZone(zone.id)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function toolButtonClass(current: MapToolMode, target: MapToolMode): string {
  return current === target ? "active" : "";
}

function MapWorkspaceView({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const mapService = runtime.registries.serviceRegistry.getService<MapService>(SERVICE_ID);
  const [state, setState] = useState<MapWorkspaceState>(mapService.getState());
  const [mapId, setMapId] = useState("default-map");
  const [inspectLat, setInspectLat] = useState("-31.4201");
  const [inspectLon, setInspectLon] = useState("-64.1888");

  useEffect(() => mapService.subscribe((next) => setState(next)), [mapService]);

  const selectTool = (tool: MapToolMode, infoLabel: string): void => {
    mapService.setToolMode(tool);
    runtime.eventBus.emit("console.event", {
      level: "info",
      text: `Map tool: ${infoLabel}`,
      timestamp: Date.now()
    });
  };

  return (
    <div className="stack">
      <div className="panel-card">
        <div className="row">
          <input className="grow" value={mapId} onChange={(event) => setMapId(event.target.value)} />
          <button
            type="button"
            onClick={async () => {
              try {
                const loaded = await mapService.loadMap(mapId);
                runtime.eventBus.emit("console.event", {
                  level: "info",
                  text: `Map loaded: ${loaded.mapId}`,
                  timestamp: Date.now()
                });
              } catch (error) {
                runtime.eventBus.emit("console.event", {
                  level: "error",
                  text: `Map load failed: ${String(error)}`,
                  timestamp: Date.now()
                });
              }
            }}
          >
            Load map
          </button>
        </div>
        <div className="map-toolbar">
          <button type="button" className={toolButtonClass(state.toolMode, "ruler")} onClick={() => selectTool("ruler", "ruler")}>
            📏 Ruler
          </button>
          <button type="button" className={toolButtonClass(state.toolMode, "area")} onClick={() => selectTool("area", "area")}>
            📐 Area
          </button>
          <button type="button" className={toolButtonClass(state.toolMode, "inspect")} onClick={() => selectTool("inspect", "inspect")}>
            📍 Inspect
          </button>
          <button
            type="button"
            onClick={() => {
              mapService.centerRobot();
              runtime.eventBus.emit("console.event", {
                level: "info",
                text: "Map centered on robot",
                timestamp: Date.now()
              });
            }}
          >
            🎯 Center robot
          </button>
          <button
            type="button"
            onClick={() => {
              mapService.setDatumFromRobot();
              runtime.eventBus.emit("console.event", {
                level: "info",
                text: "Datum updated from robot pose",
                timestamp: Date.now()
              });
            }}
          >
            🧲 Set datum
          </button>
          <button type="button" onClick={() => selectTool("idle", "idle")}>
            ❌ Close
          </button>
        </div>
        <p className="muted">{state.toolInfo}</p>
        <div className="row">
          <input value={inspectLat} onChange={(event) => setInspectLat(event.target.value)} placeholder="Lat" />
          <input value={inspectLon} onChange={(event) => setInspectLon(event.target.value)} placeholder="Lon" />
          <button
            type="button"
            onClick={() => {
              const lat = Number(inspectLat);
              const lon = Number(inspectLon);
              if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
              mapService.setInspectCoords(lat, lon);
            }}
          >
            Apply inspect point
          </button>
        </div>
        <p className="muted">Inspect coords: {state.inspectCoords}</p>
      </div>
      <div className="map-canvas">
        <div className="pane-placeholder">
          {state.map
            ? `${state.map.title} · origin ${state.map.originLat.toFixed(4)}, ${state.map.originLon.toFixed(4)}`
            : "Map canvas host (Leaflet/Map adapter)"}
        </div>
      </div>
    </div>
  );
}

export function createMapModule(): CockpitModule {
  return {
    id: "map",
    version: "1.1.0",
    enabledByDefault: true,
    register(ctx: ModuleContext): void {
      const transport = new GoogleMapsTransport(TRANSPORT_ID);
      ctx.registries.transportRegistry.registerTransport({
        id: transport.id,
        order: 30,
        transport
      });

      const dispatcher = new MapDispatcher(DISPATCHER_ID, TRANSPORT_ID);
      ctx.registries.dispatcherRegistry.registerDispatcher({
        id: dispatcher.id,
        order: 30,
        dispatcher
      });

      const service = new MapService(dispatcher);
      ctx.registries.serviceRegistry.registerService({
        id: SERVICE_ID,
        order: 30,
        service
      });

      ctx.registries.sidebarPanelRegistry.registerSidebarPanel({
        id: "sidebar.zones",
        label: "Zones",
        order: 20,
        render: (runtime) => <ZonesSidebarPanel runtime={runtime} />
      });

      ctx.registries.workspaceViewRegistry.registerWorkspaceView({
        id: "workspace.map",
        label: "Map",
        order: 10,
        render: (runtime) => <MapWorkspaceView runtime={runtime} />
      });
    }
  };
}
