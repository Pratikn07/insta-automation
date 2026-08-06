export function compareInboundOrder(
  a: { at: Date; id: string },
  b: { at: Date; id: string },
): number {
  const time = a.at.getTime() - b.at.getTime();
  return time !== 0 ? time : a.id.localeCompare(b.id);
}
