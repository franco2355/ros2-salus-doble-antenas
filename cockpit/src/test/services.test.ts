import { describe, expect, it, vi } from "vitest";
import { MapService } from "../packages/nav2/modules/map/service/impl/MapService";
import { MissionService } from "../packages/nav2/modules/debug/service/impl/MissionService";
import { NavigationService } from "../packages/nav2/modules/navigation/service/impl/NavigationService";
import { ConnectionService } from "../packages/nav2/modules/navigation/service/impl/ConnectionService";
import type { Nav2IncomingMessage } from "../packages/nav2/protocol/messages";

function installStorageMock(seed: Record<string, string> = {}): void {
  if (typeof window === "undefined") return;
  const state = new Map<string, string>(Object.entries(seed));
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => (state.has(key) ? state.get(key)! : null),
      setItem: (key: string, value: string) => {
        state.set(key, value);
      }
    }
  });
}

describe("services", () => {
  it("uses config defaults for ConnectionService when localStorage is empty", () => {
    installStorageMock();
    const transportManager = {
      getTrafficStats: vi.fn(() => ({ txBytes: 0, rxBytes: 0 })),
      subscribeTraffic: vi.fn(),
      subscribeStatus: vi.fn(() => () => undefined),
      connectTransport: vi.fn(),
      disconnectTransport: vi.fn()
    };
    const env = {
      appName: "test",
      wsUrl: "ws://env-host:9999",
      wsRealHost: "env-real",
      wsSimHost: "env-sim",
      wsDefaultPort: "9999",
      rosbridgeUrl: "",
      httpBaseUrl: "",
      googleMapsApiKey: "",
      cameraIframeUrl: ""
    };
    const eventBus = { emit: vi.fn() };
    const service = new ConnectionService(transportManager as never, env as never, "transport.ws.core", eventBus as never, {
      real: { host: "cfg-real", port: "8766" },
      sim: { host: "cfg-sim", port: "17777" }
    });
    const state = service.getState();
    expect(state.preset).toBe("real");
    expect(state.host).toBe("cfg-real");
    expect(state.port).toBe("8766");
  });

  it("prioritizes localStorage over config defaults for ConnectionService", () => {
    installStorageMock({
      "map_tools.connection_presets.v2": JSON.stringify({
        preset: "sim",
        presets: {
          real: { host: "ls-real", port: "1111" },
          sim: { host: "ls-sim", port: "2222" }
        }
      })
    });
    const transportManager = {
      getTrafficStats: vi.fn(() => ({ txBytes: 0, rxBytes: 0 })),
      subscribeTraffic: vi.fn(),
      subscribeStatus: vi.fn(() => () => undefined),
      connectTransport: vi.fn(),
      disconnectTransport: vi.fn()
    };
    const env = {
      appName: "test",
      wsUrl: "ws://env-host:9999",
      wsRealHost: "env-real",
      wsSimHost: "env-sim",
      wsDefaultPort: "9999",
      rosbridgeUrl: "",
      httpBaseUrl: "",
      googleMapsApiKey: "",
      cameraIframeUrl: ""
    };
    const eventBus = { emit: vi.fn() };
    const service = new ConnectionService(transportManager as never, env as never, "transport.ws.core", eventBus as never, {
      real: { host: "cfg-real", port: "8766" },
      sim: { host: "cfg-sim", port: "17777" }
    });
    const state = service.getState();
    expect(state.preset).toBe("sim");
    expect(state.host).toBe("ls-sim");
    expect(state.port).toBe("2222");
  });

  it("validates goal input in NavigationService", async () => {
    const dispatcher = {
      requestGoal: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "navigation.goal.result",
        ok: true
      }),
      requestControlLock: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        ok: true
      })
    };
    const service = new NavigationService(dispatcher as never);
    await service.unlockControls();
    await expect(service.sendGoal({ x: 1, y: 2, yawDeg: 3 })).resolves.toBeUndefined();
    await expect(service.sendGoal({ x: Number.NaN, y: 2, yawDeg: 3 })).rejects.toThrow("Invalid");
  });

  it("maps response payload in MapService", async () => {
    const dispatcher = {
      requestMap: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "map.loaded",
        ok: true,
        payload: {
          mapId: "map-x",
          title: "Main map",
          originLat: -31.4,
          originLon: -64.1
        } as never
      })
    };
    const service = new MapService(dispatcher as never);
    const map = await service.loadMap("map-x");
    expect(map.mapId).toBe("map-x");
    expect(map.title).toBe("Main map");
  });

  it("marks connection as lost on unexpected transport disconnect", async () => {
    let subscribed = false;
    let onStatus: (status: { connected: boolean; intentional: boolean; reason: string }) => void = () => undefined;
    const transportManager = {
      getTrafficStats: vi.fn(() => ({ txBytes: 0, rxBytes: 0 })),
      subscribeTraffic: vi.fn(() => () => undefined),
      subscribeStatus: vi.fn((_transportId: string, listener: (status: { connected: boolean; intentional: boolean; reason: string }) => void) => {
        subscribed = true;
        onStatus = listener;
        return () => undefined;
      }),
      connectTransport: vi.fn().mockResolvedValue(undefined),
      disconnectTransport: vi.fn().mockResolvedValue(undefined)
    };
    const env = {
      appName: "test",
      wsUrl: "ws://env-host:9999",
      wsRealHost: "env-real",
      wsSimHost: "env-sim",
      wsDefaultPort: "9999",
      rosbridgeUrl: "",
      httpBaseUrl: "",
      googleMapsApiKey: "",
      cameraIframeUrl: ""
    };
    const eventBus = { emit: vi.fn() };
    const service = new ConnectionService(transportManager as never, env as never, "transport.ws.core", eventBus as never);

    await service.connect();
    if (!subscribed) {
      throw new Error("status listener not registered");
    }
    onStatus({
      connected: false,
      intentional: false,
      reason: "backend dropped"
    });

    expect(service.getState()).toMatchObject({
      connected: false,
      lastError: "backend dropped"
    });
    expect(eventBus.emit).toHaveBeenCalledWith(
      "console.event",
      expect.objectContaining({
        level: "error",
        text: "backend dropped"
      })
    );
  });

  it("keeps waypoint state in NavigationService and persists to localStorage", () => {
    const dispatcher = {
      requestGoal: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "navigation.goal.result",
        ok: true
      }),
      requestCancelGoal: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn()
    };
    const service = new NavigationService(dispatcher as never);

    service.queueWaypoint({ x: 1, y: 2, yawDeg: 90 });
    expect(service.getState().waypoints).toHaveLength(1);
    const count = service.saveWaypoints();
    expect(count).toBe(1);

    service.clearWaypoints();
    expect(service.getState().waypoints).toHaveLength(0);
    const loaded = service.loadWaypoints();
    expect(loaded).toBe(1);
    expect(service.getState().waypoints).toHaveLength(1);
  });

  it("supports waypoint selection and selective removal", () => {
    const dispatcher = {
      requestGoal: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "navigation.goal.result",
        ok: true
      }),
      requestCancelGoal: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn()
    };
    const service = new NavigationService(dispatcher as never);

    service.queueWaypoint({ x: 1, y: 1, yawDeg: 0 });
    service.queueWaypoint({ x: 2, y: 2, yawDeg: 0 });
    service.queueWaypoint({ x: 3, y: 3, yawDeg: 0 });
    service.toggleWaypointSelection(0);
    service.toggleWaypointSelection(2);
    expect(service.getState().selectedWaypointIndexes).toEqual([0, 2]);

    const removed = service.removeSelectedWaypoints();
    expect(removed).toBe(2);
    expect(service.getState().waypoints).toHaveLength(1);
    expect(service.getState().waypoints[0]).toMatchObject({ x: 2, y: 2, yawDeg: 0 });
    expect(service.getState().selectedWaypointIndexes).toEqual([]);
  });

  it("sends queued goals through NavigationService", async () => {
    const dispatcher = {
      requestGoal: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "navigation.goal.result",
        ok: true
      }),
      requestCancelGoal: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn(),
      requestControlLock: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        ok: true
      })
    };
    const service = new NavigationService(dispatcher as never);
    await service.unlockControls();
    service.queueWaypoint({ x: 3, y: 4, yawDeg: 0 });
    const sent = await service.sendQueuedGoal({ x: 0, y: 0, yawDeg: 0 });
    expect(sent.sentCount).toBe(1);
    expect(dispatcher.requestGoal).toHaveBeenCalledTimes(1);
  });

  it("sends route missions through NavigationService", async () => {
    const dispatcher = {
      requestGoal: vi.fn(),
      requestRouteMission: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        ok: true,
        input_waypoint_count: 2,
        expanded_waypoint_count: 6
      }),
      requestCancelGoal: vi.fn(),
      requestCancelRouteMission: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn(),
      requestControlLock: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        ok: true
      })
    };
    const service = new NavigationService(dispatcher as never);
    await service.unlockControls();
    service.queueWaypoint({ x: -31.41, y: -64.18, yawDeg: 0 });
    service.queueWaypoint({ x: -31.42, y: -64.19, yawDeg: 45 });

    const started = await service.sendRouteMission();

    expect(started).toMatchObject({
      inputCount: 2,
      expandedCount: 6,
      loopRoute: true
    });
    expect(dispatcher.requestRouteMission).toHaveBeenCalledTimes(1);
    expect(dispatcher.requestRouteMission).toHaveBeenCalledWith(
      expect.objectContaining({
        loop: true,
        waypoints: [
          expect.objectContaining({ lat: -31.41, lon: -64.18, yaw_deg: 0 }),
          expect.objectContaining({ lat: -31.42, lon: -64.19, yaw_deg: 45 })
        ]
      })
    );
  });

  it("updates route mission state from backend payloads", () => {
    const subscribers: {
      state?: (message: Record<string, unknown>) => void;
    } = {};
    const dispatcher = {
      requestGoal: vi.fn(),
      requestRouteMission: vi.fn(),
      requestCancelGoal: vi.fn(),
      requestCancelRouteMission: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn(),
      subscribeState: vi.fn((callback: (message: Record<string, unknown>) => void) => {
        subscribers.state = callback;
        return () => undefined;
      })
    };
    const service = new NavigationService(dispatcher as never);

    subscribers.state?.({
      op: "state",
      route_mission: {
        active: true,
        paused: false,
        loop: true,
        status: "route active [segment 1]",
        input_waypoint_count: 2,
        expanded_waypoint_count: 7,
        current_start_index: 2,
        current_target_index: 4,
        active_chunk_size: 3,
        leg_spacing_m: 1.5,
        chunk_span_m: 12,
        chunk_max_waypoints: 8,
        mission_waypoints: [
          { lat: -31.41, lon: -64.18, yaw_deg: 0 },
          { lat: -31.42, lon: -64.19, yaw_deg: 45 }
        ],
        active_chunk_waypoints: [
          { lat: -31.415, lon: -64.185, yaw_deg: 10 }
        ]
      }
    });

    expect(service.getState().routeMission).toMatchObject({
      active: true,
      paused: false,
      loop: true,
      status: "route active [segment 1]",
      inputWaypointCount: 2,
      expandedWaypointCount: 7,
      currentStartIndex: 2,
      currentTargetIndex: 4,
      activeChunkSize: 3,
      legSpacingM: 1.5,
      chunkSpanM: 12,
      chunkMaxWaypoints: 8
    });
    expect(service.getState().routeMission.missionWaypoints).toHaveLength(2);
    expect(service.getState().routeMission.activeChunkWaypoints).toHaveLength(1);
  });

  it("cancels route missions through NavigationService", async () => {
    const subscribers: {
      state?: (message: Record<string, unknown>) => void;
    } = {};
    const dispatcher = {
      requestGoal: vi.fn(),
      requestRouteMission: vi.fn(),
      requestCancelGoal: vi.fn(),
      requestCancelRouteMission: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        ok: true
      }),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn(),
      subscribeState: vi.fn((callback: (message: Record<string, unknown>) => void) => {
        subscribers.state = callback;
        return () => undefined;
      })
    };
    const service = new NavigationService(dispatcher as never);

    subscribers.state?.({
      op: "state",
      route_mission: {
        active: true,
        paused: false,
        status: "route active",
        active_chunk_size: 2,
        active_chunk_waypoints: [{ lat: -31.415, lon: -64.185, yaw_deg: 10 }]
      }
    });

    await service.cancelRouteMission();

    expect(dispatcher.requestCancelRouteMission).toHaveBeenCalledTimes(1);
    expect(service.getState().routeMission).toMatchObject({
      active: false,
      paused: false,
      status: "route cancelled",
      activeChunkSize: 0
    });
    expect(service.getState().routeMission.activeChunkWaypoints).toEqual([]);
  });

  it("toggles goal mode in NavigationService state", () => {
    const dispatcher = {
      requestGoal: vi.fn(),
      requestCancelGoal: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn()
    };
    const service = new NavigationService(dispatcher as never);
    expect(service.getState().goalMode).toBe(false);
    const next = service.toggleGoalMode();
    expect(next).toBe(true);
    expect(service.getState().goalMode).toBe(true);
  });

  it("applies runtime manual defaults in NavigationService", () => {
    const dispatcher = {
      requestGoal: vi.fn(),
      requestCancelGoal: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn()
    };
    const service = new NavigationService(dispatcher as never, {
      linearSpeed: 1.2,
      angularSpeed: 0.4,
      loopIntervalMs: 50
    });
    service.applyRuntimeDefaults({
      linearSpeed: 2.4,
      angularSpeed: 0.9,
      loopIntervalMs: 90
    });
    const state = service.getState();
    expect(state.manualLinearSpeed).toBe(2.4);
    expect(state.manualAngularSpeed).toBe(0.9);
  });

  it("persists zone state in MapService local storage adapter", () => {
    const service = new MapService({ requestMap: vi.fn() } as never);
    service.addZone("A");
    const savedCount = service.persistZonesToStorage();
    expect(savedCount).toBe(1);
    service.clearZones();
    expect(service.getState().zones).toHaveLength(0);
    const loadedCount = service.loadZonesFromStorage();
    expect(loadedCount).toBe(1);
    expect(service.getState().zones).toHaveLength(1);
  });

  it("validates mission input in MissionService", async () => {
    const dispatcher = {
      startMission: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "mission.start.result",
        ok: true
      }),
      subscribeMissionStatus: vi.fn(() => () => undefined)
    };
    const service = new MissionService(dispatcher as never);
    await expect(service.startMission({ missionId: "m1", robotId: "r1" })).resolves.toBeUndefined();
    await expect(service.startMission({ missionId: "", robotId: "r1" })).rejects.toThrow("required");
  });

  it("starts rosbag recording in MissionService", async () => {
    const dispatcher = {
      startMission: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "mission.start.result",
        ok: true
      }),
      subscribeMissionStatus: vi.fn(() => () => undefined),
      startRosbag: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "rosbag.status.update",
        ok: true,
        payload: { active: true, profile: "core", outputPath: "/tmp/bag", logPath: "/tmp/log" } as never
      }),
      stopRosbag: vi.fn(),
      requestRosbagStatus: vi.fn(),
      subscribeRosbagStatus: vi.fn(() => () => undefined)
    };
    const service = new MissionService(dispatcher as never);
    await expect(service.startRosbag()).resolves.toMatchObject({ active: true, profile: "core" });
  });

  it("runs manual command loop when keys are pressed", async () => {
    const dispatcher = {
      requestGoal: vi.fn(),
      requestCancelGoal: vi.fn(),
      requestManualMode: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        ok: true
      }),
      requestManualCommand: vi
        .fn<(linearX: number, angularZ: number, brake: boolean) => Promise<Nav2IncomingMessage>>()
        .mockResolvedValue({
          op: "ack",
          ok: true
        }),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn(),
      requestControlLock: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        ok: true
      })
    };
    const service = new NavigationService(dispatcher as never);
    await service.unlockControls();
    await service.setManualMode(true);
    service.setManualKeyState("w", true);
    await Promise.resolve();
    expect(dispatcher.requestManualCommand).toHaveBeenCalled();
    const calls = dispatcher.requestManualCommand.mock.calls;
    const [linearX, angularZ, brake] = calls[calls.length - 1] ?? [];
    expect(Number(linearX)).toBeGreaterThan(0);
    expect(Number(angularZ)).toBe(0);
    expect(brake).toBe(false);
    await service.setManualMode(false);
  });

  it("initializes manual defaults in NavigationService constructor", () => {
    const dispatcher = {
      requestGoal: vi.fn(),
      requestCancelGoal: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn()
    };
    const service = new NavigationService(dispatcher as never, {
      linearSpeed: 2.4,
      angularSpeed: 0.9,
      loopIntervalMs: 70
    });
    const state = service.getState();
    expect(state.manualLinearSpeed).toBe(2.4);
    expect(state.manualAngularSpeed).toBe(0.9);
  });

  it("keeps control heartbeat active while locked", async () => {
    vi.useFakeTimers();
    try {
      const dispatcher = {
        requestGoal: vi.fn(),
        requestCancelGoal: vi.fn(),
        requestManualMode: vi.fn(),
        requestManualCommand: vi.fn(),
        requestSnapshot: vi.fn(),
        requestCameraPan: vi.fn(),
        requestCameraZoomToggle: vi.fn(),
        requestCameraStatus: vi.fn(),
        requestControlHeartbeat: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
          op: "ack",
          ok: true
        })
      };
      const service = new NavigationService(dispatcher as never);

      expect(service.getState().controlLocked).toBe(true);
      vi.advanceTimersByTime(1100);
      await Promise.resolve();

      expect(dispatcher.requestControlHeartbeat).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates lock state from ack payloads", () => {
    const subscribers: {
      ack?: (message: Record<string, unknown>) => void;
    } = {};
    const dispatcher = {
      requestGoal: vi.fn(),
      requestCancelGoal: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn(),
      subscribeAck: vi.fn((callback: (message: Record<string, unknown>) => void) => {
        subscribers.ack = callback;
        return () => undefined;
      })
    };
    const service = new NavigationService(dispatcher as never);

    subscribers.ack?.({
      op: "ack",
      payload: {
        control_locked: false,
        control_lock_reason: "REMOTE_UNLOCK"
      }
    });

    const state = service.getState();
    expect(state.controlLocked).toBe(false);
    expect(state.controlLockReason).toBe("REMOTE_UNLOCK");
  });

  it("updates lock state from legacy locked alias in ack payloads", () => {
    const subscribers: {
      ack?: (message: Record<string, unknown>) => void;
    } = {};
    const dispatcher = {
      requestGoal: vi.fn(),
      requestCancelGoal: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn(),
      subscribeAck: vi.fn((callback: (message: Record<string, unknown>) => void) => {
        subscribers.ack = callback;
        return () => undefined;
      })
    };
    const service = new NavigationService(dispatcher as never);

    subscribers.ack?.({
      op: "ack",
      request: "set_control_lock",
      payload: {
        locked: false,
        lock_reason: "REMOTE_UNLOCK"
      }
    });

    const state = service.getState();
    expect(state.controlLocked).toBe(false);
    expect(state.controlLockReason).toBe("REMOTE_UNLOCK");
  });

  it("ignores legacy locked alias on unrelated ack requests", () => {
    const subscribers: {
      ack?: (message: Record<string, unknown>) => void;
    } = {};
    const dispatcher = {
      requestGoal: vi.fn(),
      requestCancelGoal: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn(),
      subscribeAck: vi.fn((callback: (message: Record<string, unknown>) => void) => {
        subscribers.ack = callback;
        return () => undefined;
      })
    };
    const service = new NavigationService(dispatcher as never);

    subscribers.ack?.({
      op: "ack",
      request: "set_manual_mode",
      payload: {
        locked: false,
        lock_reason: "SHOULD_BE_IGNORED"
      }
    });

    const state = service.getState();
    expect(state.controlLocked).toBe(true);
    expect(state.controlLockReason).toBe("locked");
  });

  it("updates lock state from nav_event control lock codes", () => {
    const subscribers: {
      navEvent?: (message: Record<string, unknown>) => void;
    } = {};
    const dispatcher = {
      requestGoal: vi.fn(),
      requestCancelGoal: vi.fn(),
      requestManualMode: vi.fn(),
      requestManualCommand: vi.fn(),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn(),
      subscribeNavEvent: vi.fn((callback: (message: Record<string, unknown>) => void) => {
        subscribers.navEvent = callback;
        return () => undefined;
      })
    };
    const service = new NavigationService(dispatcher as never);

    subscribers.navEvent?.({
      op: "nav_event",
      event: {
        code: "CONTROL_LOCK_RELEASED",
        details: {
          reason: "REMOTE_UNLOCK"
        }
      }
    });

    const state = service.getState();
    expect(state.controlLocked).toBe(false);
    expect(state.controlLockReason).toBe("REMOTE_UNLOCK");
  });
});
