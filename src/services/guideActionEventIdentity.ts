import { createHash } from "node:crypto";

const POSTBACK_NAMESPACE = "tinysoho:guide-action-postback:v1:";

export function guidePostbackEventId(providerMid: string): string {
  if (providerMid.trim().length === 0) throw new Error("postback mid is required");
  const bytes = createHash("sha256").update(`${POSTBACK_NAMESPACE}${providerMid}`).digest().subarray(0, 16);

  // RFC 9562 UUIDv8 is reserved for application-defined, name-derived UUIDs.
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
