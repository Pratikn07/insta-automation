import { describe, expect, it } from "vitest";
import { preventChartDayPointerFocus } from "@/lib/chartPointerInteraction";

function pointerEvent(pointerType: string): PointerEvent {
  const event = new Event("pointerdown", { cancelable: true }) as PointerEvent;
  Object.defineProperty(event, "pointerType", { value: pointerType });
  return event;
}

describe("chart day pointer focus", () => {
  it("prevents mouse focus from leaving a native outline around a clicked SVG bar", () => {
    const event = pointerEvent("mouse");
    preventChartDayPointerFocus(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("does not cancel touch interaction", () => {
    const event = pointerEvent("touch");
    preventChartDayPointerFocus(event);

    expect(event.defaultPrevented).toBe(false);
  });
});
