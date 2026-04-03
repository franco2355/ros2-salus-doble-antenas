import { describe, expect, it, vi } from "vitest";
import { MapService } from "../services/impl/MapService";
import { MissionService } from "../services/impl/MissionService";
import { NavigationService } from "../services/impl/NavigationService";
import type { IncomingPacket } from "../core/types/message";

describe("services", () => {
  it("validates goal input in NavigationService", async () => {
    const dispatcher = {
      requestGoal: vi.fn<() => Promise<IncomingPacket>>().mockResolvedValue({
        op: "navigation.goal.result",
        ok: true
      }),
      requestControlLock: vi.fn<() => Promise<IncomingPacket>>().mockResolvedValue({
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
      requestMap: vi.fn<() => Promise<IncomingPacket>>().mockResolvedValue({
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

  it("keeps waypoint state in NavigationService and persists to localStorage", () => {
    const dispatcher = {
      requestGoal: vi.fn<() => Promise<IncomingPacket>>().mockResolvedValue({
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
      requestGoal: vi.fn<() => Promise<IncomingPacket>>().mockResolvedValue({
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
      requestGoal: vi.fn<() => Promise<IncomingPacket>>().mockResolvedValue({
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
      requestControlLock: vi.fn<() => Promise<IncomingPacket>>().mockResolvedValue({
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
      startMission: vi.fn<() => Promise<IncomingPacket>>().mockResolvedValue({
        op: "mission.start.result",
        ok: true
      }),
      subscribeMissionStatus: vi.fn(() => () => undefined)
    };
    const service = new MissionService(dispatcher as never);
    await expect(service.startMission({ missionId: "m1", robotId: "r1" })).resolves.toBeUndefined();
    await expect(service.startMission({ missionId: "", robotId: "r1" })).rejects.toThrow("required");
  });

  it("validates rosbag profile input in MissionService", async () => {
    const dispatcher = {
      startMission: vi.fn<() => Promise<IncomingPacket>>().mockResolvedValue({
        op: "mission.start.result",
        ok: true
      }),
      subscribeMissionStatus: vi.fn(() => () => undefined),
      startRosbag: vi.fn<() => Promise<IncomingPacket>>().mockResolvedValue({
        op: "rosbag.status.update",
        ok: true,
        payload: { active: true, profile: "core", outputPath: "/tmp/bag", logPath: "/tmp/log" } as never
      }),
      stopRosbag: vi.fn(),
      requestRosbagStatus: vi.fn(),
      subscribeRosbagStatus: vi.fn(() => () => undefined)
    };
    const service = new MissionService(dispatcher as never);
    await expect(service.startRosbag("core")).resolves.toMatchObject({ active: true, profile: "core" });
    await expect(service.startRosbag("")).rejects.toThrow("required");
  });

  it("runs manual command loop when keys are pressed", async () => {
    const dispatcher = {
      requestGoal: vi.fn(),
      requestCancelGoal: vi.fn(),
      requestManualMode: vi.fn<() => Promise<IncomingPacket>>().mockResolvedValue({
        op: "ack",
        ok: true
      }),
      requestManualCommand: vi
        .fn<(linearX: number, angularZ: number, brake: boolean) => Promise<IncomingPacket>>()
        .mockResolvedValue({
          op: "ack",
          ok: true
        }),
      requestSnapshot: vi.fn(),
      requestCameraPan: vi.fn(),
      requestCameraZoomToggle: vi.fn(),
      requestCameraStatus: vi.fn(),
      requestControlLock: vi.fn<() => Promise<IncomingPacket>>().mockResolvedValue({
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
});
