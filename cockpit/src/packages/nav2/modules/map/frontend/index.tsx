import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet-draw";
import "leaflet-draw/dist/leaflet.draw.css";
import "./styles.css";
import { CORE_EVENTS, NAV_EVENTS } from "../../../../../core/events/topics";
import type { CockpitModule, ModuleContext } from "../../../../../core/types/module";
import { MapDispatcher } from "../dispatcher/impl/MapDispatcher";
import { ConnectionService, type ConnectionState } from "../../navigation/service/impl/ConnectionService";
import { MapService, type MapToolMode, type MapWorkspaceState } from "../service/impl/MapService";
import { NavigationService, type NavigationState } from "../../navigation/service/impl/NavigationService";
import type { SensorInfoService, SensorInfoState } from "../../navigation/service/impl/SensorInfoService";
import type { TelemetrySnapshot } from "../../telemetry/service/impl/TelemetryService";
import { calculateProtractorAngleDeg, snapToCartesianAxis } from "./protractor";

const TRANSPORT_ID = "transport.ws.core";
const DISPATCHER_ID = "dispatcher.map";
const SERVICE_ID = "service.map";
const NAVIGATION_SERVICE_ID = "service.navigation";
const CONNECTION_SERVICE_ID = "service.connection";
const TELEMETRY_SERVICE_ID = "service.telemetry";
const SENSOR_INFO_SERVICE_ID = "service.sensor-info";
const GPS_NATIVE_MAX_ZOOM = 19;
const GPS_DEFAULT_ZOOM = GPS_NATIVE_MAX_ZOOM - 3;
const GPS_DEFAULT_CENTER: L.LatLngTuple = [-31.4201, -64.1888];
const MAP_WHEEL_PX_PER_ZOOM_LEVEL = 160;
const MAP_WHEEL_DEBOUNCE_MS = 80;
const MAP_TOOL_COLOR = "#55ff7f";
const PROTRACTOR_MIN_ARM_METERS = 0.05;
const PROTRACTOR_SNAP_THRESHOLD_DEG = 12;

interface MapViewportControlHandle {
  zoomIn: () => void;
  zoomOut: () => void;
}

interface Nav2MapConfig {
  map_default_center_lat?: unknown;
  map_default_center_lon?: unknown;
  map_default_zoom?: unknown;
  camera_probe_timeout_ms?: unknown;
  camera_load_timeout_ms?: unknown;
}

function readNav2MapConfig(runtime: ModuleContext): Nav2MapConfig {
  return runtime.getPackageConfig<Record<string, unknown>>("nav2") as Nav2MapConfig;
}

function parseFinite(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseCenter(config: Nav2MapConfig): L.LatLngTuple {
  const lat = parseFinite(config.map_default_center_lat, GPS_DEFAULT_CENTER[0]);
  const lon = parseFinite(config.map_default_center_lon, GPS_DEFAULT_CENTER[1]);
  return [Math.max(-90, Math.min(90, lat)), Math.max(-180, Math.min(180, lon))];
}

function parseZoom(config: Nav2MapConfig): number {
  const parsed = Math.round(parseFinite(config.map_default_zoom, GPS_DEFAULT_ZOOM));
  return Math.max(0, Math.min(GPS_NATIVE_MAX_ZOOM, parsed));
}

function parseCameraProbeTimeout(config: Nav2MapConfig, runtime: ModuleContext): number {
  const fallback = Math.max(500, Number(runtime.env.cameraProbeTimeoutMs ?? 3000));
  const parsed = Number(config.camera_probe_timeout_ms);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(500, Math.round(parsed));
}

function parseCameraLoadTimeout(config: Nav2MapConfig, runtime: ModuleContext): number {
  const fallback = Math.max(1000, Number(runtime.env.cameraLoadTimeoutMs ?? 7000));
  const parsed = Number(config.camera_load_timeout_ms);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1000, Math.round(parsed));
}

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

function formatAngleDegrees(angleDeg: number): string {
  if (!Number.isFinite(angleDeg)) return "n/a";
  return `${angleDeg.toFixed(1)}°`;
}

