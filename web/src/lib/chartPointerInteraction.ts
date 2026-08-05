interface ChartPointerFocusEvent {
  pointerType: string;
  preventDefault(): void;
}

export function preventChartDayPointerFocus(event: ChartPointerFocusEvent) {
  if (event.pointerType === "mouse") event.preventDefault();
}
