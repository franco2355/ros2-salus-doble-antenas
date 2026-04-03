export type Primitive = string | number | boolean | null;
export type MessagePayload = Primitive | MessagePayload[] | { [key: string]: MessagePayload };

export interface OutgoingPacket {
  op: string;
  requestId?: string;
  payload?: MessagePayload;
  meta?: Record<string, MessagePayload>;
}

export interface IncomingPacket {
  op: string;
  requestId?: string;
  ok?: boolean;
  error?: string;
  payload?: MessagePayload;
  meta?: Record<string, MessagePayload>;
  transportId?: string;
}

export type MessageHandler = (message: IncomingPacket) => void;

