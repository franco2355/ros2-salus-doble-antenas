import type { MapDispatcher } from "../../dispatcher/impl/MapDispatcher";

export interface MapData {
  mapId: string;
  title: string;
  originLat: number;
  originLon: number;
}

export type MapToolMode = "idle" | "ruler" | "area" | "inspect";

export interface ZoneEntry {
  id: string;
  name: string;
  vertices: number;
  updatedAt: number;
}

export interface MapWorkspaceState {
  map: MapData | null;
  toolMode: MapToolMode;
  toolInfo: string;
  autoSync: boolean;
  zones: ZoneEntry[];
  inspectCoords: string;
}

export class MapService {
  private readonly listeners = new Set<(state: MapWorkspaceState) => void>();
  private state: MapWorkspaceState = {
    map: null,
    toolMode: "idle",
    toolInfo: "Map tools idle.",
    autoSync: true,
    zones: [],
    inspectCoords: "n/a"
  };
  private savedZonesPayload = "[]";

  constructor(private readonly mapDispatcher: MapDispatcher) {}

  async loadMap(mapId: string): Promise<MapData> {
    if (!mapId.trim()) {
      throw new Error("mapId is required");
    }

    const response = await this.mapDispatcher.requestMap(mapId);
    if (response.ok === false) {
      throw new Error(response.error ?? "Map request failed");
    }

    const payload = (response.payload ?? {}) as Record<string, unknown>;
    const loaded: MapData = {
      mapId: String(payload.mapId ?? mapId),
      title: String(payload.title ?? mapId),
      originLat: Number(payload.originLat ?? 0),
      originLon: Number(payload.originLon ?? 0)
    };

    this.state = {
      ...this.state,
      map: loaded
    };
    this.emit();
    return loaded;
  }

  getState(): MapWorkspaceState {
    return {
      ...this.state,
      map: this.state.map ? { ...this.state.map } : null,
      zones: this.state.zones.map((entry) => ({ ...entry }))
    };
  }

  subscribe(callback: (state: MapWorkspaceState) => void): () => void {
    this.listeners.add(callback);
    callback(this.getState());
    return () => {
      this.listeners.delete(callback);
    };
  }

  setToolMode(mode: MapToolMode): void {
    const toolInfo =
      mode === "idle"
        ? "Map tools idle."
        : mode === "ruler"
          ? "Ruler mode active. Click points to measure distance."
          : mode === "area"
            ? "Area mode active. Draw a polygon to estimate area."
            : "Inspect mode active. Click map to inspect coordinates.";

    this.state = {
      ...this.state,
      toolMode: mode,
      toolInfo
    };
    this.emit();
  }

  setAutoSync(enabled: boolean): void {
    this.state = {
      ...this.state,
      autoSync: enabled
    };
    this.emit();
  }

  addZone(name?: string): ZoneEntry {
    const zone: ZoneEntry = {
      id: `zone.${Date.now()}.${Math.floor(Math.random() * 10_000)}`,
      name: name?.trim() ? name.trim() : `Zone ${this.state.zones.length + 1}`,
      vertices: 4,
      updatedAt: Date.now()
    };
    this.state = {
      ...this.state,
      zones: [zone, ...this.state.zones].slice(0, 40)
    };
    this.emit();
    return zone;
  }

  removeZone(zoneId: string): void {
    this.state = {
      ...this.state,
      zones: this.state.zones.filter((zone) => zone.id !== zoneId)
    };
    this.emit();
  }

  clearZones(): void {
    this.state = {
      ...this.state,
      zones: []
    };
    this.emit();
  }

  refreshZones(): void {
    const now = Date.now();
    const nextZones =
      this.state.zones.length > 0
        ? this.state.zones.map((zone) => ({ ...zone, updatedAt: now }))
        : [
            {
              id: `zone.seed.${now}`,
              name: "No-go default",
              vertices: 5,
              updatedAt: now
            }
          ];
    this.state = {
      ...this.state,
      zones: nextZones
    };
    this.emit();
  }

  saveZones(): string {
    this.savedZonesPayload = JSON.stringify(this.state.zones);
    return this.savedZonesPayload;
  }

  loadZones(payload?: string): void {
    const source = payload ?? this.savedZonesPayload;
    const parsed = JSON.parse(source) as ZoneEntry[];
    this.state = {
      ...this.state,
      zones: Array.isArray(parsed) ? parsed.map((zone) => ({ ...zone })) : []
    };
    this.emit();
  }

  setInspectCoords(lat: number, lon: number): void {
    this.state = {
      ...this.state,
      inspectCoords: `${lat.toFixed(6)}, ${lon.toFixed(6)}`
    };
    this.emit();
  }

  centerRobot(): void {
    this.state = {
      ...this.state,
      toolInfo: "Centered map on robot pose."
    };
    this.emit();
  }

  setDatumFromRobot(): void {
    this.state = {
      ...this.state,
      toolInfo: "Datum updated from current robot pose."
    };
    this.emit();
  }

  private emit(): void {
    const state = this.getState();
    this.listeners.forEach((listener) => listener(state));
  }
}
