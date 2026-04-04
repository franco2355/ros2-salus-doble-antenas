import type { EnvConfig } from "../../../../core/config/envConfig";
import type { IncomingPacket, OutgoingPacket } from "../../../../core/types/message";

export interface TransportContext {
  env: EnvConfig;
}

export type TransportReceiveHandler = (message: IncomingPacket) => void;

export interface Transport {
  id: string;
  kind: string;
  connect(ctx: TransportContext): Promise<void>;
  disconnect(): Promise<void>;
  send(packet: OutgoingPacket): Promise<void>;
  recv(handler: TransportReceiveHandler): () => void;
}

