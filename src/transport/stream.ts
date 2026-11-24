import net from "node:net";
import type { AddressInfo } from "node:net";
import type { Duplex, Readable, Writable } from "node:stream";
import { AEP_ERROR_CODES, AepError } from "../core/errors.js";
import type { AepValue, ControlEnvelope } from "../core/types.js";
import { BinaryEnvelopeCodec, JsonTextCodec } from "./codec.js";
import type { Codec, Transport, TransportServer } from "./types.js";

export type StreamFramingMode = "binary" | "ndjson";

export interface StreamTransportOptions {
  framing?: StreamFramingMode;
  codec?: Codec;
  maxFrameBytes?: number;
  peerIdentity?: Record<string, AepValue>;
}

const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024;

export class StreamTransport implements Transport {
  private readonly readable: Readable;
  private readonly writable: Writable;
  private readonly framing: StreamFramingMode;
  private readonly codec: Codec;
  private readonly maxFrameBytes: number;
  private readonly messageHandlers = new Set<(envelope: ControlEnvelope) => void>();
  private readonly closeHandlers = new Set<(error?: Error) => void>();
  private readonly errorHandlers = new Set<(error: Error) => void>();
  private readonly pendingMessages: ControlEnvelope[] = [];
  private binaryBuffer: Buffer = Buffer.alloc(0);
  private ndjsonBuffer = "";
  private closed = false;
  readonly peerIdentity?: Record<string, AepValue>;

