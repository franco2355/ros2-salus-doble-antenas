import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet-draw";
import "leaflet-draw/dist/leaflet.draw.css";
import { NAV_EVENTS } from "../../core/events/topics";
import type { CockpitModule, ModuleContext } from "../../core/types/module";
import { MapDispatcher } from "../../dispatcher/impl/MapDispatcher";
import { ConnectionService, type ConnectionState } from "../../services/impl/ConnectionService";
import { MapService, type MapToolMode, type MapWorkspaceState } from "../../services/impl/MapService";
import { NavigationService, type NavigationState } from "../../services/impl/NavigationService";
import type { TelemetrySnapshot } from "../../services/impl/TelemetryService";

const TRANSPORT_ID = "transport.ws.core";
const DISPATCHER_ID = "dispatcher.map";
const SERVICE_ID = "service.map";
const NAVIGATION_SERVICE_ID = "service.navigation";
const CONNECTION_SERVICE_ID = "service.connection";
const TELEMETRY_SERVICE_ID = "service.telemetry";
const GPS_NATIVE_MAX_ZOOM = 19;
const GPS_DEFAULT_ZOOM = GPS_NATIVE_MAX_ZOOM - 3;
const GPS_DEFAULT_CENTER: L.LatLngTuple = [-31.421785, -64.102448];

interface TelemetryServiceLike {
  getSnapshot: () => TelemetrySnapshot;
  subscribeTelemetry: (callback: (snapshot: TelemetrySnapshot) => void) => () => void;
}

