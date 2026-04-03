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
      })
    };
    const service = new NavigationService(dispatcher as never);
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
});

