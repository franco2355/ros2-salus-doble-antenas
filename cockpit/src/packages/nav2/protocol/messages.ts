export interface Nav2OutgoingMessage {
  op: string;
  requestId?: string;
  request?: string;
  payload?: unknown;
  meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Nav2IncomingMessage {
  op: string;
  requestId?: string;
  request?: string;
  ok?: boolean;
  error?: string;
  payload?: unknown;
  meta?: Record<string, unknown>;
  transportId?: string;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const OUTGOING_RESERVED_KEYS = new Set([
  "op",
  "requestId",
  "request",
  "payload",
  "meta",
  "transportId",
  "client_req_id",
  "clientReqId",
  "request_id"
]);

const INCOMING_RESERVED_KEYS = new Set([
  "op",
  "requestId",
  "request",
  "payload",
  "meta",
  "transportId",
  "client_req_id",
  "clientReqId",
  "request_id",
  "ok",
  "error"
]);

function firstNonEmptyString(candidates: unknown[]): string | undefined {
  return candidates
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find((value) => value.length > 0);
}

export function toNav2OutgoingMessage(raw: unknown): Nav2OutgoingMessage {
  if (!isRecord(raw)) {
    throw new Error("Outgoing nav2 message must be an object");
  }
  const op = typeof raw.op === "string" ? raw.op.trim() : "";
  if (!op) {
    throw new Error("Outgoing nav2 message requires a non-empty 'op' field");
  }

  const message: Nav2OutgoingMessage = {
    op
  };
  const requestId = firstNonEmptyString([raw.requestId, raw.client_req_id, raw.clientReqId, raw.request_id]);
  if (requestId) message.requestId = requestId;
  const request = firstNonEmptyString([raw.request]);
  if (request) message.request = request;
  if (Object.prototype.hasOwnProperty.call(raw, "payload")) {
    message.payload = raw.payload;
  }
  if (isRecord(raw.meta)) {
    message.meta = { ...raw.meta };
  }

  Object.entries(raw).forEach(([key, value]) => {
    if (OUTGOING_RESERVED_KEYS.has(key)) return;
    if (value === undefined) return;
    message[key] = value;
  });

  return message;
}

export function encodeNav2Outgoing(message: Nav2OutgoingMessage): Record<string, unknown> {
  const encoded: Record<string, unknown> = {
    op: message.op
  };
  if (message.requestId) {
    encoded.requestId = message.requestId;
    encoded.client_req_id = message.requestId;
  }
  if (message.request) {
    encoded.request = message.request;
  }
  if (Object.prototype.hasOwnProperty.call(message, "payload")) {
    encoded.payload = message.payload;
  }
  if (isRecord(message.payload)) {
    Object.entries(message.payload).forEach(([key, value]) => {
      if (OUTGOING_RESERVED_KEYS.has(key)) return;
      if (value === undefined) return;
      if (Object.prototype.hasOwnProperty.call(encoded, key)) return;
      encoded[key] = value;
    });
  }
  if (message.meta) {
    encoded.meta = message.meta;
  }
  Object.entries(message).forEach(([key, value]) => {
    if (OUTGOING_RESERVED_KEYS.has(key)) return;
    if (value === undefined) return;
    encoded[key] = value;
  });
  return encoded;
}

export function decodeNav2Incoming(raw: unknown): Nav2IncomingMessage | null {
  if (!isRecord(raw)) return null;
  const op = typeof raw.op === "string" ? raw.op.trim() : "";
  if (!op) return null;

  const payload = Object.prototype.hasOwnProperty.call(raw, "payload") ? raw.payload : undefined;
  const payloadRecord = isRecord(payload) ? payload : null;
  const requestId = firstNonEmptyString([
    raw.requestId,
    raw.client_req_id,
    raw.clientReqId,
    raw.request_id,
    payloadRecord?.requestId,
    payloadRecord?.client_req_id,
    payloadRecord?.clientReqId,
    payloadRecord?.request_id
  ]);
  const request = firstNonEmptyString([raw.request, payloadRecord?.request]);
  const okSource = typeof raw.ok === "boolean" ? raw.ok : typeof payloadRecord?.ok === "boolean" ? payloadRecord.ok : undefined;
  const ok = typeof okSource === "boolean" ? okSource : undefined;
  const error = firstNonEmptyString([raw.error, payloadRecord?.error]);
  const meta = isRecord(raw.meta) ? { ...raw.meta } : undefined;

  const message: Nav2IncomingMessage = {
    ...raw,
    op,
    requestId,
    request,
    ok,
    error,
    payload,
    meta
  };

  if (payloadRecord) {
    Object.entries(payloadRecord).forEach(([key, value]) => {
      if (INCOMING_RESERVED_KEYS.has(key)) return;
      if (value === undefined) return;
      if (Object.prototype.hasOwnProperty.call(message, key)) return;
      message[key] = value;
    });
  }
  return message;
}

export function isNav2IncomingMessage(value: unknown): value is Nav2IncomingMessage {
  return decodeNav2Incoming(value) !== null;
}