function buildProtractorArcGeometry(
  vertex: L.LatLng,
  armA: L.LatLng,
  armB: L.LatLng
): { arcPoints: L.LatLng[]; labelLatLng: L.LatLng | null } {
  const origin = L.CRS.EPSG3857.project(vertex);
  const first = L.CRS.EPSG3857.project(armA);
  const second = L.CRS.EPSG3857.project(armB);

  const firstVec = { x: first.x - origin.x, y: first.y - origin.y };
  const secondVec = { x: second.x - origin.x, y: second.y - origin.y };
  const firstLen = Math.hypot(firstVec.x, firstVec.y);
  const secondLen = Math.hypot(secondVec.x, secondVec.y);
  if (firstLen < PROTRACTOR_MIN_ARM_METERS || secondLen < PROTRACTOR_MIN_ARM_METERS) {
    return { arcPoints: [], labelLatLng: null };
  }

  const startAngle = Math.atan2(firstVec.y, firstVec.x);
  const endAngle = Math.atan2(secondVec.y, secondVec.x);
  let delta = endAngle - startAngle;
  while (delta <= -Math.PI) delta += Math.PI * 2;
  while (delta > Math.PI) delta -= Math.PI * 2;

  const radius = Math.max(1, Math.min(firstLen, secondLen) * 0.45);
  const stepCount = Math.max(8, Math.ceil(Math.abs(delta) / (Math.PI / 24)));
  const arcPoints: L.LatLng[] = [];
  for (let index = 0; index <= stepCount; index += 1) {
    const angle = startAngle + (delta * index) / stepCount;
    const point = new L.Point(origin.x + Math.cos(angle) * radius, origin.y + Math.sin(angle) * radius);
    arcPoints.push(L.CRS.EPSG3857.unproject(point));
  }

  const labelAngle = startAngle + delta / 2;
  const labelRadius = Math.max(1, radius * 0.65);
  const labelPoint = new L.Point(origin.x + Math.cos(labelAngle) * labelRadius, origin.y + Math.sin(labelAngle) * labelRadius);
  return {
    arcPoints,
    labelLatLng: L.CRS.EPSG3857.unproject(labelPoint)
  };
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

interface GeoPoint {
  lat: number;
  lon: number;
}

function metersPerLongitudeDegree(lat: number): number {
  return 111320 * Math.max(1e-6, Math.abs(Math.cos((Number(lat) * Math.PI) / 180)));
}

function geoDeltaMeters(origin: GeoPoint, target: GeoPoint): { eastM: number; northM: number } {
  return {
    eastM: (Number(target.lon) - Number(origin.lon)) * metersPerLongitudeDegree(origin.lat),
    northM: (Number(target.lat) - Number(origin.lat)) * 111320
  };
}

function offsetGeoPoint(origin: GeoPoint, eastM: number, northM: number): GeoPoint {
  return {
    lat: Number(origin.lat) + northM / 111320,
    lon: Number(origin.lon) + eastM / metersPerLongitudeDegree(origin.lat)
  };
}

function distanceBetweenGeoPointsMeters(a: GeoPoint, b: GeoPoint): number {
  const delta = geoDeltaMeters(a, b);
  return Math.hypot(delta.eastM, delta.northM);
}

function planarAreaSqMeters(points: GeoPoint[]): number {
  if (points.length < 3) return 0;
  const origin = points[0];
  const projected = points.map((point) => geoDeltaMeters(origin, point));
  let area = 0;
  for (let index = 0; index < projected.length; index += 1) {
    const current = projected[index];
    const next = projected[(index + 1) % projected.length];
    area += current.eastM * next.northM - next.eastM * current.northM;
  }
  return Math.abs(area / 2);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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
  const cssRotationDeg = normalizeYawDeg(-yaw);
  const classes = hasHeading ? "robot-icon" : "robot-icon no-heading";
  const robotSvg =
    '<svg class="robot-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M5 12h11" />' +
    '<path d="m12 7 6 5-6 5" />' +
    '<path d="M5 12a7 7 0 0 1 7-7" opacity="0.35" />' +
    "</svg>";
  return L.divIcon({
    className: "",
    html: `<div class="${classes}" style="transform: rotate(${cssRotationDeg}deg);">${robotSvg}</div>`,
    iconSize: [40, 40],
    iconAnchor: [20, 20]
  });
}

function buildDatumIcon(): L.DivIcon {
  const datumSvg =
    '<svg class="datum-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="3.2" />' +
    '<path d="M12 4v4" />' +
    '<path d="M12 16v4" />' +
    '<path d="M4 12h4" />' +
    '<path d="M16 12h4" />' +
    "</svg>";
  return L.divIcon({
    className: "",
    html: `<div class="datum-icon">${datumSvg}</div>`,
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
  datumPose,
  centerRequestKey,
  onQueueWaypoint,
  onToggleWaypointSelection,
  onMoveWaypoint,
  initialCenterLat,
  initialCenterLon,
  initialZoom,
  onZoomChange,
  mapControlRef
}: {
  state: MapWorkspaceState;
  mapService: MapService;
  runtime: ModuleContext;
  interactive: boolean;
  goalMode: boolean;
  waypoints: NavigationState["waypoints"];
  selectedWaypointIndexes: number[];
  robotPose: TelemetrySnapshot["robotPose"];
  datumPose: { lat: number; lon: number } | null;
  centerRequestKey: number;
  onQueueWaypoint: (lat: number, lon: number, yawDeg: number) => void;
  onToggleWaypointSelection: (index: number) => void;
  onMoveWaypoint: (index: number, lat: number, lon: number) => void;
  initialCenterLat: number;
  initialCenterLon: number;
  initialZoom: number;
  onZoomChange?: (zoom: number) => void;
  mapControlRef?: { current: MapViewportControlHandle | null };
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const drawnItemsRef = useRef<L.FeatureGroup | null>(null);
  const waypointLayerRef = useRef<L.LayerGroup | null>(null);
  const draftLayerRef = useRef<L.LayerGroup | null>(null);
  const robotMarkerRef = useRef<L.Marker | null>(null);
  const datumMarkerRef = useRef<L.Marker | null>(null);
  const draftMarkerRef = useRef<L.Marker | null>(null);
  const goalDraftRef = useRef<{ lat: number; lon: number; yawDeg: number; dragYaw: boolean } | null>(null);
  const goalCreateSessionRef = useRef<{ active: boolean; hasMoved: boolean }>({ active: false, hasMoved: false });
  const waypointDragEndMsRef = useRef(0);
  const waypointRenderKeyRef = useRef("");
  const toolDraftLayerRef = useRef<L.LayerGroup | null>(null);
  const toolDrawingsLayerRef = useRef<L.LayerGroup | null>(null);
  const measureTooltipRef = useRef<L.Tooltip | null>(null);
  const mapToolPreviewLatLngRef = useRef<L.LatLng | null>(null);
  const centerRequestHandledRef = useRef(0);
  const measurePointsRef = useRef<L.LatLng[]>([]);
  const protractorVertexRef = useRef<L.LatLng | null>(null);
  const protractorArm1Ref = useRef<L.LatLng | null>(null);
  const hasCompletedDrawingRef = useRef(false);
  const completedDrawingToolRef = useRef<"ruler" | "area" | "protractor" | null>(null);
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

  const clearMeasureTooltip = (): void => {
    const map = mapRef.current;
    const tooltip = measureTooltipRef.current;
    if (map && tooltip && map.hasLayer(tooltip)) {
      map.removeLayer(tooltip);
    }
    measureTooltipRef.current = null;
  };

  const setMeasureTooltip = (latLng: L.LatLng, text: string): void => {
    const map = mapRef.current;
    if (!map) return;
    if (!measureTooltipRef.current) {
      measureTooltipRef.current = L.tooltip({
        permanent: false,
        direction: "top",
        offset: [0, -8],
        className: "map-measure-tooltip"
      });
    }
    const tooltip = measureTooltipRef.current;
    tooltip.setLatLng(latLng).setContent(text);
    if (!map.hasLayer(tooltip)) {
      tooltip.addTo(map);
    }
  };

  const setToolLegend = (mode: MapToolMode): void => {
    if (mode === "ruler") {
      mapService.setToolInfo("Regla activa. Click agrega, doble click cierra.");
      return;
    }
    if (mode === "area") {
      mapService.setToolInfo("Area activa. Click agrega, doble click cierra.");
      return;
    }
    if (mode === "inspect") {
      mapService.setToolInfo("Inspeccion activa. Click inspecciona coordenadas.");
      return;
    }
    if (mode === "protractor") {
      mapService.setToolInfo("Transportador activo. Click define vertice. Shift alinea ejes.");
      return;
    }
  };

  const clearMeasureDraft = (): void => {
    mapToolPreviewLatLngRef.current = null;
    measurePointsRef.current = [];
    protractorVertexRef.current = null;
    protractorArm1Ref.current = null;
    clearMeasureTooltip();
    toolDraftLayerRef.current?.clearLayers();
  };

  const clearToolDrawings = (): void => {
    clearMeasureDraft();
    toolDrawingsLayerRef.current?.clearLayers();
    hasCompletedDrawingRef.current = false;
    completedDrawingToolRef.current = null;
  };

  const collectMeasurePoints = (closingPoint: L.LatLng | null): L.LatLng[] => {
    const map = mapRef.current;
    const next = [...measurePointsRef.current];
    if (!closingPoint) return next;
    const last = next[next.length - 1];
    if (!last || !map || map.distance(last, closingPoint) >= 0.05) {
      next.push(closingPoint);
    }
    return next;
  };

  const resolveProtractorPoint = (latLng: L.LatLng, shiftPressed: boolean): L.LatLng => {
    if (!shiftPressed) return latLng;
    const vertex = protractorVertexRef.current;
    if (!vertex) return latLng;
    return snapToCartesianAxis(vertex, latLng, PROTRACTOR_SNAP_THRESHOLD_DEG, PROTRACTOR_MIN_ARM_METERS);
  };

  const markSingleDrawing = (tool: "ruler" | "area" | "protractor"): void => {
    hasCompletedDrawingRef.current = true;
    completedDrawingToolRef.current = tool;
  };

  const finalizeRulerMeasure = (closingPoint: L.LatLng | null): void => {
    const map = mapRef.current;
    const layer = toolDrawingsLayerRef.current;
    if (!map || !layer) return;
    const points = collectMeasurePoints(closingPoint);
    if (points.length < 2) return;
    layer.clearLayers();
    points.forEach((point) => {
      layer.addLayer(
        L.circleMarker(point, {
          radius: 3,
          color: MAP_TOOL_COLOR,
          weight: 1.5,
          fillColor: MAP_TOOL_COLOR,
          fillOpacity: 0.9,
          interactive: false
        })
      );
    });
    layer.addLayer(
      L.polyline(points, {
        color: MAP_TOOL_COLOR,
        weight: 2.5,
        interactive: false
      })
    );
    markSingleDrawing("ruler");
    clearMeasureDraft();
    setToolLegend("ruler");
  };

  const finalizeAreaMeasure = (closingPoint: L.LatLng | null): void => {
    const layer = toolDrawingsLayerRef.current;
    if (!layer) return;
    const points = collectMeasurePoints(closingPoint);
    if (points.length < 3) return;
    layer.clearLayers();
    points.forEach((point) => {
      layer.addLayer(
        L.circleMarker(point, {
          radius: 3,
          color: MAP_TOOL_COLOR,
          weight: 1.5,
          fillColor: MAP_TOOL_COLOR,
          fillOpacity: 0.9,
          interactive: false
        })
      );
    });
    layer.addLayer(
      L.polygon(points, {
        color: MAP_TOOL_COLOR,
        weight: 2.5,
        fillOpacity: 0.18,
        interactive: false
      })
    );
    markSingleDrawing("area");
    clearMeasureDraft();
    setToolLegend("area");
  };

  const finalizeProtractorMeasure = (closingPoint: L.LatLng | null): void => {
    const layer = toolDrawingsLayerRef.current;
    const vertex = protractorVertexRef.current;
    const arm1 = protractorArm1Ref.current;
    if (!layer || !vertex || !arm1 || !closingPoint) return;
    const angle = calculateProtractorAngleDeg(vertex, arm1, closingPoint, PROTRACTOR_MIN_ARM_METERS);
    if (angle === null) {
      mapService.setToolInfo("Transportador invalido. Brazo demasiado corto.");
      return;
    }
    const angleText = formatAngleDegrees(angle);
    const { arcPoints, labelLatLng } = buildProtractorArcGeometry(vertex, arm1, closingPoint);
    layer.clearLayers();
    layer.addLayer(
      L.circleMarker(vertex, {
        radius: 3,
        color: MAP_TOOL_COLOR,
        weight: 1.5,
        fillColor: MAP_TOOL_COLOR,
        fillOpacity: 0.9,
        interactive: false
      })
    );
    layer.addLayer(
      L.polyline([vertex, arm1], {
        color: MAP_TOOL_COLOR,
        weight: 2.5,
        interactive: false
      })
    );
    layer.addLayer(
      L.polyline([vertex, closingPoint], {
        color: MAP_TOOL_COLOR,
        weight: 2.5,
        interactive: false
      })
    );
    if (arcPoints.length > 1) {
      layer.addLayer(
        L.polyline(arcPoints, {
          color: MAP_TOOL_COLOR,
          weight: 2,
          interactive: false
        })
      );
    }
    if (labelLatLng) {
      layer.addLayer(
        L.marker(labelLatLng, {
          interactive: false,
          icon: L.divIcon({
            className: "",
            html: `<div class="map-protractor-label">${angleText}</div>`,
            iconSize: [72, 20],
            iconAnchor: [36, 10]
          })
        })
      );
    }
    markSingleDrawing("protractor");
    protractorVertexRef.current = null;
    protractorArm1Ref.current = null;
    mapToolPreviewLatLngRef.current = null;
    clearMeasureTooltip();
    toolDraftLayerRef.current?.clearLayers();
    setToolLegend("protractor");
  };

  const renderRulerMeasure = (preview: L.LatLng | null): void => {
    const map = mapRef.current;
    const layer = toolDraftLayerRef.current;
    if (!map || !layer) return;
    const points = [...measurePointsRef.current];
    layer.clearLayers();
    points.forEach((point) => {
      L.circleMarker(point, {
        radius: 3,
        color: MAP_TOOL_COLOR,
        weight: 1.5,
        fillColor: MAP_TOOL_COLOR,
        fillOpacity: 0.9
      }).addTo(layer);
    });

    const displayPoints = preview && points.length > 0 ? [...points, preview] : points;
    if (points.length > 1) {
      L.polyline(points, { color: MAP_TOOL_COLOR, weight: 2 }).addTo(layer);
    }
    if (preview && points.length > 0) {
      L.polyline([points[points.length - 1], preview], { color: MAP_TOOL_COLOR, weight: 2, dashArray: "5 5" }).addTo(layer);
    }

    let meters = 0;
    for (let index = 1; index < displayPoints.length; index += 1) {
      meters += map.distance(displayPoints[index - 1], displayPoints[index]);
    }
    mapService.setToolInfo(`Ruler: ${formatDistanceMeters(meters)} (${displayPoints.length} puntos)`);
    if (preview && points.length > 0) {
      setMeasureTooltip(preview, formatDistanceMeters(meters));
    } else {
      clearMeasureTooltip();
    }
  };

  const renderAreaMeasure = (preview: L.LatLng | null): void => {
    const map = mapRef.current;
    const layer = toolDraftLayerRef.current;
    if (!map || !layer) return;
    const points = [...measurePointsRef.current];
    layer.clearLayers();
    points.forEach((point) => {
      L.circleMarker(point, {
        radius: 3,
        color: MAP_TOOL_COLOR,
        weight: 1.5,
        fillColor: MAP_TOOL_COLOR,
        fillOpacity: 0.9
      }).addTo(layer);
    });

    const drawPoints = preview && points.length > 0 ? [...points, preview] : points;
    if (drawPoints.length > 2) {
      L.polygon(drawPoints, { color: MAP_TOOL_COLOR, weight: 2, fillOpacity: 0.2 }).addTo(layer);
    } else if (drawPoints.length > 1) {
      L.polyline(drawPoints, { color: MAP_TOOL_COLOR, weight: 2 }).addTo(layer);
    }

    let perimeter = 0;
    for (let index = 1; index < drawPoints.length; index += 1) {
      perimeter += map.distance(drawPoints[index - 1], drawPoints[index]);
    }
    if (drawPoints.length > 2) {
      perimeter += map.distance(drawPoints[drawPoints.length - 1], drawPoints[0]);
    }
    const area = drawPoints.length > 2 ? geodesicArea(drawPoints) : 0;
    mapService.setToolInfo(`Area ${formatAreaSqMeters(area)} · Perim ${formatDistanceMeters(perimeter)}`);
    if (preview && points.length > 0) {
      setMeasureTooltip(preview, `${formatAreaSqMeters(area)} · ${formatDistanceMeters(perimeter)}`);
    } else {
      clearMeasureTooltip();
    }
  };

  const renderProtractorMeasure = (preview: L.LatLng | null): void => {
    const layer = toolDraftLayerRef.current;
    const vertex = protractorVertexRef.current;
    const arm1 = protractorArm1Ref.current;
    if (!layer) return;
    layer.clearLayers();
    clearMeasureTooltip();
    if (!vertex) {
      mapService.setToolInfo("Transportador activo. Click define vertice. Shift alinea ejes.");
      clearMeasureTooltip();
      return;
    }
    L.circleMarker(vertex, {
      radius: 3,
      color: MAP_TOOL_COLOR,
      weight: 1.5,
      fillColor: MAP_TOOL_COLOR,
      fillOpacity: 0.9
    }).addTo(layer);
    if (!arm1) {
      if (preview) {
        L.polyline([vertex, preview], { color: MAP_TOOL_COLOR, weight: 2, dashArray: "5 5" }).addTo(layer);
      }
      mapService.setToolInfo("Transportador activo. Click define brazo referencia.");
      return;
    }

    L.polyline([vertex, arm1], { color: MAP_TOOL_COLOR, weight: 2 }).addTo(layer);
    const arm2 = preview ?? mapToolPreviewLatLngRef.current;
    if (!arm2) {
      mapService.setToolInfo("Transportador activo. Click final define angulo.");
      return;
    }

    const isPreview = preview !== null;
    L.polyline([vertex, arm2], { color: MAP_TOOL_COLOR, weight: 2, dashArray: isPreview ? "5 5" : undefined }).addTo(layer);
    const angle = calculateProtractorAngleDeg(vertex, arm1, arm2, PROTRACTOR_MIN_ARM_METERS);
    if (angle === null) {
      mapService.setToolInfo("Transportador activo. Brazo final invalido.");
      return;
    }

    const angleText = formatAngleDegrees(angle);
    const { arcPoints, labelLatLng } = buildProtractorArcGeometry(vertex, arm1, arm2);
    if (arcPoints.length > 1) {
      L.polyline(arcPoints, { color: MAP_TOOL_COLOR, weight: 2 }).addTo(layer);
    }
    if (labelLatLng) {
      L.marker(labelLatLng, {
        interactive: false,
        icon: L.divIcon({
          className: "",
          html: `<div class="map-protractor-label">${angleText}</div>`,
          iconSize: [72, 20],
          iconAnchor: [36, 10]
        })
      }).addTo(layer);
    }
    mapService.setToolInfo(`Transportador ${angleText}. Click cierra. Shift alinea ejes.`);
  };

  useEffect(() => {
    if (!hostRef.current || mapRef.current) return;
    const map = L.map(hostRef.current, {
      zoomControl: true,
      wheelPxPerZoomLevel: MAP_WHEEL_PX_PER_ZOOM_LEVEL,
      wheelDebounceTime: MAP_WHEEL_DEBOUNCE_MS
    }).setView([initialCenterLat, initialCenterLon], initialZoom);
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      {
        maxZoom: 26,
        maxNativeZoom: 19,
        detectRetina: true,
        attribution: "Tiles © Esri"
      }
    ).addTo(map);
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      {
        maxZoom: 26,
        maxNativeZoom: 19,
        opacity: 0.84,
        attribution: "Labels © Esri",
        className: "map-label-overlay"
      }
    ).addTo(map);

    const drawnItems = new L.FeatureGroup();
    const waypointLayer = L.layerGroup();
    const draftLayer = L.layerGroup();
    const toolDraftLayer = L.layerGroup();
    const toolDrawingsLayer = L.layerGroup();
    map.addLayer(drawnItems);
    map.addLayer(waypointLayer);
    map.addLayer(draftLayer);
    map.addLayer(toolDraftLayer);
    map.addLayer(toolDrawingsLayer);
    mapRef.current = map;
    drawnItemsRef.current = drawnItems;
    waypointLayerRef.current = waypointLayer;
    waypointRenderKeyRef.current = "";
    draftLayerRef.current = draftLayer;
    toolDraftLayerRef.current = toolDraftLayer;
    toolDrawingsLayerRef.current = toolDrawingsLayer;
    if (mapControlRef) {
      mapControlRef.current = {
        zoomIn: () => {
          map.zoomIn();
        },
        zoomOut: () => {
          map.zoomOut();
        }
      };
    }
    onZoomChange?.(map.getZoom());

    const handleZoomEnd = (): void => {
      onZoomChange?.(map.getZoom());
    };
    map.on("zoomend", handleZoomEnd);

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
        void mapService.pushZonesToBackend().catch(() => undefined);
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
        mapService.removeZone(zoneId, { sync: false });
      });
      if (mapService.getState().autoSync) {
        void mapService.pushZonesToBackend().catch(() => undefined);
      }
    });

    map.on("click", (evt: L.LeafletMouseEvent) => {
      if (!interactiveRef.current) return;
      const mode = toolModeRef.current;
      const domEvent = evt.originalEvent as MouseEvent | undefined;
      if (domEvent?.detail && domEvent.detail > 1) return;
      if (mode === "inspect") {
        mapService.setInspectCoords(evt.latlng.lat, evt.latlng.lng);
        const coordsText = `${evt.latlng.lat.toFixed(6)}, ${evt.latlng.lng.toFixed(6)}`;
        const buttonId = `inspect-copy-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
        const popup = L.popup({
          className: "map-inspect-leaflet-popup"
        })
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
        measurePointsRef.current = collectMeasurePoints(evt.latlng);
        mapToolPreviewLatLngRef.current = null;
        renderRulerMeasure(null);
        return;
      }
      if (mode === "area") {
        measurePointsRef.current = collectMeasurePoints(evt.latlng);
        mapToolPreviewLatLngRef.current = null;
        renderAreaMeasure(null);
        return;
      }
      if (mode === "protractor") {
        const shiftPressed = Boolean((evt.originalEvent as MouseEvent | undefined)?.shiftKey);
        if (!protractorVertexRef.current) {
          protractorVertexRef.current = evt.latlng;
          protractorArm1Ref.current = null;
          mapToolPreviewLatLngRef.current = null;
          renderProtractorMeasure(null);
          return;
        }
        const snappedLatLng = resolveProtractorPoint(evt.latlng, shiftPressed);
        if (!protractorArm1Ref.current) {
          protractorArm1Ref.current = snappedLatLng;
          mapToolPreviewLatLngRef.current = null;
          renderProtractorMeasure(null);
          return;
        }
        finalizeProtractorMeasure(snappedLatLng);
        return;
      }
    });

    map.on("dblclick", (evt: L.LeafletMouseEvent) => {
      if (!interactiveRef.current) return;
      const mode = toolModeRef.current;
      if (mode !== "ruler" && mode !== "area" && mode !== "protractor") return;
      L.DomEvent.stop(evt.originalEvent);
      if (mode === "ruler") {
        finalizeRulerMeasure(evt.latlng);
        return;
      }
      if (mode === "protractor") {
        const shiftPressed = Boolean((evt.originalEvent as MouseEvent | undefined)?.shiftKey);
        finalizeProtractorMeasure(resolveProtractorPoint(evt.latlng, shiftPressed));
        return;
      }
      finalizeAreaMeasure(evt.latlng);
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
      if (goalCreateSessionRef.current.active) {
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
        return;
      }
      if (!interactiveRef.current) return;
      const mode = toolModeRef.current;
      if (mode === "ruler") {
        mapToolPreviewLatLngRef.current = evt.latlng;
        renderRulerMeasure(evt.latlng);
        return;
      }
      if (mode === "area") {
        mapToolPreviewLatLngRef.current = evt.latlng;
        renderAreaMeasure(evt.latlng);
        return;
      }
      if (mode === "protractor") {
        const shiftPressed = Boolean((evt.originalEvent as MouseEvent | undefined)?.shiftKey);
        const previewPoint = resolveProtractorPoint(evt.latlng, shiftPressed);
        mapToolPreviewLatLngRef.current = previewPoint;
        renderProtractorMeasure(previewPoint);
      }
    });

    map.on("mouseup", () => {
      if (!goalCreateSessionRef.current.active) return;
      const draft = goalDraftRef.current;
      clearGoalDraft();
      if (!draft) return;
      onQueueWaypointRef.current(draft.lat, draft.lon, draft.yawDeg);
    });

    map.on("mouseout", () => {
      if (toolModeRef.current === "ruler" || toolModeRef.current === "area" || toolModeRef.current === "protractor") {
        clearMeasureTooltip();
      }
    });

    return () => {
      clearGoalDraft();
      clearToolDrawings();
      inspectCopyHandlersRef.current.forEach((cleanup) => cleanup());
      inspectCopyHandlersRef.current = [];
      map.off("zoomend", handleZoomEnd);
      if (mapControlRef) {
        mapControlRef.current = null;
      }
      map.remove();
      mapRef.current = null;
      drawnItemsRef.current = null;
      waypointLayerRef.current = null;
      waypointRenderKeyRef.current = "";
      draftLayerRef.current = null;
      toolDraftLayerRef.current = null;
      toolDrawingsLayerRef.current = null;
      robotMarkerRef.current = null;
      datumMarkerRef.current = null;
      draftMarkerRef.current = null;
      measurePointsRef.current = [];
      protractorVertexRef.current = null;
      protractorArm1Ref.current = null;
    };
  }, [initialCenterLat, initialCenterLon, initialZoom, mapControlRef, mapService, onZoomChange, runtime.eventBus]);

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
    if (Math.abs(state.map.originLat) < 1e-9 && Math.abs(state.map.originLon) < 1e-9) return;
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
        if (toolModeRef.current !== "idle") return;
        mapService.toggleZoneEnabled(zone.id);
      });
      drawnItems.addLayer(layer);
    });
  }, [mapService, state.zones]);

  useEffect(() => {
    const layer = waypointLayerRef.current;
    if (!layer) return;
    if (!Array.isArray(waypoints) || waypoints.length === 0) {
      if (waypointRenderKeyRef.current !== "__empty__") {
        layer.clearLayers();
        waypointRenderKeyRef.current = "__empty__";
      }
      return;
    }
    const points = waypoints
      .map((waypoint, index) => ({
        index,
        lat: Number(waypoint.x),
        lon: Number(waypoint.y),
        yawDeg: Number(waypoint.yawDeg ?? 0),
        selected: selectedWaypointIndexes.includes(index)
      }))
      .filter((entry) => Number.isFinite(entry.lat) && Number.isFinite(entry.lon));
    const renderKey =
      points.length === 0
        ? "__empty__"
        : points
            .map(
              (entry) =>
                `${entry.index}:${entry.lat.toFixed(7)}:${entry.lon.toFixed(7)}:${entry.yawDeg.toFixed(2)}:${entry.selected ? 1 : 0}`
            )
            .join("|");
    if (renderKey === waypointRenderKeyRef.current) return;
    waypointRenderKeyRef.current = renderKey;
    layer.clearLayers();
    if (points.length === 0) return;
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
    if (!map) return;
    if (!datumPose) {
      if (datumMarkerRef.current) {
        map.removeLayer(datumMarkerRef.current);
        datumMarkerRef.current = null;
      }
      return;
    }
    const latLng = L.latLng(datumPose.lat, datumPose.lon);
    if (!datumMarkerRef.current) {
      datumMarkerRef.current = L.marker(latLng, {
        icon: buildDatumIcon(),
        interactive: false
      }).addTo(map);
      return;
    }
    datumMarkerRef.current.setLatLng(latLng);
    datumMarkerRef.current.setIcon(buildDatumIcon());
  }, [datumPose]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !robotPose || centerRequestKey <= 0) return;
    if (centerRequestHandledRef.current === centerRequestKey) return;
    centerRequestHandledRef.current = centerRequestKey;
    map.setView([robotPose.lat, robotPose.lon], Math.max(map.getZoom(), 17));
  }, [centerRequestKey, robotPose]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setView([initialCenterLat, initialCenterLon], initialZoom);
  }, [initialCenterLat, initialCenterLon, initialZoom]);

  useEffect(() => {
    if (state.toolMode !== "idle") {
      clearGoalDraft();
    }
    if (state.toolMode === "idle") {
      clearToolDrawings();
      return;
    }
    clearMeasureDraft();
    setToolLegend(state.toolMode);
  }, [state.toolMode]);

  useEffect(() => {
    if (!goalMode) {
      clearGoalDraft();
    }
    if (goalMode) return;
    mapToolPreviewLatLngRef.current = null;
    clearMeasureTooltip();
  }, [goalMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const container = map.getContainer();
    if (state.toolMode !== "idle" || goalMode) {
      container.classList.add("map-tool-pointer");
    } else {
      container.classList.remove("map-tool-pointer");
    }
    return () => {
      container.classList.remove("map-tool-pointer");
    };
  }, [goalMode, state.toolMode]);

  return <div ref={hostRef} className="leaflet-host map-host-canvas" />;
}

function CockpitMapCanvas({
  state,
  mapService,
  interactive,
  goalMode,
  waypoints,
  selectedWaypointIndexes,
  robotPose,
  datumPose,
  centerRequestKey,
  onQueueWaypoint,
  onToggleWaypointSelection,
  onMoveWaypoint,
  initialCenterLat,
  initialCenterLon,
  initialZoom,
  onZoomChange,
  mapControlRef,
  activeWaypointIndex
}: {
  state: MapWorkspaceState;
  mapService: MapService;
  interactive: boolean;
  goalMode: boolean;
  waypoints: NavigationState["waypoints"];
  selectedWaypointIndexes: number[];
  robotPose: TelemetrySnapshot["robotPose"];
  datumPose: { lat: number; lon: number } | null;
  centerRequestKey: number;
  onQueueWaypoint: (lat: number, lon: number, yawDeg: number) => void;
  onToggleWaypointSelection: (index: number) => void;
  onMoveWaypoint: (index: number, lat: number, lon: number) => void;
  initialCenterLat: number;
  initialCenterLon: number;
  initialZoom: number;
  onZoomChange?: (zoom: number) => void;
  mapControlRef?: { current: MapViewportControlHandle | null };
  activeWaypointIndex: number | null;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const previousToolModeRef = useRef<MapToolMode>(state.toolMode);
  const suppressCanvasClickRef = useRef(false);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(initialZoom);
  const [previewPoint, setPreviewPoint] = useState<GeoPoint | null>(null);
  const [inspectPoint, setInspectPoint] = useState<GeoPoint | null>(null);
  const [measurePoints, setMeasurePoints] = useState<GeoPoint[]>([]);
  const [protractorVertex, setProtractorVertex] = useState<GeoPoint | null>(null);
  const [protractorArm, setProtractorArm] = useState<GeoPoint | null>(null);
  const [protractorEnd, setProtractorEnd] = useState<GeoPoint | null>(null);
  const [goalDraft, setGoalDraft] = useState<{
    pointerId: number;
    origin: GeoPoint;
    yawDeg: number;
  } | null>(null);
  const [dragWaypoint, setDragWaypoint] = useState<{
    pointerId: number;
    index: number;
    lat: number;
    lon: number;
    startClientX: number;
    startClientY: number;
    moved: boolean;
  } | null>(null);

  const fallbackCenter = { lat: initialCenterLat, lon: initialCenterLon };
  const centerPoint: GeoPoint = robotPose
    ? { lat: robotPose.lat, lon: robotPose.lon }
    : datumPose ?? fallbackCenter;

  const geometryPoints: GeoPoint[] = [];
  if (robotPose) {
    geometryPoints.push({ lat: robotPose.lat, lon: robotPose.lon });
  }
  if (datumPose) {
    geometryPoints.push(datumPose);
  }
  waypoints.forEach((waypoint) => {
    const lat = Number(waypoint.x);
    const lon = Number(waypoint.y);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    geometryPoints.push({ lat, lon });
  });
  state.zones.forEach((zone) => {
    zone.polygon?.forEach((vertex) => geometryPoints.push(vertex));
  });

  const maxDistanceMeters = geometryPoints.reduce((currentMax, point) => {
    return Math.max(currentMax, distanceBetweenGeoPointsMeters(centerPoint, point));
  }, 0);
  const zoomFactor = Math.pow(1.26, zoom - initialZoom);
  const visibleRadiusMeters = clampNumber(
    (maxDistanceMeters > 0 ? maxDistanceMeters * 1.35 : 34) / zoomFactor,
    14,
    800
  );
  const stageWidth = viewportSize.width || 960;
  const stageHeight = viewportSize.height || 540;
  const centerX = stageWidth / 2;
  const centerY = stageHeight / 2;
  const usableRadiusPx = Math.max(120, Math.min(stageWidth, stageHeight) * 0.36);
  const pixelsPerMeter = usableRadiusPx / visibleRadiusMeters;

  const projectPoint = (point: GeoPoint): { x: number; y: number } => {
    const delta = geoDeltaMeters(centerPoint, point);
    return {
      x: centerX + delta.eastM * pixelsPerMeter,
      y: centerY - delta.northM * pixelsPerMeter
    };
  };

  const resolvePointFromClient = (clientX: number, clientY: number): GeoPoint | null => {
    const host = hostRef.current;
    if (!host) return null;
    const rect = host.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const eastM = (localX - centerX) / pixelsPerMeter;
    const northM = (centerY - localY) / pixelsPerMeter;
    return offsetGeoPoint(centerPoint, eastM, northM);
  };

  const resolveProtractorPoint = (rawPoint: GeoPoint, shiftPressed: boolean): GeoPoint => {
    if (!shiftPressed || !protractorVertex) return rawPoint;
    const snapped = snapToCartesianAxis(
      L.latLng(protractorVertex.lat, protractorVertex.lon),
      L.latLng(rawPoint.lat, rawPoint.lon),
      PROTRACTOR_SNAP_THRESHOLD_DEG,
      PROTRACTOR_MIN_ARM_METERS
    );
    return { lat: snapped.lat, lon: snapped.lng };
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const updateSize = (): void => {
      setViewportSize({
        width: host.clientWidth,
        height: host.clientHeight
      });
    };
    updateSize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => updateSize());
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setZoom(initialZoom);
  }, [initialZoom]);

  useEffect(() => {
    onZoomChange?.(zoom);
  }, [onZoomChange, zoom]);

  useEffect(() => {
    if (!mapControlRef) return;
    mapControlRef.current = {
      zoomIn: () => setZoom((current) => clampNumber(current + 1, 0, GPS_NATIVE_MAX_ZOOM)),
      zoomOut: () => setZoom((current) => clampNumber(current - 1, 0, GPS_NATIVE_MAX_ZOOM))
    };
    return () => {
      mapControlRef.current = null;
    };
  }, [mapControlRef]);

  useEffect(() => {
    if (previousToolModeRef.current === state.toolMode) return;
    previousToolModeRef.current = state.toolMode;
    setPreviewPoint(null);
    setMeasurePoints([]);
    setProtractorVertex(null);
    setProtractorArm(null);
    setProtractorEnd(null);
  }, [state.toolMode]);

  useEffect(() => {
    if (!goalMode) {
      setGoalDraft(null);
    }
  }, [goalMode]);

  useEffect(() => {
    if (centerRequestKey <= 0) return;
    setPreviewPoint(null);
    setGoalDraft(null);
  }, [centerRequestKey]);

  useEffect(() => {
    if (state.toolMode === "ruler") {
      const displayPoints = previewPoint && measurePoints.length > 0 ? [...measurePoints, previewPoint] : measurePoints;
      let totalMeters = 0;
      for (let index = 1; index < displayPoints.length; index += 1) {
        totalMeters += distanceBetweenGeoPointsMeters(displayPoints[index - 1], displayPoints[index]);
      }
      mapService.setToolInfo(`Ruler: ${formatDistanceMeters(totalMeters)} (${displayPoints.length} puntos)`);
      return;
    }
    if (state.toolMode === "area") {
      const displayPoints = previewPoint && measurePoints.length > 0 ? [...measurePoints, previewPoint] : measurePoints;
      let perimeter = 0;
      for (let index = 1; index < displayPoints.length; index += 1) {
        perimeter += distanceBetweenGeoPointsMeters(displayPoints[index - 1], displayPoints[index]);
      }
      if (displayPoints.length > 2) {
        perimeter += distanceBetweenGeoPointsMeters(displayPoints[displayPoints.length - 1], displayPoints[0]);
      }
      mapService.setToolInfo(`Area ${formatAreaSqMeters(planarAreaSqMeters(displayPoints))} · Perim ${formatDistanceMeters(perimeter)}`);
      return;
    }
    if (state.toolMode === "protractor") {
      if (!protractorVertex) {
        mapService.setToolInfo("Transportador activo. Click define vertice. Shift alinea ejes.");
        return;
      }
      if (!protractorArm) {
        mapService.setToolInfo("Transportador activo. Click define brazo referencia.");
        return;
      }
      const endPoint = protractorEnd ?? previewPoint;
      if (!endPoint) {
        mapService.setToolInfo("Transportador activo. Click define brazo final.");
        return;
      }
      const angle = calculateProtractorAngleDeg(
        L.latLng(protractorVertex.lat, protractorVertex.lon),
        L.latLng(protractorArm.lat, protractorArm.lon),
        L.latLng(endPoint.lat, endPoint.lon),
        PROTRACTOR_MIN_ARM_METERS
      );
      if (angle === null) {
        mapService.setToolInfo("Transportador activo. Brazo final invalido.");
        return;
      }
      mapService.setToolInfo(`Transportador ${formatAngleDegrees(angle)}. Shift alinea ejes.`);
      return;
    }
    if (state.toolMode === "inspect" && inspectPoint) {
      mapService.setToolInfo(`Inspect ${inspectPoint.lat.toFixed(6)}, ${inspectPoint.lon.toFixed(6)}`);
    }
  }, [
    inspectPoint,
    mapService,
    measurePoints,
    previewPoint,
    protractorArm,
    protractorEnd,
    protractorVertex,
    state.toolMode
  ]);

  const routePolylinePoints = waypoints
    .map((waypoint, index) => {
      const lat = Number(waypoint.x);
      const lon = Number(waypoint.y);
      const yawDeg = Number(waypoint.yawDeg ?? 0);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(yawDeg)) return null;
      return { index, lat, lon, yawDeg };
    })
    .filter((entry): entry is { index: number; lat: number; lon: number; yawDeg: number } => entry !== null);
  const routePolylineString = routePolylinePoints.map((waypoint) => {
    const projected = projectPoint({ lat: waypoint.lat, lon: waypoint.lon });
    return `${projected.x},${projected.y}`;
  }).join(" ");
  const decorativeWaypoints = routePolylinePoints.length === 0
    ? [
        { ...offsetGeoPoint(centerPoint, -14, 8), done: true },
        { ...offsetGeoPoint(centerPoint, -2, 14), done: true },
        { ...offsetGeoPoint(centerPoint, 12, 10), done: true },
        { ...offsetGeoPoint(centerPoint, 18, 0), done: true },
        { ...offsetGeoPoint(centerPoint, 10, -12), done: false },
        { ...offsetGeoPoint(centerPoint, -6, -16), done: false }
      ]
    : [];
  const decorativeRouteString = decorativeWaypoints.map((waypoint) => {
    const projected = projectPoint({ lat: waypoint.lat, lon: waypoint.lon });
    return `${projected.x},${projected.y}`;
  }).join(" ");

  const zoneShapes = state.zones
    .map((zone) => {
      const polygon = Array.isArray(zone.polygon) ? zone.polygon : [];
      if (polygon.length < 3) return null;
      return {
        id: zone.id,
        enabled: zone.enabled !== false,
        points: polygon.map((vertex) => projectPoint(vertex))
      };
    })
    .filter((entry): entry is { id: string; enabled: boolean; points: Array<{ x: number; y: number }> } => entry !== null);

  const rulerDisplayPoints =
    state.toolMode === "ruler" && previewPoint && measurePoints.length > 0 ? [...measurePoints, previewPoint] : measurePoints;
  const areaDisplayPoints =
    state.toolMode === "area" && previewPoint && measurePoints.length > 0 ? [...measurePoints, previewPoint] : measurePoints;
  const protractorPreviewPoint = state.toolMode === "protractor" ? protractorEnd ?? previewPoint : null;
  const protractorArc =
    protractorVertex && protractorArm && protractorPreviewPoint
      ? buildProtractorArcGeometry(
          L.latLng(protractorVertex.lat, protractorVertex.lon),
          L.latLng(protractorArm.lat, protractorArm.lon),
          L.latLng(protractorPreviewPoint.lat, protractorPreviewPoint.lon)
        )
      : { arcPoints: [], labelLatLng: null };

  const handleCanvasClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (!interactive) return;
    if (suppressCanvasClickRef.current) {
      suppressCanvasClickRef.current = false;
      return;
    }
    const point = resolvePointFromClient(event.clientX, event.clientY);
    if (!point) return;
    if (goalMode && state.toolMode === "idle") return;
    if (state.toolMode === "inspect") {
      setInspectPoint(point);
      mapService.setInspectCoords(point.lat, point.lon);
      return;
    }
    if (state.toolMode === "ruler") {
      setMeasurePoints((current) => [...current, point].slice(-12));
      return;
    }
    if (state.toolMode === "area") {
      setMeasurePoints((current) => [...current, point].slice(-12));
      return;
    }
    if (state.toolMode === "protractor") {
      if (!protractorVertex) {
        setProtractorVertex(point);
        return;
      }
      const snappedPoint = resolveProtractorPoint(point, event.shiftKey);
      if (!protractorArm) {
        setProtractorArm(snappedPoint);
        return;
      }
      if (!protractorEnd) {
        setProtractorEnd(snappedPoint);
        return;
      }
      setProtractorVertex(snappedPoint);
      setProtractorArm(null);
      setProtractorEnd(null);
    }
  };

  const handleCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!interactive || !goalMode || state.toolMode !== "idle" || event.button !== 0) return;
    const point = resolvePointFromClient(event.clientX, event.clientY);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setGoalDraft({
      pointerId: event.pointerId,
      origin: point,
      yawDeg: 0
    });
  };

  const handleCanvasPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!interactive) return;
    const point = resolvePointFromClient(event.clientX, event.clientY);
    if (!point) return;
    if (goalDraft && goalDraft.pointerId === event.pointerId) {
      const yawDeg = yawDegFromLatLng(
        L.latLng(goalDraft.origin.lat, goalDraft.origin.lon),
        L.latLng(point.lat, point.lon)
      );
      setGoalDraft({ ...goalDraft, yawDeg });
      return;
    }
    if (state.toolMode === "ruler" || state.toolMode === "area") {
      setPreviewPoint(point);
      return;
    }
    if (state.toolMode === "protractor") {
      setPreviewPoint(resolveProtractorPoint(point, event.shiftKey));
      return;
    }
    setPreviewPoint(null);
  };

  const handleCanvasPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!goalDraft || goalDraft.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onQueueWaypoint(goalDraft.origin.lat, goalDraft.origin.lon, goalDraft.yawDeg);
    setGoalDraft(null);
    suppressCanvasClickRef.current = true;
  };

  const handleCanvasPointerLeave = (): void => {
    if (goalDraft) return;
    if (state.toolMode === "ruler" || state.toolMode === "area" || state.toolMode === "protractor") {
      setPreviewPoint(null);
    }
  };

  const handleCanvasWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    if (!interactive) return;
    event.preventDefault();
    setZoom((current) =>
      clampNumber(current + (event.deltaY < 0 ? 1 : -1), 0, GPS_NATIVE_MAX_ZOOM)
    );
  };

  const renderProjectedPoints = (points: GeoPoint[]): string =>
    points
      .map((point) => {
        const projected = projectPoint(point);
        return `${projected.x},${projected.y}`;
      })
      .join(" ");

  return (
    <div
      ref={hostRef}
      className={`map-abstract-canvas${interactive ? " interactive" : ""}`}
      onClick={handleCanvasClick}
      onPointerDown={handleCanvasPointerDown}
      onPointerMove={handleCanvasPointerMove}
      onPointerUp={handleCanvasPointerUp}
      onPointerLeave={handleCanvasPointerLeave}
      onWheel={handleCanvasWheel}
    >
      <div className="map-grid" />
      <div className="map-grid map-grid-secondary" />
      <div className="map-radar-ring radar-ring-1" aria-hidden="true" />
      <div className="map-radar-ring radar-ring-2" aria-hidden="true" />
      <svg className="map-abstract-overlay map-abstract-overlay-zones" viewBox={`0 0 ${stageWidth} ${stageHeight}`} preserveAspectRatio="none">
        {zoneShapes.map((zone) => (
          <polygon
            key={zone.id}
            className={`map-zone-shape${zone.enabled ? "" : " disabled"}`}
            points={zone.points.map((point) => `${point.x},${point.y}`).join(" ")}
            onClick={(event) => {
              event.stopPropagation();
              if (state.toolMode !== "idle") return;
              mapService.toggleZoneEnabled(zone.id);
            }}
          />
        ))}
      </svg>
      <svg className="map-abstract-overlay map-abstract-overlay-passive" viewBox={`0 0 ${stageWidth} ${stageHeight}`} preserveAspectRatio="none" aria-hidden="true">
        {routePolylineString ? <polyline className="map-route-line" points={routePolylineString} /> : null}
        {!routePolylineString && decorativeRouteString ? <polyline className="map-route-line decorative" points={decorativeRouteString} /> : null}
        {rulerDisplayPoints.length > 1 ? <polyline className="map-tool-line" points={renderProjectedPoints(rulerDisplayPoints)} /> : null}
        {areaDisplayPoints.length > 2 ? <polygon className="map-tool-area" points={renderProjectedPoints(areaDisplayPoints)} /> : null}
        {areaDisplayPoints.length > 1 ? <polyline className="map-tool-line" points={renderProjectedPoints(areaDisplayPoints)} /> : null}
        {protractorVertex && protractorArm ? (
          <line
            className="map-tool-line"
            x1={projectPoint(protractorVertex).x}
            y1={projectPoint(protractorVertex).y}
            x2={projectPoint(protractorArm).x}
            y2={projectPoint(protractorArm).y}
          />
        ) : null}
        {protractorVertex && protractorPreviewPoint ? (
          <line
            className="map-tool-line dashed"
            x1={projectPoint(protractorVertex).x}
            y1={projectPoint(protractorVertex).y}
            x2={projectPoint(protractorPreviewPoint).x}
            y2={projectPoint(protractorPreviewPoint).y}
          />
        ) : null}
        {protractorArc.arcPoints.length > 1 ? (
          <polyline className="map-tool-line faint" points={renderProjectedPoints(protractorArc.arcPoints.map((point) => ({ lat: point.lat, lon: point.lng })))} />
        ) : null}
      </svg>
      {datumPose ? (
        <div
          className="map-datum"
          style={{
            left: projectPoint(datumPose).x,
            top: projectPoint(datumPose).y
          }}
          title={`Datum ${datumPose.lat.toFixed(6)}, ${datumPose.lon.toFixed(6)}`}
        >
          <span className="map-datum-cross" />
        </div>
      ) : null}
      {routePolylinePoints.map((waypoint) => {
        const isDragging = dragWaypoint?.index === waypoint.index;
        const point = {
          lat: isDragging ? dragWaypoint.lat : waypoint.lat,
          lon: isDragging ? dragWaypoint.lon : waypoint.lon
        };
        if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return null;
        const projected = projectPoint(point);
        const isSelected = selectedWaypointIndexes.includes(waypoint.index);
        const isCurrent = activeWaypointIndex === waypoint.index;
        return (
          <button
            key={`waypoint-${waypoint.index}-${point.lat.toFixed(6)}-${point.lon.toFixed(6)}`}
            type="button"
            className={`wp${isSelected ? " selected" : ""}${isCurrent ? " current" : ""}`}
            style={{ left: projected.x, top: projected.y }}
            title={`WP ${waypoint.index + 1}: ${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}`}
            disabled={!interactive}
            onPointerDown={(event) => {
              if (!interactive || event.button !== 0) return;
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              setDragWaypoint({
                pointerId: event.pointerId,
                index: waypoint.index,
                lat: point.lat,
                lon: point.lon,
                startClientX: event.clientX,
                startClientY: event.clientY,
                moved: false
              });
            }}
            onPointerMove={(event) => {
              if (!dragWaypoint || dragWaypoint.index !== waypoint.index || dragWaypoint.pointerId !== event.pointerId) return;
              const nextPoint = resolvePointFromClient(event.clientX, event.clientY);
              if (!nextPoint) return;
              const moved =
                dragWaypoint.moved ||
                Math.hypot(event.clientX - dragWaypoint.startClientX, event.clientY - dragWaypoint.startClientY) > 5;
              setDragWaypoint({
                ...dragWaypoint,
                lat: nextPoint.lat,
                lon: nextPoint.lon,
                moved
              });
            }}
            onPointerUp={(event) => {
              if (!dragWaypoint || dragWaypoint.index !== waypoint.index || dragWaypoint.pointerId !== event.pointerId) return;
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              event.stopPropagation();
              if (dragWaypoint.moved) {
                onMoveWaypoint(waypoint.index, dragWaypoint.lat, dragWaypoint.lon);
              } else {
                onToggleWaypointSelection(waypoint.index);
              }
              setDragWaypoint(null);
              suppressCanvasClickRef.current = true;
            }}
            onPointerCancel={() => {
              setDragWaypoint(null);
            }}
          />
        );
      })}
      {routePolylinePoints.length === 0
        ? decorativeWaypoints.map((waypoint, index) => {
            const projected = projectPoint({ lat: waypoint.lat, lon: waypoint.lon });
            return (
              <div
                key={`decorative-waypoint-${index}`}
                className={`wp${waypoint.done ? " done" : ""}`}
                style={{ left: projected.x, top: projected.y, pointerEvents: "none" }}
                data-decorative="true"
                aria-hidden="true"
              />
            );
          })
        : null}
      {goalDraft ? (
        <>
          <div
            className="wp draft"
            style={{
              left: projectPoint(goalDraft.origin).x,
              top: projectPoint(goalDraft.origin).y
            }}
          />
          <div
            className="map-goal-heading"
            style={{
              left: projectPoint(goalDraft.origin).x,
              top: projectPoint(goalDraft.origin).y,
              transform: `translate(-50%, -50%) rotate(${90 - goalDraft.yawDeg}deg)`
            }}
            aria-hidden="true"
          />
        </>
      ) : null}
      {inspectPoint ? (
        <div className="map-inspect-tag" style={{ left: projectPoint(inspectPoint).x, top: projectPoint(inspectPoint).y }}>
          {inspectPoint.lat.toFixed(4)}, {inspectPoint.lon.toFixed(4)}
        </div>
      ) : null}
      <div className="robot" style={{ left: projectPoint(centerPoint).x, top: projectPoint(centerPoint).y }}>
        <div className="robot-ring">
          <div className="robot-inner" style={{ fontSize: 16, fontFamily: "var(--font-mono)" }}>
            ⊙
          </div>
        </div>
        <div className="robot-lbl">SALUS-01</div>
      </div>
      {protractorArc.labelLatLng ? (
        <div
          className="map-angle-label"
          style={{
            left: projectPoint({ lat: protractorArc.labelLatLng.lat, lon: protractorArc.labelLatLng.lng }).x,
            top: projectPoint({ lat: protractorArc.labelLatLng.lat, lon: protractorArc.labelLatLng.lng }).y
          }}
        >
          {formatAngleDegrees(
            calculateProtractorAngleDeg(
              L.latLng(protractorVertex!.lat, protractorVertex!.lon),
              L.latLng(protractorArm!.lat, protractorArm!.lon),
              L.latLng(protractorPreviewPoint!.lat, protractorPreviewPoint!.lon),
              PROTRACTOR_MIN_ARM_METERS
            ) ?? 0
          )}
        </div>
      ) : null}
    </div>
  );
}

function MapWorkspaceView({ runtime }: { runtime: ModuleContext }): JSX.Element {
  const [nav2Config, setNav2Config] = useState<Nav2MapConfig>(() => readNav2MapConfig(runtime));
  const mapService = runtime.services.getService<MapService>(SERVICE_ID);
  let navigationService: NavigationService | null = null;
  try {
    navigationService = runtime.services.getService<NavigationService>(NAVIGATION_SERVICE_ID);
  } catch {
    navigationService = null;
  }
  let connectionService: ConnectionService | null = null;
  try {
    connectionService = runtime.services.getService<ConnectionService>(CONNECTION_SERVICE_ID);
  } catch {
    connectionService = null;
  }
  let telemetryService: TelemetryServiceLike | null = null;
  try {
    telemetryService = runtime.services.getService<TelemetryServiceLike>(TELEMETRY_SERVICE_ID);
  } catch {
    telemetryService = null;
  }
  let sensorInfoService: SensorInfoService | null = null;
  try {
    sensorInfoService = runtime.services.getService<SensorInfoService>(SENSOR_INFO_SERVICE_ID);
  } catch {
    sensorInfoService = null;
  }
  const [state, setState] = useState<MapWorkspaceState>(mapService.getState());
  const [mainPane, setMainPane] = useState<"map" | "camera">("map");
  const [frameSrc, setFrameSrc] = useState("");
  const [frameReady, setFrameReady] = useState(false);
  const [snapSrc, setSnapSrc] = useState("");
  const [cameraStreamPending, setCameraStreamPending] = useState<"idle" | "connecting">("idle");
  const [cameraConnectError, setCameraConnectError] = useState("");
  const [centerRequestKey, setCenterRequestKey] = useState(0);
  const [mapZoom, setMapZoom] = useState(GPS_DEFAULT_ZOOM);
  const [navigationState, setNavigationState] = useState<NavigationState | null>(
    navigationService ? navigationService.getState() : null
  );
  const [connectionState, setConnectionState] = useState<ConnectionState | null>(
    connectionService ? connectionService.getState() : null
  );
  const [telemetrySnapshot, setTelemetrySnapshot] = useState<TelemetrySnapshot | null>(
    telemetryService ? telemetryService.getSnapshot() : null
  );
  const [sensorInfoState, setSensorInfoState] = useState<SensorInfoState | null>(
    sensorInfoService ? sensorInfoService.getState() : null
  );
  const wasConnectedRef = useRef(false);
  const pendingCenterOnConnectRef = useRef(false);
  const cameraStreamSeqRef = useRef(0);
  const cameraLoadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mapControlRef = useRef<MapViewportControlHandle | null>(null);

  useEffect(() => mapService.subscribe((next) => setState(next)), [mapService]);
  useEffect(() => {
    return runtime.eventBus.on<{ packageId?: unknown; config?: unknown }>(CORE_EVENTS.packageConfigUpdated, (payload) => {
      const packageId = typeof payload?.packageId === "string" ? payload.packageId : "";
      if (packageId !== "nav2") return;
      setNav2Config(readNav2MapConfig(runtime));
    });
  }, [runtime]);
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
    mapService.setBackendSyncTransportState({
      connected: connectionState?.connected === true,
      host: connectionState?.host,
      port: connectionState?.port
    });
  }, [mapService, connectionState?.connected, connectionState?.host, connectionState?.port]);
  useEffect(() => {
    if (!telemetryService) return;
    return telemetryService.subscribeTelemetry((next) => setTelemetrySnapshot(next));
  }, [telemetryService]);
  useEffect(() => {
    if (!sensorInfoService) return;
    return sensorInfoService.subscribe((next) => setSensorInfoState(next));
  }, [sensorInfoService]);
  useEffect(() => {
    if (!sensorInfoService) return;
    void sensorInfoService.open();
    return () => {
      void sensorInfoService.close();
    };
  }, [sensorInfoService]);
  useEffect(() => {
    const connected = connectionState?.connected === true;
    const previous = wasConnectedRef.current;
    wasConnectedRef.current = connected;
    if (!connected || previous) return;

    pendingCenterOnConnectRef.current = true;
    void (async () => {
      try {
        const count = await mapService.loadZonesFromBackend();
        runtime.eventBus.emit("console.event", {
          level: "info",
          text: `No-go zones loaded (${count})`,
          timestamp: Date.now()
        });
        return;
      } catch (error) {
        // Legacy backend can timeout on load_zones_file right after connect.
        // Fallback to get_state avoids false negative on first connection.
      }

      try {
        const loaded = await mapService.loadMap("map");
        const count = mapService.getState().zones.length;
        runtime.eventBus.emit("console.event", {
          level: "info",
          text: `No-go zones loaded (${count}) from ${loaded.mapId}`,
          timestamp: Date.now()
        });
      } catch (fallbackError) {
        runtime.eventBus.emit("console.event", {
          level: "warn",
          text: `No-go zones load failed: ${String(fallbackError)}`,
          timestamp: Date.now()
        });
      }
    })();
  }, [connectionState?.connected, mapService, runtime.eventBus]);
  useEffect(() => {
    if (!pendingCenterOnConnectRef.current) return;
    const pose = telemetrySnapshot?.robotPose;
    if (!pose) return;
    pendingCenterOnConnectRef.current = false;
    setCenterRequestKey((value) => value + 1);
    runtime.eventBus.emit("console.event", {
      level: "info",
      text: "Map auto-centered on robot after connect",
      timestamp: Date.now()
    });
  }, [telemetrySnapshot?.robotPose, runtime.eventBus]);
  useEffect(() => {
    return runtime.eventBus.on(NAV_EVENTS.swapWorkspaceRequest, () => {
      if (connectionState?.preset === "sim") return;
      setMainPane((current) => (current === "map" ? "camera" : "map"));
    });
  }, [connectionState?.preset, runtime]);

  const isSimPreset = connectionState?.preset === "sim";
  const cameraPaneAvailable = !isSimPreset;
  const mainIsMap = !cameraPaneAvailable || mainPane === "map";
  const showMiniCameraPane = mainIsMap;
  const cameraEnabled = connectionService?.isCameraEnabled() ?? false;
  const cameraUrl = connectionService?.getCameraIframeUrl() ?? "";
  const cameraProbeTimeoutMs = parseCameraProbeTimeout(nav2Config, runtime);
  const cameraLoadTimeoutMs = parseCameraLoadTimeout(nav2Config, runtime);
  const initialCenter = parseCenter(nav2Config);
  const initialCenterLat = initialCenter[0];
  const initialCenterLon = initialCenter[1];
  const initialZoom = parseZoom(nav2Config);
  const cameraStreamConnected = navigationState?.cameraStreamConnected === true;
  const mapInteractive = mainIsMap;
  const mapToolsEnabled = mainIsMap;
  const routeMission = navigationState?.routeMission ?? null;
  const routePointCount = Math.max(0, routeMission?.expandedWaypointCount ?? 0);
  const routeProgressIndex =
    routePointCount > 0
      ? Math.min(routePointCount, Math.max(routeMission?.currentStartIndex ?? 0, routeMission?.currentTargetIndex ?? 0))
      : 0;
  const missionProgressPct = routePointCount > 0 ? Math.min(100, Math.max(0, (routeProgressIndex / routePointCount) * 100)) : 0;
  const missionTitle =
    routeMission?.paused ? "Route paused" :
    routeMission?.active ? "Following route" :
    navigationState?.manualMode ? "Manual control" :
    navigationState?.goalMode ? "Goal mode" :
    "Ready";
  const missionDetail =
    routeMission?.active || routeMission?.paused
      ? `${routeProgressIndex}/${routePointCount || 0} route points`
      : navigationState?.manualMode
        ? "Operator control"
        : `${navigationState?.waypoints.length ?? 0} queued waypoints`;
  const missionToneClass =
    routeMission?.status?.toLowerCase().includes("fail") || routeMission?.status?.toLowerCase().includes("error")
      ? "error"
      : routeMission?.paused || navigationState?.manualMode
        ? "warn"
        : routeMission?.active || navigationState?.goalMode
          ? "active"
          : "";
  const linearMin = navigationState?.manualLinearMin ?? 1;
  const linearMax = navigationState?.manualLinearMax ?? 4;
  const angularMin = navigationState?.manualAngularMin ?? 0.1;
  const angularMax = navigationState?.manualAngularMax ?? 1.2;
  const linearSpeed = navigationState?.manualLinearSpeed ?? 1.2;
  const angularSpeed = navigationState?.manualAngularSpeed ?? 0.4;
  const linearFillPct = linearMax > linearMin ? Math.min(100, Math.max(0, ((linearSpeed - linearMin) / (linearMax - linearMin)) * 100)) : 0;
  const angularFillPct = angularMax > angularMin ? Math.min(100, Math.max(0, ((angularSpeed - angularMin) / (angularMax - angularMin)) * 100)) : 0;
  const routeBadgeText =
    routePointCount > 0 ? `${routeProgressIndex}/${routePointCount}` : `${navigationState?.selectedWaypointIndexes.length ?? 0} selected`;

  const clearCameraLoadTimer = (): void => {
    if (!cameraLoadTimerRef.current) return;
    clearTimeout(cameraLoadTimerRef.current);
    cameraLoadTimerRef.current = null;
  };

  useEffect(() => {
    if (cameraPaneAvailable) return;
    if (mainPane === "camera") {
      setMainPane("map");
    }
  }, [cameraPaneAvailable, mainPane]);

  useEffect(() => {
    setMapZoom(initialZoom);
  }, [initialZoom]);

  useEffect(() => {
    if (!cameraEnabled || !cameraUrl || !cameraPaneAvailable) {
      setSnapSrc("");
      setFrameReady(false);
      return;
    }

    setFrameReady(false);
    const snapUrl = cameraUrl.replace(/\/?$/, "/snap.jpg");
    let cancelled = false;

    function pollNext(): void {
      if (cancelled) return;
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        setSnapSrc(img.src);
        setFrameReady(true);
        pollNext();
      };
      img.onerror = () => {
        if (cancelled) return;
        setTimeout(pollNext, 300);
      };
      img.src = `${snapUrl}?_=${Date.now()}`;
    }

    pollNext();
    return () => { cancelled = true; };
  }, [cameraEnabled, cameraPaneAvailable, cameraUrl]);

  useEffect(() => {
    if (mainIsMap) return;
    if (state.toolMode === "idle") return;
    mapService.setToolMode("idle");
  }, [mainIsMap, mapService, state.toolMode]);
  const cameraOverlayText = !cameraEnabled
    ? connectionState?.preset === "sim"
      ? "camera disabled in sim"
      : "camera unavailable"
    : cameraStreamPending === "connecting"
        ? "camera connecting"
        : cameraConnectError
          ? `camera ${cameraConnectError}`
          : frameReady
        ? ""
        : "camera connecting";
  const toolStatusText = mainIsMap ? state.toolInfo : "Herramientas disponibles con mapa principal";
  const generalPayload = sensorInfoState?.payloads.general as Record<string, unknown> | undefined;
  const generalSnapshot = (generalPayload?.snapshot ?? {}) as Record<string, unknown>;
  const datumFromSensor = generalSnapshot.datum as Record<string, unknown> | undefined;
  const datumLat = Number(datumFromSensor?.datum_lat ?? state.map?.originLat ?? Number.NaN);
  const datumLon = Number(datumFromSensor?.datum_lon ?? state.map?.originLon ?? Number.NaN);
  const datumPose =
    Number.isFinite(datumLat) &&
    Number.isFinite(datumLon) &&
    !(Math.abs(datumLat) < 1e-9 && Math.abs(datumLon) < 1e-9)
      ? {
          lat: datumLat,
          lon: datumLon
        }
      : null;
  const coordsText =
    telemetrySnapshot?.robotPose
      ? `${telemetrySnapshot.robotPose.lat.toFixed(4)}°, ${telemetrySnapshot.robotPose.lon.toFixed(4)}°`
      : datumPose
        ? `${datumPose.lat.toFixed(4)}°, ${datumPose.lon.toFixed(4)}°`
        : "n/a";
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

  const clickLeafletTool = (selector: string, label: string): void => {
    if (!mapToolsEnabled) {
      runtime.eventBus.emit("console.event", {
        level: "warn",
        text: "Map tools available only with map as main view",
        timestamp: Date.now()
      });
      return;
    }
    const control = document.querySelector<HTMLAnchorElement>(selector);
    if (!control || control.classList.contains("leaflet-disabled")) {
      runtime.eventBus.emit("console.event", {
        level: "warn",
        text: `${label} unavailable`,
        timestamp: Date.now()
      });
      return;
    }
    control.click();
    runtime.eventBus.emit("console.event", {
      level: "info",
      text: `Map tool: ${label}`,
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
        return;
      }
      if (event.code === "Digit4") {
        selectTool("protractor", "protractor");
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [mainIsMap, mapToolsEnabled, mapService, selectTool, state.toolMode]);

  return (
    <div className="map-workspace-root map-html-root">
      <div className={`stage map-stage map-html-stage ${mainIsMap ? "mode-gps-main" : "mode-camera-main"}`}>
        <section className={`stage-pane ${mainIsMap ? "main" : "mini"} map-stage-pane`}>
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
              datumPose={datumPose}
              centerRequestKey={centerRequestKey}
              onQueueWaypoint={queueWaypointFromMap}
              onToggleWaypointSelection={toggleWaypointSelectionFromMap}
              onMoveWaypoint={moveWaypointFromMap}
              initialCenterLat={initialCenterLat}
              initialCenterLon={initialCenterLon}
              initialZoom={initialZoom}
              onZoomChange={setMapZoom}
              mapControlRef={mapControlRef}
            />
          </div>
          {cameraPaneAvailable && !mainIsMap ? (
            <div className="stage-pane-swap">
              <button type="button" className="swap-btn map-html-swap-btn" onClick={() => setMainPane("map")}>
                Map
              </button>
            </div>
          ) : null}
        </section>
        {cameraPaneAvailable && !mainIsMap ? (
          <section className="stage-pane main map-camera-stage-pane">
            <div className="camera-frame-wrap map-camera-frame-wrap">
              {snapSrc ? (
                <img className="camera-frame map-camera-frame" src={snapSrc} alt="camera" draggable={false} />
              ) : null}
              {cameraOverlayText ? <div className="camera-overlay visible">{cameraOverlayText}</div> : null}
              <div className="map-camera-stage-badges">
                <span className="map-badge">
                  Camera <span className={cameraStreamConnected ? "good" : ""}>{cameraStreamConnected ? "Live" : "Idle"}</span>
                </span>
                <span className="map-badge">
                  Preset <span className="acc">{connectionState?.preset?.toUpperCase() ?? "N/A"}</span>
                </span>
              </div>
              <div className="map-camera-crosshair" aria-hidden="true" />
            </div>
          </section>
        ) : null}
        {mainIsMap ? (
          <>
            <div className="map-right-stack">
              {showMiniCameraPane ? (
                <section className="map-camera-stage-pane map-camera-stage-pane-mini">
                  <div className="map-camera-mini-head">
                    <span>Camera</span>
                    <div className="map-camera-mini-head-right">
                      {cameraPaneAvailable ? (
                        <button type="button" className="map-camera-expand-btn" onClick={() => setMainPane("camera")} title="Abrir cámara">
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M10 2h4v4"/>
                            <path d="M14 2 9 7"/>
                            <path d="M6 14H2v-4"/>
                            <path d="M2 14l5-5"/>
                          </svg>
                        </button>
                      ) : null}
                      <span className={cameraStreamConnected ? "online" : ""} aria-hidden="true" />
                    </div>
                  </div>
                  <div className="camera-frame-wrap map-camera-frame-wrap">
                    {snapSrc ? (
                      <img className="camera-frame map-camera-frame" src={snapSrc} alt="camera" draggable={false} />
                    ) : null}
                    {cameraOverlayText ? <div className="camera-overlay visible">{cameraOverlayText}</div> : null}
                    <div className="map-camera-crosshair" aria-hidden="true" />
                  </div>
                </section>
              ) : null}
              <div className="map-html-overlay-cards map-html-overlay-cards-inline">
                <div className={`mission-status ${missionToneClass}`.trim()}>
                  <div className="ms-main">
                    <span className="ms-dot" aria-hidden="true" />
                    <div className="ms-copy">
                      <div className="ms-title">{missionTitle}</div>
                      <div className="ms-detail">{missionDetail}</div>
                    </div>
                  </div>
                  {routePointCount > 0 ? (
                    <div className="ms-bar" aria-hidden="true">
                      <div className="ms-bar-fill" style={{ width: `${missionProgressPct}%` }} />
                    </div>
                  ) : null}
                </div>
                <div className="map-html-speed-card">
                  <div className="map-html-speed-head">
                    <span className="map-html-speed-title">Speed limits</span>
                    <button
                      type="button"
                      className="map-html-inline-action"
                      disabled={!mapToolsEnabled}
                      onClick={() => {
                        void mapService
                          .setDatumOnBackend()
                          .then(() => {
                            runtime.eventBus.emit("console.event", {
                              level: "info",
                              text: "Datum updated from robot pose",
                              timestamp: Date.now()
                            });
                          })
                          .catch((error) => {
                            runtime.eventBus.emit("console.event", {
                              level: "error",
                              text: `Set datum failed: ${String(error)}`,
                              timestamp: Date.now()
                            });
                          });
                      }}
                    >
                      Datum
                    </button>
                  </div>
                  <div className="map-html-range">
                    <div className="range-label">
                      Linear speed (m/s) <span className="range-val">{linearSpeed.toFixed(2)}</span>
                    </div>
                    <input
                      type="range"
                      min={linearMin}
                      max={linearMax}
                      step={0.01}
                      value={linearSpeed}
                      disabled={!navigationService}
                      style={{ "--range-fill": `${linearFillPct}%` } as CSSProperties}
                      onChange={(event) => navigationService?.setManualLinearSpeed(Number(event.target.value))}
                    />
                    <div className="map-range-scale" aria-hidden="true">
                      <span>{linearMin.toFixed(1)}</span>
                      <span>{((linearMin + linearMax) / 2).toFixed(1)}</span>
                      <span>{linearMax.toFixed(1)}</span>
                    </div>
                  </div>
                  <div className="map-html-range">
                    <div className="range-label">
                      Angular speed (rad/s) <span className="range-val">{angularSpeed.toFixed(2)}</span>
                    </div>
                    <input
                      type="range"
                      min={angularMin}
                      max={angularMax}
                      step={0.01}
                      value={angularSpeed}
                      disabled={!navigationService}
                      style={{ "--range-fill": `${angularFillPct}%` } as CSSProperties}
                      onChange={(event) => navigationService?.setManualAngularSpeed(Number(event.target.value))}
                    />
                    <div className="map-range-scale" aria-hidden="true">
                      <span>{angularMin.toFixed(2)}</span>
                      <span>{((angularMin + angularMax) / 2).toFixed(2)}</span>
                      <span>{angularMax.toFixed(2)}</span>
                    </div>
                  </div>
                  <div className="map-html-tool-status">{toolStatusText}</div>
                </div>
              </div>
            </div>
            <div className="map-toolbar map-html-toolbar map-left-action-toolbar">
              <div className="map-tool-group map-tool-group-zoom">
                <div className="map-tool-group-title">Zoom</div>
                <div className="map-tool-buttons">
              <button
                type="button"
                className="map-btn"
                onClick={() => mapControlRef.current?.zoomIn()}
                title="Zoom in"
                aria-label="Zoom in"
                disabled={!mapToolsEnabled}
              >
                <svg className="map-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <line x1="8" y1="3" x2="8" y2="13"/>
                  <line x1="3" y1="8" x2="13" y2="8"/>
                </svg>
              </button>
              <button
                type="button"
                className="map-btn"
                onClick={() => mapControlRef.current?.zoomOut()}
                title="Zoom out"
                aria-label="Zoom out"
                disabled={!mapToolsEnabled}
              >
                <svg className="map-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <line x1="3" y1="8" x2="13" y2="8"/>
                </svg>
              </button>
                </div>
              </div>
              <div className="map-tool-group map-tool-group-zone">
                <div className="map-tool-group-title">Zone Editing</div>
                <div className="map-tool-buttons">
              <button
                type="button"
                className="map-btn"
                onClick={() => clickLeafletTool(".leaflet-draw-draw-polygon", "draw zone")}
                title="Dibujar zona"
                aria-label="Dibujar zona"
                disabled={!mapToolsEnabled}
              >
                <svg className="map-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 11.5 6 3l7 2.5-2.5 7.5L3 11.5Z"/>
                  <circle cx="6" cy="3" r="1" fill="currentColor" stroke="none"/>
                  <circle cx="13" cy="5.5" r="1" fill="currentColor" stroke="none"/>
                  <circle cx="10.5" cy="13" r="1" fill="currentColor" stroke="none"/>
                  <circle cx="3" cy="11.5" r="1" fill="currentColor" stroke="none"/>
                </svg>
              </button>
              <button
                type="button"
                className="map-btn"
                onClick={() => clickLeafletTool(".leaflet-draw-edit-edit", "edit zones")}
                title="Editar zonas"
                aria-label="Editar zonas"
                disabled={!mapToolsEnabled || state.zones.length === 0}
              >
                <svg className="map-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 13 4 9.5 11.5 2 14 4.5 6.5 12 3 13Z"/>
                  <path d="M10 3.5 12.5 6"/>
                </svg>
              </button>
              <button
                type="button"
                className="map-btn"
                onClick={() => clickLeafletTool(".leaflet-draw-edit-remove", "delete zones")}
                title="Borrar zonas"
                aria-label="Borrar zonas"
                disabled={!mapToolsEnabled || state.zones.length === 0}
              >
                <svg className="map-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M2.5 4.5h11"/>
                  <path d="M6 4.5V3h4v1.5"/>
                  <path d="m4 4.5.7 8.5h6.6l.7-8.5"/>
                  <path d="M6.8 7v4"/>
                  <path d="M9.2 7v4"/>
                </svg>
              </button>
                </div>
              </div>
              <div className="map-tool-group map-tool-group-measure">
                <div className="map-tool-group-title">Measurement</div>
                <div className="map-tool-buttons">
              <button
                type="button"
                className={`map-btn ${toolButtonClass(state.toolMode, "ruler")}`}
                onClick={() => selectTool("ruler", "ruler")}
                title="Regla"
                aria-label="Regla"
                disabled={!mapToolsEnabled}
              >
                <svg className="map-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                  <rect x="1" y="5.5" width="14" height="5" rx="1"/>
                  <line x1="4" y1="5.5" x2="4" y2="8"/>
                  <line x1="7" y1="5.5" x2="7" y2="7.5"/>
                  <line x1="10" y1="5.5" x2="10" y2="8"/>
                  <line x1="13" y1="5.5" x2="13" y2="7.5"/>
                </svg>
              </button>
              <button
                type="button"
                className={`map-btn ${toolButtonClass(state.toolMode, "area")}`}
                onClick={() => selectTool("area", "area")}
                title="Área"
                aria-label="Área"
                disabled={!mapToolsEnabled}
              >
                <svg className="map-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polygon points="8,2 14,13 2,13"/>
                  <circle cx="8" cy="2" r="1" fill="currentColor" stroke="none"/>
                  <circle cx="14" cy="13" r="1" fill="currentColor" stroke="none"/>
                  <circle cx="2" cy="13" r="1" fill="currentColor" stroke="none"/>
                </svg>
              </button>
                </div>
              </div>
              <div className="map-tool-group map-tool-group-nav">
                <div className="map-tool-group-title">Nav / Inspect</div>
                <div className="map-tool-buttons">
              <button
                type="button"
                className={`map-btn ${toolButtonClass(state.toolMode, "inspect")}`}
                onClick={() => selectTool("inspect", "inspect")}
                title="Inspección"
                aria-label="Inspección"
                disabled={!mapToolsEnabled}
              >
                <svg className="map-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                  <circle cx="8" cy="7" r="3"/>
                  <line x1="8" y1="1" x2="8" y2="4"/>
                  <line x1="8" y1="10" x2="8" y2="13"/>
                  <line x1="1" y1="7" x2="4" y2="7"/>
                  <line x1="12" y1="7" x2="15" y2="7"/>
                  <line x1="8" y1="13" x2="8" y2="15.5"/>
                </svg>
              </button>
              <button
                type="button"
                className="map-btn map-btn-sep"
                onClick={() => {
                  setCenterRequestKey((value) => value + 1);
                  mapService.centerRobot();
                  runtime.eventBus.emit("console.event", {
                    level: "info",
                    text: "Map centered on robot",
                    timestamp: Date.now()
                  });
                }}
                title="Centrar robot"
                aria-label="Centrar robot"
                disabled={!mapToolsEnabled}
              >
                <svg className="map-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                  <circle cx="8" cy="8" r="5"/>
                  <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none"/>
                  <line x1="8" y1="1" x2="8" y2="3"/>
                  <line x1="8" y1="13" x2="8" y2="15"/>
                  <line x1="1" y1="8" x2="3" y2="8"/>
                  <line x1="13" y1="8" x2="15" y2="8"/>
                </svg>
              </button>
              <button
                type="button"
                className={`map-btn map-btn-close ${state.toolMode !== "idle" ? "active" : ""}`}
                onClick={() => mapService.setToolMode("idle")}
                title="Cerrar herramientas"
                aria-label="Cerrar herramientas"
                disabled={!mapToolsEnabled || state.toolMode === "idle"}
              >
                <svg className="map-btn-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <line x1="4" y1="4" x2="12" y2="12"/>
                  <line x1="12" y1="4" x2="4" y2="12"/>
                </svg>
              </button>
                </div>
              </div>
            </div>
          </>
        ) : null}
        {cameraPaneAvailable && !mainIsMap ? <div className="stage-gps-mini-badge">Map minimapa</div> : null}
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
      ctx.dispatchers.registerDispatcher({
        id: dispatcher.id,
        dispatcher
      });

      const service = new MapService(dispatcher);
      try {
        const connectionService = ctx.services.getService<ConnectionService>(CONNECTION_SERVICE_ID);
        const applyConnectionState = (state: ConnectionState): void => {
          service.setBackendSyncTransportState({
            connected: state.connected === true,
            host: state.host,
            port: state.port
          });
        };
        applyConnectionState(connectionService.getState());
        connectionService.subscribe((state) => applyConnectionState(state));
      } catch {
        service.setBackendSyncTransportState({ connected: false });
      }
      ctx.services.registerService({
        id: SERVICE_ID,
        service
      });

      ctx.contributions.register({
        id: "workspace.map",
        slot: "workspace",
        label: "Map",
        render: () => <MapWorkspaceView runtime={ctx} />
      });
    }
  };
}
