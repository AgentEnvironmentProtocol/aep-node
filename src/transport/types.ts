import type { AepValue, ControlEnvelope } from "../core/types.js";

export interface Codec {
  readonly name: string;
  readonly supportsBinary: boolean;
  encode(envelope: ControlEnvelope): Uint8Array | string;
  decode(frame: Uint8Array | string): ControlEnvelope;
}

export interface Transport {
  readonly isClosed: boolean;
  readonly peerIdentity?: Record<string, AepValue>;
  send(envelope: ControlEnvelope): Promise<void>;
  onMessage(handler: (envelope: ControlEnvelope) => void): () => void;
  onClose(handler: (error?: Error) => void): () => void;
  onError(handler: (error: Error) => void): () => void;
  close(reason?: string): Promise<void>;
}

export interface TransportServer {
  onConnection(handler: (transport: Transport) => void): () => void;
  close(): Promise<void>;
}
