import type { EnvConfig } from "../../../../../../core/config/envConfig";

export interface TransportContext {
  env: EnvConfig;
}

export type TransportReceiveHandler = (message: unknown) => void;
export type TransportStatusHandler = (status: TransportStatus) => void;

export interface TransportStatus {
  connected: boolean;
  intentional: boolean;
  reason: string;
}

export interface Transport {
  id: string;
  kind: string;
  connect(ctx: TransportContext): Promise<void>;
  disconnect(): Promise<void>;
  send(packet: unknown): Promise<void>;
  recv(handler: TransportReceiveHandler): () => void;
  subscribeStatus(handler: TransportStatusHandler): () => void;
}