function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

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
            onClick={async () => {
              try {
                await service.loadMap("map");
                runtime.eventBus.emit("console.event", {
                  level: "info",
                  text: "Zones refreshed",
                  timestamp: Date.now()
                });
              } catch (error) {
                runtime.eventBus.emit("console.event", {
                  level: "error",
                  text: `Refresh failed: ${String(error)}`,
                  timestamp: Date.now()
                });
              }
            }}
          >
            Refresh
          </button>
          <button
            type="button"
            className="danger-btn"
            onClick={() => {
              if (typeof window !== "undefined") {
                const ok = window.confirm(`Clear all ${state.zones.length} no-go zones?`);
                if (!ok) return;
              }
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
            onClick={async () => {
              try {
                await service.pushZonesToBackend();
                const count = service.persistZonesToStorage();
                runtime.eventBus.emit("console.event", {
                  level: "info",
                  text: `Zones saved (${count})`,
                  timestamp: Date.now()
                });
              } catch (error) {
                runtime.eventBus.emit("console.event", {
                  level: "error",
                  text: `Save zones failed: ${String(error)}`,
                  timestamp: Date.now()
                });
              }
            }}
          >
            Save
          </button>
          <button
            type="button"
            onClick={async () => {
              try {
                const count = service.loadZonesFromStorage();
                await service.loadZonesFromBackend();
                runtime.eventBus.emit("console.event", {
                  level: "info",
                  text: `Zones loaded (${count})`,
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

function extractPolygonLatLon(layer: L.Polygon): Array<{ lat: number; lon: number }> {
  const latLngs = layer.getLatLngs();
  const ring = Array.isArray(latLngs[0]) ? (latLngs[0] as L.LatLng[]) : [];
  return ring.map((entry) => ({ lat: entry.lat, lon: entry.lng }));
}

function formatDistanceMeters(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) return "0 m";
  return meters >= 1000 ? `${(meters / 1000).toFixed(3)} km` : `${meters.toFixed(1)} m`;
}

function formatAreaSqMeters(area: number): string {
  if (!Number.isFinite(area) || area <= 0) return "0 m²";
  return area >= 1_000_000 ? `${(area / 1_000_000).toFixed(3)} km²` : `${area.toFixed(1)} m²`;
}

function geodesicArea(points: L.LatLng[]): number {
  const geometryUtil = (L as unknown as { GeometryUtil?: { geodesicArea: (coords: L.LatLng[]) => number } }).GeometryUtil;
  if (geometryUtil?.geodesicArea) {
    return Math.abs(geometryUtil.geodesicArea(points));
  }
  if (points.length < 3) return 0;
  const projected = points.map((point) => L.CRS.EPSG3857.project(point));
  let area = 0;
  for (let index = 0; index < projected.length; index += 1) {
    const current = projected[index];
    const next = projected[(index + 1) % projected.length];
    area += current.x * next.y - next.x * current.y;
  }
  return Math.abs(area / 2);
}

function formatControlLockReason(reason: string): string {
  const normalized = reason.trim();
  if (!normalized) return "Robot locked";
  const labels: Record<string, string> = {
    STARTUP_LOCKED: "Robot locked at startup",
    UI_LOCK_REQUEST: "Robot locked from UI",
    UI_HEARTBEAT_TIMEOUT: "Robot locked by missing UI heartbeat",
    DISCONNECTED: "Robot locked until backend confirms unlock",
    LOCKED: "Robot locked"
  };
  return labels[normalized] ?? `Robot locked: ${normalized}`;
}

function normalizeYawDeg(yawDeg: number): number {
  let yaw = Number(yawDeg || 0);
  while (yaw <= -180) yaw += 360;
  while (yaw > 180) yaw -= 360;
  return yaw;
}

function yawDegFromLatLng(origin: L.LatLng, target: L.LatLng): number {
  const refLat = Number(origin.lat);
  const metersPerDegLat = 111320;
  const metersPerDegLon = metersPerDegLat * Math.max(1e-6, Math.abs(Math.cos((refLat * Math.PI) / 180)));
  const eastM = (Number(target.lng) - Number(origin.lng)) * metersPerDegLon;
  const northM = (Number(target.lat) - Number(origin.lat)) * metersPerDegLat;
  return normalizeYawDeg((Math.atan2(northM, eastM) * 180) / Math.PI);
}

function buildWaypointIcon(index: number, yawDeg: number, draft = false, selected = false): L.DivIcon {
  const yaw = normalizeYawDeg(yawDeg);
  const cssRotationDeg = normalizeYawDeg(90 - yaw);
  const cls = `wp-icon${draft ? " draft" : ""}${selected ? " selected" : ""}`;
  return L.divIcon({
    className: "",
    html:
      `<div class="${cls}" style="transform: rotate(${cssRotationDeg}deg);">` +
      '<div class="wp-arrow"></div>' +
      `<div class="wp-index">${Number(index) + 1}</div>` +
      "</div>",
    iconSize: [30, 30],
    iconAnchor: [15, 15]
  });
}

function buildRobotIcon(headingDeg: number | null | undefined): L.DivIcon {
  const hasHeading = headingDeg !== null && headingDeg !== undefined && Number.isFinite(Number(headingDeg));
  const yaw = hasHeading ? normalizeYawDeg(Number(headingDeg)) : 0;
  const cssRotationDeg = normalizeYawDeg(90 - yaw);
  const classes = hasHeading ? "robot-icon" : "robot-icon no-heading";
  return L.divIcon({
    className: "",
    html: `<div class="${classes}" style="transform: rotate(${cssRotationDeg}deg);"><div class="robot-arrow"></div></div>`,
    iconSize: [40, 40],
    iconAnchor: [20, 20]
  });
}

function isMapBackgroundPointerEvent(domEvent: MouseEvent): boolean {
  const target = domEvent.target;
  if (!(target instanceof Element)) return false;
  if (target.closest(".wp-icon")) return false;
  if (target.closest(".leaflet-marker-icon")) return false;
  if (target.closest(".leaflet-control-container")) return false;
  if (target.closest(".leaflet-popup-pane")) return false;
  if (target.closest(".leaflet-draw-tooltip")) return false;
  if (target.closest(".leaflet-interactive")) return false;
  return true;
}

function LeafletMapCanvas({
  state,
  mapService,
  runtime,
  interactive,
  goalMode,
  waypoints,
  selectedWaypointIndexes,
  robotPose,
  centerRequestKey,
  onQueueWaypoint,
  onToggleWaypointSelection,
  onMoveWaypoint
}: {
  state: MapWorkspaceState;
  mapService: MapService;
  runtime: ModuleContext;
  interactive: boolean;
  goalMode: boolean;
  waypoints: NavigationState["waypoints"];
  selectedWaypointIndexes: number[];
  robotPose: TelemetrySnapshot["robotPose"];
  centerRequestKey: number;
  onQueueWaypoint: (lat: number, lon: number, yawDeg: number) => void;
  onToggleWaypointSelection: (index: number) => void;
  onMoveWaypoint: (index: number, lat: number, lon: number) => void;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const drawnItemsRef = useRef<L.FeatureGroup | null>(null);
  const waypointLayerRef = useRef<L.LayerGroup | null>(null);
  const draftLayerRef = useRef<L.LayerGroup | null>(null);
  const robotMarkerRef = useRef<L.Marker | null>(null);
  const draftMarkerRef = useRef<L.Marker | null>(null);
  const goalDraftRef = useRef<{ lat: number; lon: number; yawDeg: number; dragYaw: boolean } | null>(null);
  const goalCreateSessionRef = useRef<{ active: boolean; hasMoved: boolean }>({ active: false, hasMoved: false });
  const waypointDragEndMsRef = useRef(0);
  const measureLayerRef = useRef<L.LayerGroup | null>(null);
  const measurePointsRef = useRef<L.LatLng[]>([]);
  const inspectCopyHandlersRef = useRef<Array<() => void>>([]);
  const goalModeRef = useRef(goalMode);
  const toolModeRef = useRef(state.toolMode);
  const interactiveRef = useRef(interactive);
  const waypointCountRef = useRef(waypoints.length);
  const onQueueWaypointRef = useRef(onQueueWaypoint);
  const onToggleWaypointSelectionRef = useRef(onToggleWaypointSelection);
  const onMoveWaypointRef = useRef(onMoveWaypoint);
  const appliedMapOriginKeyRef = useRef<string>("");

  useEffect(() => {
    goalModeRef.current = goalMode;
  }, [goalMode]);
  useEffect(() => {
    toolModeRef.current = state.toolMode;
  }, [state.toolMode]);
  useEffect(() => {
    interactiveRef.current = interactive;
  }, [interactive]);
  useEffect(() => {
    waypointCountRef.current = waypoints.length;
  }, [waypoints.length]);
  useEffect(() => {
    onQueueWaypointRef.current = onQueueWaypoint;
  }, [onQueueWaypoint]);
  useEffect(() => {
    onToggleWaypointSelectionRef.current = onToggleWaypointSelection;
  }, [onToggleWaypointSelection]);
  useEffect(() => {
    onMoveWaypointRef.current = onMoveWaypoint;
  }, [onMoveWaypoint]);

  const clearGoalDraft = (): void => {
    goalDraftRef.current = null;
    goalCreateSessionRef.current = { active: false, hasMoved: false };
    draftLayerRef.current?.clearLayers();
    draftMarkerRef.current = null;
    const map = mapRef.current;
    if (interactiveRef.current && map && !map.dragging.enabled()) {
      map.dragging.enable();
    }
  };

  const renderGoalDraft = (): void => {
    const layer = draftLayerRef.current;
    const draft = goalDraftRef.current;
    if (!layer || !draft) {
      layer?.clearLayers();
      draftMarkerRef.current = null;
      return;
    }
    layer.clearLayers();
    const marker = L.marker([draft.lat, draft.lon], {
      icon: buildWaypointIcon(waypointCountRef.current, draft.yawDeg, true, false),
      interactive: false
    });
    marker.addTo(layer);
    draftMarkerRef.current = marker;
  };

  useEffect(() => {
    if (!hostRef.current || mapRef.current) return;
    const map = L.map(hostRef.current, { zoomControl: true }).setView(GPS_DEFAULT_CENTER, GPS_DEFAULT_ZOOM);
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      {
        maxZoom: 26,
        maxNativeZoom: 19,
        detectRetina: true,
        attribution: "Tiles © Esri"
      }
    ).addTo(map);

    const drawnItems = new L.FeatureGroup();
    const waypointLayer = L.layerGroup();
    const draftLayer = L.layerGroup();
    const measureLayer = L.layerGroup();
    map.addLayer(drawnItems);
    map.addLayer(waypointLayer);
    map.addLayer(draftLayer);
    map.addLayer(measureLayer);
    mapRef.current = map;
    drawnItemsRef.current = drawnItems;
    waypointLayerRef.current = waypointLayer;
    draftLayerRef.current = draftLayer;
    measureLayerRef.current = measureLayer;

    const drawControl = new L.Control.Draw({
      edit: {
        featureGroup: drawnItems
      },
      draw: {
        polyline: false,
        rectangle: false,
        circle: false,
        marker: false,
        circlemarker: false,
        polygon: {}
      }
    });
    map.addControl(drawControl);

    map.on(L.Draw.Event.CREATED, (event) => {
      if (toolModeRef.current !== "idle") return;
      const layer = event.layer;
      if (!(layer instanceof L.Polygon)) return;
      const polygon = extractPolygonLatLon(layer);
      const zone = mapService.addZoneFromPolygon(polygon);
      (layer as L.Polygon & { zoneId?: string }).zoneId = zone.id;
      drawnItems.addLayer(layer);
      if (mapService.getState().autoSync) {
        void mapService.pushZonesToBackend().catch((error) => {
          runtime.eventBus.emit("console.event", {
            level: "error",
            text: `set_zones_geojson failed: ${String(error)}`,
            timestamp: Date.now()
          });
        });
      }
    });

    map.on(L.Draw.Event.EDITED, (event: L.LeafletEvent) => {
      const layers = (event as unknown as { layers?: L.LayerGroup }).layers;
      if (!layers) return;
      layers.eachLayer((layer) => {
        if (!(layer instanceof L.Polygon)) return;
        const zoneId = (layer as L.Polygon & { zoneId?: string }).zoneId;
        if (!zoneId) return;
        mapService.setZonePolygon(zoneId, extractPolygonLatLon(layer));
      });
      if (mapService.getState().autoSync) {
        void mapService.pushZonesToBackend().catch(() => undefined);
      }
    });

    map.on(L.Draw.Event.DELETED, (event: L.LeafletEvent) => {
      const layers = (event as unknown as { layers?: L.LayerGroup }).layers;
      if (!layers) return;
      layers.eachLayer((layer) => {
        if (!(layer instanceof L.Polygon)) return;
        const zoneId = (layer as L.Polygon & { zoneId?: string }).zoneId;
        if (!zoneId) return;
        mapService.removeZone(zoneId);
      });
      if (mapService.getState().autoSync) {
        void mapService.pushZonesToBackend().catch(() => undefined);
      }
    });

    map.on("click", (evt: L.LeafletMouseEvent) => {
      if (!interactiveRef.current) return;
      const mode = toolModeRef.current;
      if (mode === "inspect") {
        mapService.setInspectCoords(evt.latlng.lat, evt.latlng.lng);
        const coordsText = `${evt.latlng.lat.toFixed(6)}, ${evt.latlng.lng.toFixed(6)}`;
        const buttonId = `inspect-copy-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
        const popup = L.popup()
          .setLatLng(evt.latlng)
          .setContent(
            `<div class="map-inspect-popup"><div class="coords">${coordsText}</div><button type="button" id="${buttonId}" class="map-inspect-copy">Copy</button></div>`
          );
        popup.openOn(map);
        window.setTimeout(() => {
          const button = document.getElementById(buttonId);
          if (!button) return;
          const onClick = (): void => {
            if (typeof navigator !== "undefined" && navigator.clipboard) {
              void navigator.clipboard.writeText(coordsText);
            }
            runtime.eventBus.emit("console.event", {
              level: "info",
              text: `Inspect copied: ${coordsText}`,
              timestamp: Date.now()
            });
          };
          button.addEventListener("click", onClick, { once: true });
          inspectCopyHandlersRef.current.push(() => button.removeEventListener("click", onClick));
        }, 0);
        return;
      }
      if (mode === "ruler") {
        const points = [...measurePointsRef.current, evt.latlng];
        measurePointsRef.current = points;
        const layer = measureLayerRef.current;
        if (layer) {
          layer.clearLayers();
          points.forEach((point) => {
            L.circleMarker(point, {
              radius: 3,
              color: "#fbd47f",
              weight: 1.5,
              fillColor: "#fbd47f",
              fillOpacity: 0.9
            }).addTo(layer);
          });
          if (points.length > 1) {
            L.polyline(points, { color: "#fbd47f", weight: 2 }).addTo(layer);
          }
        }
        let meters = 0;
        for (let index = 1; index < points.length; index += 1) {
          meters += map.distance(points[index - 1], points[index]);
        }
        mapService.setToolInfo(`Ruler: ${formatDistanceMeters(meters)} (${points.length} puntos)`);
        return;
      }
      if (mode === "area") {
        const points = [...measurePointsRef.current, evt.latlng];
        measurePointsRef.current = points;
        const layer = measureLayerRef.current;
        if (layer) {
          layer.clearLayers();
          points.forEach((point) => {
            L.circleMarker(point, {
              radius: 3,
              color: "#8dd8ff",
              weight: 1.5,
              fillColor: "#8dd8ff",
              fillOpacity: 0.9
            }).addTo(layer);
          });
          if (points.length > 2) {
            L.polygon(points, { color: "#8dd8ff", weight: 2, fillOpacity: 0.2 }).addTo(layer);
          } else if (points.length > 1) {
            L.polyline(points, { color: "#8dd8ff", weight: 2 }).addTo(layer);
          }
        }
        const area = geodesicArea(points);
        mapService.setToolInfo(`Area: ${formatAreaSqMeters(area)} (${points.length} puntos)`);
        return;
      }
    });

    map.on("mousedown", (evt: L.LeafletMouseEvent) => {
      if (!interactiveRef.current) return;
      if (!goalModeRef.current || toolModeRef.current !== "idle") return;
      const domEvent = evt.originalEvent as MouseEvent | undefined;
      if (!domEvent) return;
      if (typeof domEvent.button === "number" && domEvent.button !== 0) return;
      if (!isMapBackgroundPointerEvent(domEvent)) return;
      goalCreateSessionRef.current = { active: true, hasMoved: false };
      goalDraftRef.current = {
        lat: Number(evt.latlng.lat),
        lon: Number(evt.latlng.lng),
        yawDeg: 0,
        dragYaw: false
      };
      if (map.dragging.enabled()) {
        map.dragging.disable();
      }
      renderGoalDraft();
    });

    map.on("mousemove", (evt: L.LeafletMouseEvent) => {
      if (!goalCreateSessionRef.current.active) return;
      const draft = goalDraftRef.current;
      if (!draft) return;
      const origin = L.latLng(draft.lat, draft.lon);
      const distanceM = map.distance(origin, evt.latlng);
      const dragYaw = distanceM > 0.35;
      draft.dragYaw = dragYaw;
      if (dragYaw) {
        draft.yawDeg = yawDegFromLatLng(origin, evt.latlng);
        goalCreateSessionRef.current.hasMoved = true;
      }
      renderGoalDraft();
    });

    map.on("mouseup", () => {
      if (!goalCreateSessionRef.current.active) return;
      const draft = goalDraftRef.current;
      clearGoalDraft();
      if (!draft) return;
      onQueueWaypointRef.current(draft.lat, draft.lon, draft.yawDeg);
    });

    return () => {
      clearGoalDraft();
      inspectCopyHandlersRef.current.forEach((cleanup) => cleanup());
      inspectCopyHandlersRef.current = [];
      map.remove();
      mapRef.current = null;
      drawnItemsRef.current = null;
      waypointLayerRef.current = null;
      draftLayerRef.current = null;
      measureLayerRef.current = null;
      robotMarkerRef.current = null;
      draftMarkerRef.current = null;
      measurePointsRef.current = [];
    };
  }, [mapService, runtime.eventBus]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (interactive) {
      map.dragging.enable();
      map.scrollWheelZoom.enable();
      map.doubleClickZoom.enable();
      map.boxZoom.enable();
      map.keyboard.enable();
      map.touchZoom.enable();
      map.zoomControl.addTo(map);
    } else {
      map.dragging.disable();
      map.scrollWheelZoom.disable();
      map.doubleClickZoom.disable();
      map.boxZoom.disable();
      map.keyboard.disable();
      map.touchZoom.disable();
      map.zoomControl.remove();
    }
    window.setTimeout(() => map.invalidateSize(), 0);
  }, [interactive]);

  useEffect(() => {
    const map = mapRef.current;
    const host = hostRef.current;
    if (!map || !host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      map.invalidateSize();
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!state.map) return;
    if (!Number.isFinite(state.map.originLat) || !Number.isFinite(state.map.originLon)) return;
    const nextKey = `${state.map.mapId}:${state.map.originLat}:${state.map.originLon}`;
    if (appliedMapOriginKeyRef.current === nextKey) return;
    appliedMapOriginKeyRef.current = nextKey;
    map.setView([state.map.originLat, state.map.originLon], map.getZoom());
  }, [state.map?.mapId, state.map?.originLat, state.map?.originLon]);

  useEffect(() => {
    const drawnItems = drawnItemsRef.current;
    if (!drawnItems) return;
    drawnItems.clearLayers();
    state.zones.forEach((zone) => {
      const polygon = Array.isArray(zone.polygon) ? zone.polygon : [];
      if (polygon.length < 3) return;
      const layer = L.polygon(
        polygon.map((entry) => [entry.lat, entry.lon]),
        {
          color: zone.enabled === false ? "#64748b" : "#f97316",
          weight: 3,
          fillOpacity: zone.enabled === false ? 0.1 : 0.25
        }
      ) as L.Polygon & { zoneId?: string };
      layer.zoneId = zone.id;
      layer.on("click", () => {
        mapService.toggleZoneEnabled(zone.id);
      });
      drawnItems.addLayer(layer);
    });
  }, [mapService, state.zones]);

  useEffect(() => {
    const layer = waypointLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!Array.isArray(waypoints) || waypoints.length === 0) return;
    const points = waypoints
      .map((waypoint, index) => ({
        index,
        lat: Number(waypoint.x),
        lon: Number(waypoint.y),
        yawDeg: Number(waypoint.yawDeg ?? 0),
        selected: selectedWaypointIndexes.includes(index)
      }))
      .filter((entry) => Number.isFinite(entry.lat) && Number.isFinite(entry.lon));
    if (points.length > 1) {
      L.polyline(
        points.map((entry) => [entry.lat, entry.lon]),
        { color: "#ff8095", weight: 2, opacity: 0.9 }
      ).addTo(layer);
    }
    points.forEach((entry) => {
      const marker = L.marker([entry.lat, entry.lon], {
        icon: buildWaypointIcon(entry.index, entry.yawDeg, false, entry.selected),
        interactive: true,
        draggable: true
      }).bindTooltip(`#${entry.index + 1}`, { direction: "top" });
      marker.on("dragstart", () => {
        const map = mapRef.current;
        if (map?.dragging.enabled()) {
          map.dragging.disable();
        }
      });
      marker.on("dragend", () => {
        const latLng = marker.getLatLng();
        onMoveWaypointRef.current(entry.index, Number(latLng.lat), Number(latLng.lng));
        waypointDragEndMsRef.current = Date.now();
        const map = mapRef.current;
        if (interactiveRef.current && map && !map.dragging.enabled()) {
          map.dragging.enable();
        }
      });
      marker.on("click", () => {
        if (Date.now() - waypointDragEndMsRef.current < 250) return;
        onToggleWaypointSelectionRef.current(entry.index);
      });
      marker.addTo(layer);
    });
  }, [selectedWaypointIndexes, waypoints]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!robotPose) {
      if (robotMarkerRef.current) {
        map.removeLayer(robotMarkerRef.current);
        robotMarkerRef.current = null;
      }
      return;
    }
    const latLng = L.latLng(robotPose.lat, robotPose.lon);
    if (!robotMarkerRef.current) {
      robotMarkerRef.current = L.marker(latLng, {
        icon: buildRobotIcon(robotPose.headingDeg),
        interactive: false
      }).addTo(map);
      return;
    }
    robotMarkerRef.current.setLatLng(latLng);
    robotMarkerRef.current.setIcon(buildRobotIcon(robotPose.headingDeg));
  }, [robotPose]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !robotPose || centerRequestKey <= 0) return;
    map.setView([robotPose.lat, robotPose.lon], Math.max(map.getZoom(), 17));
  }, [centerRequestKey, robotPose]);

  useEffect(() => {
    if (state.toolMode !== "idle") {
      clearGoalDraft();
    }
    measurePointsRef.current = [];
    measureLayerRef.current?.clearLayers();
  }, [state.toolMode]);

  useEffect(() => {
    if (!goalMode) {
      clearGoalDraft();
    }
  }, [goalMode]);

  return <div ref={hostRef} className="leaflet-host map-host-canvas" />;
}

function MapWorkspaceView({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const mapService = runtime.registries.serviceRegistry.getService<MapService>(SERVICE_ID);
  let navigationService: NavigationService | null = null;
  try {
    navigationService = runtime.registries.serviceRegistry.getService<NavigationService>(NAVIGATION_SERVICE_ID);
  } catch {
    navigationService = null;
  }
  let connectionService: ConnectionService | null = null;
  try {
    connectionService = runtime.registries.serviceRegistry.getService<ConnectionService>(CONNECTION_SERVICE_ID);
  } catch {
    connectionService = null;
  }
  let telemetryService: TelemetryServiceLike | null = null;
  try {
    telemetryService = runtime.registries.serviceRegistry.getService<TelemetryServiceLike>(TELEMETRY_SERVICE_ID);
  } catch {
    telemetryService = null;
  }
  const [state, setState] = useState<MapWorkspaceState>(mapService.getState());
  const [mainPane, setMainPane] = useState<"map" | "camera">("map");
  const [frameSrc, setFrameSrc] = useState("");
  const [frameReady, setFrameReady] = useState(false);
  const [centerRequestKey, setCenterRequestKey] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [navigationState, setNavigationState] = useState<NavigationState | null>(
    navigationService ? navigationService.getState() : null
  );
  const [connectionState, setConnectionState] = useState<ConnectionState | null>(
    connectionService ? connectionService.getState() : null
  );
  const [telemetrySnapshot, setTelemetrySnapshot] = useState<TelemetrySnapshot | null>(
    telemetryService ? telemetryService.getSnapshot() : null
  );

  useEffect(() => mapService.subscribe((next) => setState(next)), [mapService]);
  useEffect(() => {
    void mapService.loadMap("default-map").catch(() => undefined);
  }, [mapService]);
  useEffect(() => {
    if (!navigationService) return;
    return navigationService.subscribe((next) => setNavigationState(next));
  }, [navigationService]);
  useEffect(() => {
    if (!connectionService) return;
    return connectionService.subscribe((next) => setConnectionState(next));
  }, [connectionService]);
  useEffect(() => {
    if (!telemetryService) return;
    return telemetryService.subscribeTelemetry((next) => setTelemetrySnapshot(next));
  }, [telemetryService]);
  useEffect(() => {
    return runtime.eventBus.on(NAV_EVENTS.swapWorkspaceRequest, () => {
      setMainPane((current) => (current === "map" ? "camera" : "map"));
    });
  }, [runtime]);

  const mainIsMap = mainPane === "map";
  const cameraEnabled = connectionService?.isCameraEnabled() ?? false;
  const cameraUrl = connectionService?.getCameraIframeUrl() ?? "";
  const cameraStreamConnected = navigationState?.cameraStreamConnected === true;
  const controlsLocked = navigationState?.controlLocked ?? true;
  const mapInteractive = mainIsMap;
  const mapToolsEnabled = mainIsMap;

  useEffect(() => {
    if (!cameraStreamConnected || !cameraEnabled || !cameraUrl) {
      setFrameSrc("");
      setFrameReady(false);
      return;
    }
    const separator = cameraUrl.includes("?") ? "&" : "?";
    setFrameSrc(`${cameraUrl}${separator}_ts=${Date.now()}`);
    setFrameReady(false);
  }, [cameraEnabled, cameraStreamConnected, cameraUrl]);

  useEffect(() => {
    if (mainIsMap) return;
    if (state.toolMode === "idle") return;
    mapService.setToolMode("idle");
  }, [mainIsMap, mapService, state.toolMode]);
  useEffect(() => {
    const graceUntil = navigationState?.unlockGraceUntilMs ?? 0;
    if (graceUntil <= Date.now()) return;
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 250);
    return () => {
      window.clearInterval(timer);
    };
  }, [navigationState?.unlockGraceUntilMs]);
  const cameraOverlayText = !cameraEnabled
    ? connectionState?.preset === "sim"
      ? "camera disabled in sim"
      : "camera unavailable"
    : !cameraStreamConnected
      ? "camara desconectada"
      : frameReady
        ? ""
        : "camera connecting";
  const unlockGraceRemainingMs = Math.max(0, (navigationState?.unlockGraceUntilMs ?? 0) - nowMs);
  const unlockGraceSeconds = (unlockGraceRemainingMs / 1000).toFixed(1);
  const lockReasonText = formatControlLockReason(navigationState?.controlLockReason ?? "");

  const selectTool = (tool: MapToolMode, infoLabel: string): void => {
    if (!mapToolsEnabled) {
      runtime.eventBus.emit("console.event", {
        level: "warn",
        text: "Map tools available only with map as main view",
        timestamp: Date.now()
      });
      return;
    }
    mapService.setToolMode(tool);
    runtime.eventBus.emit("console.event", {
      level: "info",
      text: `Map tool: ${infoLabel}`,
      timestamp: Date.now()
    });
  };

  const queueWaypointFromMap = (lat: number, lon: number, yawDeg: number): void => {
    if (!navigationService || !navigationState?.goalMode) return;
    navigationService.queueWaypoint({
      x: lat,
      y: lon,
      yawDeg
    });
    runtime.eventBus.emit("console.event", {
      level: "info",
      text: `Waypoint queued from map (${lat.toFixed(6)}, ${lon.toFixed(6)}) yaw=${yawDeg.toFixed(1)}°`,
      timestamp: Date.now()
    });
  };

  const toggleWaypointSelectionFromMap = (index: number): void => {
    if (!navigationService) return;
    navigationService.toggleWaypointSelection(index);
  };

  const moveWaypointFromMap = (index: number, lat: number, lon: number): void => {
    if (!navigationService) return;
    navigationService.moveWaypoint(index, lat, lon);
    runtime.eventBus.emit("console.event", {
      level: "info",
      text: `Waypoint ${index + 1} moved to (${lat.toFixed(6)}, ${lon.toFixed(6)})`,
      timestamp: Date.now()
    });
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!mainIsMap || !mapToolsEnabled || isEditingTarget(event.target)) return;
      if (event.key === "Escape" && state.toolMode !== "idle") {
        mapService.setToolMode("idle");
        event.preventDefault();
        return;
      }
      if (event.code === "Digit1") {
        selectTool("ruler", "ruler");
        event.preventDefault();
        return;
      }
      if (event.code === "Digit2") {
        selectTool("area", "area");
        event.preventDefault();
        return;
      }
      if (event.code === "Digit3") {
        selectTool("inspect", "inspect");
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [mainIsMap, mapToolsEnabled, mapService, selectTool, state.toolMode]);

  return (
    <div className="map-workspace-root">
      <div className={`stage map-stage ${mainIsMap ? "mode-gps-main" : "mode-camera-main"}`}>
        <section className={`stage-pane ${mainIsMap ? "main" : "mini"} map-stage-pane`}>
          <h4>Map</h4>
          <div className="map-canvas map-pane-canvas">
            <LeafletMapCanvas
              state={state}
              mapService={mapService}
              runtime={runtime}
              interactive={mapInteractive}
              goalMode={navigationState?.goalMode === true}
              waypoints={navigationState?.waypoints ?? []}
              selectedWaypointIndexes={navigationState?.selectedWaypointIndexes ?? []}
              robotPose={telemetrySnapshot?.robotPose ?? null}
              centerRequestKey={centerRequestKey}
              onQueueWaypoint={queueWaypointFromMap}
              onToggleWaypointSelection={toggleWaypointSelectionFromMap}
              onMoveWaypoint={moveWaypointFromMap}
            />
            <div className={`map-overlay-tools ${mainIsMap ? "" : "hidden"}`}>
              <div className="map-tool-status">{state.toolInfo}</div>
              <div className="map-toolbar map-toolbar-icons">
                <button
                  type="button"
                  className={toolButtonClass(state.toolMode, "ruler")}
                  onClick={() => selectTool("ruler", "ruler")}
                  title="Ruler"
                  aria-label="Ruler"
                  disabled={!mapToolsEnabled}
                >
                  📏
                </button>
                <button
                  type="button"
                  className={toolButtonClass(state.toolMode, "area")}
                  onClick={() => selectTool("area", "area")}
                  title="Area"
                  aria-label="Area"
                  disabled={!mapToolsEnabled}
                >
                  📐
                </button>
                <button
                  type="button"
                  className={toolButtonClass(state.toolMode, "inspect")}
                  onClick={() => selectTool("inspect", "inspect")}
                  title="Inspect"
                  aria-label="Inspect"
                  disabled={!mapToolsEnabled}
                >
                  📍
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCenterRequestKey((value) => value + 1);
                    mapService.centerRobot();
                    runtime.eventBus.emit("console.event", {
                      level: "info",
                      text: "Map centered on robot",
                      timestamp: Date.now()
                    });
                  }}
                  title="Center robot"
                  aria-label="Center robot"
                  disabled={!mapToolsEnabled}
                >
                  🎯
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
                  title="Set datum"
                  aria-label="Set datum"
                  disabled={!mapToolsEnabled}
                >
                  🧲
                </button>
                <button
                  type="button"
                  onClick={() => selectTool("idle", "idle")}
                  title="Close tools"
                  aria-label="Close tools"
                  disabled={!mapToolsEnabled}
                >
                  ❌
                </button>
              </div>
            </div>
          </div>
        </section>
        <section className={`stage-pane ${mainIsMap ? "mini" : "main"} map-camera-stage-pane`}>
          <h4>Camera</h4>
          <div className="camera-frame-wrap">
            <iframe
              className="camera-frame"
              src={frameSrc}
              title="Camera feed"
              loading="lazy"
              onLoad={() => setFrameReady(true)}
            />
            {cameraOverlayText ? <div className="camera-overlay visible">{cameraOverlayText}</div> : null}
          </div>
        </section>
        <button type="button" className="swap-btn" onClick={() => setMainPane(mainIsMap ? "camera" : "map")}>
          🔄
        </button>
        {controlsLocked ? (
          <div className="view-stage-unlock-overlay">
            <button
              type="button"
              className="view-stage-unlock-btn"
              disabled={!navigationService}
              onClick={async () => {
                if (!navigationService) return;
                try {
                  await navigationService.unlockControls();
                  runtime.eventBus.emit("console.event", {
                    level: "info",
                    text: "Controls unlocked",
                    timestamp: Date.now()
                  });
                } catch (error) {
                  runtime.eventBus.emit("console.event", {
                    level: "error",
                    text: `Unlock failed: ${String(error)}`,
                    timestamp: Date.now()
                  });
                }
              }}
            >
              <span className="view-stage-unlock-icon" aria-hidden="true">
                🔒
              </span>
              <span>Desbloquear</span>
            </button>
            <div className="view-stage-unlock-note">{lockReasonText}</div>
          </div>
        ) : (
          <div className="stage-actions">
            <button
              type="button"
              disabled={!navigationService || !cameraEnabled}
              onClick={() => {
                if (!navigationService) return;
                const connected = navigationService.toggleCameraStream();
                runtime.eventBus.emit("console.event", {
                  level: "info",
                  text: connected ? "Camera stream connected" : "Camera stream disconnected",
                  timestamp: Date.now()
                });
              }}
            >
              {cameraStreamConnected ? "Disconnect camera" : "Connect camera"}
            </button>
            <button
              type="button"
              disabled={!navigationService}
              onClick={async () => {
                if (!navigationService) return;
                try {
                  await navigationService.lockControls();
                  runtime.eventBus.emit("console.event", {
                    level: "info",
                    text: "Controls locked",
                    timestamp: Date.now()
                  });
                } catch (error) {
                  runtime.eventBus.emit("console.event", {
                    level: "error",
                    text: `Lock failed: ${String(error)}`,
                    timestamp: Date.now()
                  });
                }
              }}
            >
              Lock controls
            </button>
            {unlockGraceRemainingMs > 0 ? (
              <div className="stage-unlock-grace">Unlock grace: {unlockGraceSeconds}s</div>
            ) : null}
          </div>
        )}
        {mainIsMap ? null : <div className="stage-gps-mini-badge">Map minimapa</div>}
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
