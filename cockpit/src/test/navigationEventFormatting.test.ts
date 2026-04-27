import { describe, expect, it } from "vitest";
import { formatNavigationEventText } from "../packages/nav2/modules/telemetry/service/impl/TelemetryService";

describe("formatNavigationEventText", () => {
  it("maps Send goal events to operator text", () => {
    expect(
      formatNavigationEventText({
        code: "GOAL_REQUESTED",
        message: "Navigation goal requested",
        details: { waypoints: "1", loop: "false" }
      })
    ).toBe("Navigation requested");

    expect(
      formatNavigationEventText({
        code: "GOAL_RESULT_SUCCEEDED",
        component: "followwaypoints",
        message: "FollowWaypoints result: succeeded"
      })
    ).toBe("Goal reached");
  });

  it("maps route segment and loop events without Nav2 action names", () => {
    expect(
      formatNavigationEventText({
        code: "GOAL_ACCEPTED",
        message: "NavigateThroughPoses goal accepted",
        details: { waypoints: "4", suppress_success_brake: "true" }
      })
    ).toBe("Route segment accepted");

    expect(
      formatNavigationEventText({
        code: "GOAL_RESULT_SUCCEEDED",
        component: "navigatethroughposes",
        message: "NavigateThroughPoses result: succeeded"
      })
    ).toBe("Route segment reached");

    expect(
      formatNavigationEventText({
        code: "GOAL_ACCEPTED",
        message: "NavigateThroughPoses goal accepted",
        details: { reason: "loop_segment_advance", loop: "true" }
      })
    ).toBe("Loop segment accepted");
  });

  it("maps brake, manual takeover, and conversion failures", () => {
    expect(
      formatNavigationEventText({
        code: "BRAKE_APPLIED",
        message: "Brake sequence applied after navigation result"
      })
    ).toBe("Brake applied");

    expect(
      formatNavigationEventText({
        code: "MANUAL_TAKEOVER",
        message: "Manual mode enabled",
        details: { had_goal: "true" }
      })
    ).toBe("Manual takeover: navigation paused");

    expect(
      formatNavigationEventText({
        code: "FROMLL_FAILED",
        message: "fromLL service unavailable"
      })
    ).toBe("GPS conversion service unavailable");
  });
});
