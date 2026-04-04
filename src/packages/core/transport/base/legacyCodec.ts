import type { IncomingPacket, OutgoingPacket } from "../../../../core/types/message";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function encodeLegacyOutgoing(packet: OutgoingPacket): Record<string, unknown> {
  const encoded: Record<string, unknown> = {
    op: packet.op
  };

  const requestId = packet.requestId ?? packet.clientReqId;
  if (requestId) {
    encoded.client_req_id = requestId;
  }

  if (packet.request) {
    encoded.request = packet.request;
  }

  if (isRecord(packet.payload)) {
    Object.assign(encoded, packet.payload);
  } else if (typeof packet.payload !== "undefined") {
    encoded.payload = packet.payload;
  }

  if (packet.meta) {
    encoded.meta = packet.meta;
  }

  return encoded;
}

export function decodeLegacyIncoming(raw: unknown): IncomingPacket | null {
  if (!isRecord(raw)) return null;
  const op = typeof raw.op === "string" ? raw.op : "";
  if (!op) return null;

  const requestId =
    (typeof raw.client_req_id === "string" ? raw.client_req_id : "") ||
    (typeof raw.clientReqId === "string" ? raw.clientReqId : "") ||
    (typeof raw.requestId === "string" ? raw.requestId : "");

  const request = typeof raw.request === "string" ? raw.request : undefined;
  const packet: IncomingPacket = {
    ...(raw as IncomingPacket),
    op,
    requestId: requestId || undefined,
    clientReqId: requestId || undefined,
    request
  };

  return packet;
}