  constructor(
    duplexOrReadable: Readable | Duplex,
    writableOrOptions?: Writable | StreamTransportOptions,
    maybeOptions?: StreamTransportOptions,
  ) {
    let readable: Readable;
    let writable: Writable;
    let options: StreamTransportOptions | undefined;

    if (
      writableOrOptions &&
      typeof (writableOrOptions as Writable).write === "function"
    ) {
      readable = duplexOrReadable;
      writable = writableOrOptions as Writable;
      options = maybeOptions;
    } else {
      const duplex = duplexOrReadable as Duplex;
      if (typeof duplex.write !== "function") {
        throw new TypeError("StreamTransport requires either a Duplex stream or (Readable, Writable)");
      }
      readable = duplex;
      writable = duplex;
      options = writableOrOptions as StreamTransportOptions | undefined;
    }

    this.readable = readable;
    this.writable = writable;
    this.framing = options?.framing ?? "binary";
    this.codec =
      options?.codec ??
      (this.framing === "binary" ? new BinaryEnvelopeCodec() : new JsonTextCodec());
    this.maxFrameBytes = options?.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    if (options?.peerIdentity) {
      this.peerIdentity = structuredClone(options.peerIdentity);
    }

    this.attachListeners();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async send(envelope: ControlEnvelope): Promise<void> {
    if (this.closed) {
      throw new Error("StreamTransport is closed");
    }
    const encoded = this.codec.encode(envelope);
    let outChunk: Uint8Array | string;

    if (this.framing === "binary") {
      const payload =
        typeof encoded === "string" ? Buffer.from(encoded, "utf8") : Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength);
      if (payload.byteLength > this.maxFrameBytes) {
        throw new AepError(
          AEP_ERROR_CODES.INVALID_MESSAGE,
          `Encoded frame (${payload.byteLength} bytes) exceeds maxFrameBytes (${this.maxFrameBytes})`,
        );
      }
      const framed = Buffer.allocUnsafe(4 + payload.byteLength);
      framed.writeUInt32BE(payload.byteLength, 0);
      payload.copy(framed, 4);
      outChunk = framed;
    } else {
      const line = typeof encoded === "string" ? encoded : Buffer.from(encoded).toString("utf8");
      outChunk = `${line}\n`;
    }

    await new Promise<void>((resolve, reject) => {
      if (this.closed) {
        reject(new Error("StreamTransport is closed"));
        return;
      }
      this.writable.write(outChunk, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  onMessage(handler: (envelope: ControlEnvelope) => void): () => void {
    this.messageHandlers.add(handler);
    if (this.pendingMessages.length > 0) {
      const queued = this.pendingMessages.splice(0, this.pendingMessages.length);
      for (const msg of queued) {
        handler(msg);
      }
    }
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onClose(handler: (error?: Error) => void): () => void {
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  onError(handler: (error: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => {
      this.errorHandlers.delete(handler);
    };
  }

  async close(reason?: string): Promise<void> {
    if (this.closed) {
      return;
    }
    const err = reason ? new Error(reason) : undefined;
    this.handleClose(err);
    try {
      if (!this.writable.writableEnded) {
        this.writable.end();
      }
    } catch {
      // Ignore stream teardown errors
    }
    if (this.readable !== (this.writable as unknown) && typeof this.readable.destroy === "function") {
      this.readable.destroy();
    }
  }

  private attachListeners(): void {
    this.readable.on("data", this.onData);
    this.readable.on("end", this.onEnd);
    this.readable.on("close", this.onStreamClose);
    this.readable.on("error", this.onStreamError);
    if (this.writable !== (this.readable as unknown)) {
      this.writable.on("error", this.onStreamError);
      this.writable.on("close", this.onStreamClose);
    }
  }

  private detachListeners(): void {
    this.readable.off("data", this.onData);
    this.readable.off("end", this.onEnd);
    this.readable.off("close", this.onStreamClose);
    this.readable.off("error", this.onStreamError);
    if (this.writable !== (this.readable as unknown)) {
      this.writable.off("error", this.onStreamError);
      this.writable.off("close", this.onStreamClose);
    }
  }

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.closed) {
      return;
    }
    try {
      if (this.framing === "binary") {
        const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        this.binaryBuffer =
          this.binaryBuffer.length === 0 ? buf : Buffer.concat([this.binaryBuffer, buf]);
        this.drainBinaryFrames();
      } else {
        const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        this.ndjsonBuffer += str;
        this.drainNdjsonFrames();
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emitError(error);
    }
  };

  private readonly onEnd = (): void => {
    this.handleClose();
  };

  private readonly onStreamClose = (): void => {
    this.handleClose();
  };

  private readonly onStreamError = (err: Error): void => {
    this.emitError(err);
    this.handleClose(err);
  };

  private drainBinaryFrames(): void {
    while (this.binaryBuffer.length >= 4) {
      const frameLen = this.binaryBuffer.readUInt32BE(0);
      if (frameLen > this.maxFrameBytes) {
        const err = new AepError(
          AEP_ERROR_CODES.PARSE_ERROR,
          `Incoming binary frame (${frameLen} bytes) exceeds maxFrameBytes (${this.maxFrameBytes})`,
        );
        this.emitError(err);
        void this.close(err.message);
        return;
      }
      if (this.binaryBuffer.length < 4 + frameLen) {
        break;
      }
      const payload = new Uint8Array(this.binaryBuffer.subarray(4, 4 + frameLen));
      this.binaryBuffer = this.binaryBuffer.subarray(4 + frameLen);
      try {
        const envelope = this.codec.decode(payload);
        this.deliverMessage(envelope);
      } catch (err) {
        this.emitError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private drainNdjsonFrames(): void {
    while (true) {
      const newlineIndex = this.ndjsonBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      const line = this.ndjsonBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.ndjsonBuffer = this.ndjsonBuffer.slice(newlineIndex + 1);
      if (line.trim().length === 0) {
        continue;
      }
      if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes) {
        const err = new AepError(
          AEP_ERROR_CODES.PARSE_ERROR,
          `Incoming NDJSON line exceeds maxFrameBytes (${this.maxFrameBytes})`,
        );
        this.emitError(err);
        void this.close(err.message);
        return;
      }
      try {
        const envelope = this.codec.decode(line);
        this.deliverMessage(envelope);
      } catch (err) {
        this.emitError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private deliverMessage(envelope: ControlEnvelope): void {
    if (this.messageHandlers.size === 0) {
      this.pendingMessages.push(envelope);
      return;
    }
    for (const handler of this.messageHandlers) {
      try {
        handler(envelope);
      } catch (err) {
        this.emitError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private emitError(error: Error): void {
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }

  private handleClose(error?: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.detachListeners();
    for (const handler of this.closeHandlers) {
      handler(error);
    }
  }
}

export class NetStreamServer implements TransportServer {
  private readonly server: net.Server;
  private readonly transportOptions?: StreamTransportOptions;
  private readonly connectionHandlers = new Set<(transport: Transport) => void>();
  private readonly activeTransports = new Set<StreamTransport>();

  constructor(transportOptions?: StreamTransportOptions) {
    this.transportOptions = transportOptions;
    this.server = net.createServer((socket) => {
      const peerIdentity: Record<string, AepValue> = {
        ...(this.transportOptions?.peerIdentity ?? {}),
        ...(socket.remoteAddress ? { remoteAddress: socket.remoteAddress } : {}),
        ...(socket.remotePort !== undefined ? { remotePort: socket.remotePort } : {}),
      };
      const transport = new StreamTransport(socket, {
        ...this.transportOptions,
        peerIdentity,
      });
      this.activeTransports.add(transport);
      transport.onClose(() => {
        this.activeTransports.delete(transport);
      });
      for (const handler of this.connectionHandlers) {
        handler(transport);
      }
    });
  }

  address(): AddressInfo | string | null {
    return this.server.address();
  }

  listen(options: net.ListenOptions): Promise<AddressInfo | string> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        this.server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        this.server.off("error", onError);
        const addr = this.server.address();
        resolve(addr ?? "");
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(options);
    });
  }

  onConnection(handler: (transport: Transport) => void): () => void {
    this.connectionHandlers.add(handler);
    return () => {
      this.connectionHandlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    const transports = [...this.activeTransports];
    this.activeTransports.clear();
    await Promise.all(transports.map((t) => t.close("Server closed")));
    await new Promise<void>((resolve, reject) => {
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
}

export function connectNetStream(
  connectOptions: net.NetConnectOpts,
  transportOptions?: StreamTransportOptions,
): Promise<StreamTransport> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(connectOptions);
    const onError = (err: Error) => {
      socket.off("connect", onConnect);
      reject(err);
    };
    const onConnect = () => {
      socket.off("error", onError);
      resolve(new StreamTransport(socket, transportOptions));
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
}
