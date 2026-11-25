import { createHash } from "node:crypto";
import http from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { AEP_ERROR_CODES, AepError } from "../core/errors.js";
import { AEP_WEBSOCKET_SUBPROTOCOL, type AepValue, type ControlEnvelope } from "../core/types.js";
import { BinaryEnvelopeCodec, JsonTextCodec } from "./codec.js";
import type { Codec, Transport, TransportServer } from "./types.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024;

export type WebSocketTransportMode = "binary" | "json";

export interface WebSocketLike {
  readonly readyState: number;
  readonly protocol?: string;
  binaryType?: string;
  send(data: string | Uint8Array<ArrayBuffer> | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void;
  removeEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void;
}

export interface WebSocketTransportOptions {
  mode?: WebSocketTransportMode;
  protocol?: string;
  binaryCodec?: Codec;
  jsonCodec?: Codec;
  peerIdentity?: Record<string, AepValue>;
}

const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

export class WebSocketTransport implements Transport {
  private readonly socket: WebSocketLike;
  private readonly mode: WebSocketTransportMode;
  private readonly binaryCodec: Codec;
  private readonly jsonCodec: Codec;
  private readonly messageHandlers = new Set<(envelope: ControlEnvelope) => void>();
  private readonly closeHandlers = new Set<(error?: Error) => void>();
  private readonly errorHandlers = new Set<(error: Error) => void>();
  private readonly pendingMessages: ControlEnvelope[] = [];
  private closed = false;
  private asyncChain: Promise<void> = Promise.resolve();
  private hasPendingAsync = false;
  readonly protocol?: string;
  readonly peerIdentity?: Record<string, AepValue>;

  constructor(socket: WebSocketLike, options?: WebSocketTransportOptions) {
    this.socket = socket;
    this.mode = options?.mode ?? "binary";
    this.protocol = options?.protocol ?? (socket.protocol ? socket.protocol : undefined);
    this.binaryCodec = options?.binaryCodec ?? new BinaryEnvelopeCodec();
    this.jsonCodec = options?.jsonCodec ?? new JsonTextCodec();
    if (options?.peerIdentity) {
      this.peerIdentity = structuredClone(options.peerIdentity);
    }
    try {
      this.socket.binaryType = "arraybuffer";
    } catch {
      // Ignore read-only binaryType implementations
    }

    if (this.socket.readyState === WS_CLOSING || this.socket.readyState === WS_CLOSED) {
      this.closed = true;
    }

    this.socket.addEventListener("message", this.onSocketMessage);
    this.socket.addEventListener("close", this.onSocketClose);
    this.socket.addEventListener("error", this.onSocketError);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async send(envelope: ControlEnvelope): Promise<void> {
    if (this.closed || this.socket.readyState !== WS_OPEN) {
      throw new Error("WebSocketTransport is closed or not open");
    }
    const payload =
      this.mode === "binary" ? this.binaryCodec.encode(envelope) : this.jsonCodec.encode(envelope);
    if (typeof payload === "string") {
      this.socket.send(payload);
    } else if (payload.buffer instanceof ArrayBuffer) {
      this.socket.send(payload as Uint8Array<ArrayBuffer>);
    } else {
      this.socket.send(new Uint8Array(payload));
    }
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
      if (this.socket.readyState === WS_OPEN) {
        this.socket.close(1000, reason?.slice(0, 120));
      }
    } catch {
      // Ignore close errors
    }
  }

  private readonly onSocketMessage = (event: { data?: unknown }): void => {
    if (this.closed) {
      return;
    }
    const data = event?.data;
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      this.hasPendingAsync = true;
      this.asyncChain = this.asyncChain
        .then(async () => {
          const ab = await data.arrayBuffer();
          if (!this.closed) {
            this.decodeAndDeliver(new Uint8Array(ab));
          }
        })
        .catch((err) => {
          this.emitError(err instanceof Error ? err : new Error(String(err)));
        })
        .finally(() => {
          this.hasPendingAsync = false;
        });
      return;
    }

    if (this.hasPendingAsync) {
      this.asyncChain = this.asyncChain.then(() => {
        if (!this.closed) {
          this.decodeAndDeliver(data);
        }
      });
      return;
    }

    this.decodeAndDeliver(data);
  };

  private readonly onSocketClose = (event?: { code?: number; reason?: string }): void => {
    const reason =
      event?.reason && event.reason.length > 0
        ? event.reason
        : event?.code && event.code !== 1000 && event.code !== 1005
          ? `WebSocket closed with code ${event.code}`
          : undefined;
    this.handleClose(reason ? new Error(reason) : undefined);
  };

  private readonly onSocketError = (event?: { error?: unknown; message?: string }): void => {
    const err =
      event?.error instanceof Error
        ? event.error
        : new Error(event?.message ?? "WebSocket transport error");
    this.emitError(err);
  };

  private decodeAndDeliver(data: unknown): void {
    try {
      let envelope: ControlEnvelope;
      if (typeof data === "string") {
        envelope = this.jsonCodec.decode(data);
      } else if (data instanceof ArrayBuffer) {
        envelope = this.binaryCodec.decode(new Uint8Array(data));
      } else if (data instanceof Uint8Array) {
        envelope = this.binaryCodec.decode(data);
      } else if (ArrayBuffer.isView(data)) {
        envelope = this.binaryCodec.decode(
          new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        );
      } else {
        throw new AepError(AEP_ERROR_CODES.PARSE_ERROR, "Unsupported WebSocket frame payload");
      }
      this.deliverMessage(envelope);
    } catch (err) {
      this.emitError(err instanceof Error ? err : new Error(String(err)));
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
    this.socket.removeEventListener("message", this.onSocketMessage);
    this.socket.removeEventListener("close", this.onSocketClose);
    this.socket.removeEventListener("error", this.onSocketError);
    for (const handler of this.closeHandlers) {
      handler(error);
    }
  }
}

export interface ConnectWebSocketOptions extends WebSocketTransportOptions {
  protocols?: string | string[];
}

export function connectWebSocket(
  url: string | URL,
  options?: ConnectWebSocketOptions,
): Promise<WebSocketTransport> {
  return new Promise((resolve, reject) => {
    const WebSocketCtor = globalThis.WebSocket;
    if (typeof WebSocketCtor !== "function") {
      reject(new Error("Global WebSocket constructor is not available in this runtime"));
      return;
    }
    const protocols =
      options?.protocols === undefined ? [AEP_WEBSOCKET_SUBPROTOCOL] : options.protocols;
    const hasProtocols =
      typeof protocols === "string" ? protocols.length > 0 : protocols.length > 0;
    const ws = hasProtocols
      ? new WebSocketCtor(url, protocols as string | string[])
      : new WebSocketCtor(url);
    ws.binaryType = "arraybuffer";

    let settled = false;
    const cleanup = () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
    };
    const onOpen = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      const negotiatedProto =
        typeof (ws as { protocol?: unknown }).protocol === "string" &&
        (ws as { protocol: string }).protocol.length > 0
          ? (ws as { protocol: string }).protocol
          : undefined;
      resolve(
        new WebSocketTransport(ws, {
          ...options,
          ...(negotiatedProto !== undefined ? { protocol: negotiatedProto } : {}),
        }),
      );
    };
    const onError = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error(`Failed to connect WebSocket to ${String(url)}`));
    };
    const onClose = (event: { code?: number; reason?: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(
        new Error(
          `WebSocket closed before open (code=${event?.code ?? 0}, reason=${event?.reason ?? ""})`,
        ),
      );
    };

    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
  });
}

class Rfc6455ServerSocket implements WebSocketLike {
  readyState: number = WS_OPEN;
  binaryType = "arraybuffer";

  private readonly socket: Socket;
  private readonly maxFrameBytes: number;
  private readonly listeners: Record<
    "open" | "message" | "close" | "error",
    Set<(event: any) => void>
  > = {
    open: new Set(),
    message: new Set(),
    close: new Set(),
    error: new Set(),
  };

  private buffer: Buffer = Buffer.alloc(0);
  private fragmentOpcode: number | null = null;
  private fragmentChunks: Buffer[] = [];
  private fragmentTotalBytes = 0;
  private closeFrameSent = false;

  constructor(socket: Socket, initialHead: Buffer, maxFrameBytes: number) {
    this.socket = socket;
    this.maxFrameBytes = maxFrameBytes;

    this.socket.on("data", this.onData);
    this.socket.on("close", this.onTcpClose);
    this.socket.on("error", this.onTcpError);

    if (initialHead.length > 0) {
      this.onData(initialHead);
    }
  }

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: any) => void,
  ): void {
    this.listeners[type].add(listener);
  }

  removeEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: any) => void,
  ): void {
    this.listeners[type].delete(listener);
  }

  send(data: string | Uint8Array | ArrayBuffer): void {
    if (this.readyState !== WS_OPEN) {
      throw new Error("WebSocket server socket is not open");
    }
    if (typeof data === "string") {
      this.sendFrame(0x1, Buffer.from(data, "utf8"));
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.sendFrame(0x2, Buffer.from(data));
      return;
    }
    this.sendFrame(0x2, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  }

  close(code = 1000, reason?: string): void {
    if (this.readyState === WS_CLOSED) {
      return;
    }
    this.readyState = WS_CLOSING;
    if (!this.closeFrameSent && !this.socket.destroyed) {
      this.closeFrameSent = true;
      const reasonBuf = reason ? Buffer.from(reason, "utf8").subarray(0, 123) : Buffer.alloc(0);
      const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
      payload.writeUInt16BE(code, 0);
      reasonBuf.copy(payload, 2);
      try {
        this.sendFrame(0x8, payload);
      } catch {
        // Ignore write failures during close
      }
    }
    this.socket.end();
  }

  private emit(type: "open" | "message" | "close" | "error", event: unknown): void {
    for (const listener of this.listeners[type]) {
      listener(event);
    }
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    if (this.socket.destroyed) {
      return;
    }
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len <= 0xffff) {
      header = Buffer.allocUnsafe(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  private readonly onData = (chunk: Buffer): void => {
    if (this.readyState === WS_CLOSED) {
      return;
    }
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    this.drainFrames();
  };

  private readonly onTcpClose = (): void => {
    this.finishClose(1000, "");
  };

  private readonly onTcpError = (err: Error): void => {
    this.emit("error", { error: err, message: err.message });
    this.finishClose(1006, err.message);
  };

  private finishClose(code: number, reason: string): void {
    if (this.readyState === WS_CLOSED) {
      return;
    }
    this.readyState = WS_CLOSED;
    this.socket.off("data", this.onData);
    this.socket.off("close", this.onTcpClose);
    this.socket.off("error", this.onTcpError);
    this.emit("close", { code, reason });
  }

  private drainFrames(): void {
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0]!;
      const b1 = this.buffer[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (!masked) {
        this.emit("error", { message: "Client WebSocket frames must be masked" });
        this.close(1002, "Protocol error");
        this.socket.destroy();
        return;
      }

      if (len === 126) {
        if (this.buffer.length < 4) {
          return;
        }
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) {
          return;
        }
        const bigLen = this.buffer.readBigUInt64BE(2);
        if (bigLen > BigInt(this.maxFrameBytes) || bigLen > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.emit("error", { message: "WebSocket frame exceeds maximum size" });
          this.close(1009, "Message too big");
          this.socket.destroy();
          return;
        }
        len = Number(bigLen);
        offset = 10;
      }

      if (len > this.maxFrameBytes) {
        this.emit("error", { message: "WebSocket frame exceeds maximum size" });
        this.close(1009, "Message too big");
        this.socket.destroy();
        return;
      }

      const totalFrameBytes = offset + 4 + len;
      if (this.buffer.length < totalFrameBytes) {
        return;
      }

      const maskKey = this.buffer.subarray(offset, offset + 4);
      const maskedPayload = this.buffer.subarray(offset + 4, totalFrameBytes);
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i += 1) {
        payload[i] = maskedPayload[i]! ^ maskKey[i & 3]!;
      }
      this.buffer = this.buffer.subarray(totalFrameBytes);

      if (opcode === 0x8) {
        let code = 1000;
        let reason = "";
        if (payload.length >= 2) {
          code = payload.readUInt16BE(0);
          reason = payload.subarray(2).toString("utf8");
        }
        if (!this.closeFrameSent) {
          this.close(code, reason);
        } else {
          this.socket.end();
        }
        this.finishClose(code, reason);
        return;
      }

      if (opcode === 0x9) {
        this.sendFrame(0xA, payload);
        continue;
      }

      if (opcode === 0xA) {
        continue;
      }

      if (opcode === 0x1 || opcode === 0x2) {
        if (this.fragmentOpcode !== null) {
          this.close(1002, "Unexpected non-continuation frame");
          this.socket.destroy();
          return;
        }
        if (!fin) {
          this.fragmentOpcode = opcode;
          this.fragmentChunks = [payload];
          this.fragmentTotalBytes = payload.length;
        } else {
          const delivered = opcode === 0x1 ? payload.toString("utf8") : new Uint8Array(payload);
          this.emit("message", { data: delivered });
        }
        continue;
      }

      if (opcode === 0x0) {
        if (this.fragmentOpcode === null) {
          this.close(1002, "Unexpected continuation frame");
          this.socket.destroy();
          return;
        }
        this.fragmentTotalBytes += payload.length;
        if (this.fragmentTotalBytes > this.maxFrameBytes) {
          this.close(1009, "Message too big");
          this.socket.destroy();
          return;
        }
        this.fragmentChunks.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragmentChunks, this.fragmentTotalBytes);
          const dataOpcode = this.fragmentOpcode;
          this.fragmentOpcode = null;
          this.fragmentChunks = [];
          this.fragmentTotalBytes = 0;
          const delivered = dataOpcode === 0x1 ? full.toString("utf8") : new Uint8Array(full);
          this.emit("message", { data: delivered });
        }
        continue;
      }

      this.close(1002, "Unsupported WebSocket opcode");
      this.socket.destroy();
      return;
    }
  }
}

export interface WebSocketTransportServerOptions extends WebSocketTransportOptions {
  path?: string;
  maxFrameBytes?: number;
  server?: http.Server;
  subprotocols?: string[];
  requireSubprotocol?: boolean;
  verifyClient?: (
    req: IncomingMessage,
  ) => Record<string, AepValue> | null | Promise<Record<string, AepValue> | null>;
}

export class WebSocketTransportServer implements TransportServer {
  private readonly httpServer: http.Server;
  private readonly ownsHttpServer: boolean;
  private readonly options: WebSocketTransportServerOptions;
  private readonly maxFrameBytes: number;
  private readonly connectionHandlers = new Set<(transport: Transport) => void>();
  private readonly activeTransports = new Set<WebSocketTransport>();
  private closed = false;

  constructor(options: WebSocketTransportServerOptions = {}) {
    this.options = options;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    if (options.server) {
      this.httpServer = options.server;
      this.ownsHttpServer = false;
    } else {
      this.httpServer = http.createServer((_req, res) => {
        res.statusCode = 426;
        res.setHeader("Content-Type", "text/plain");
        res.end("Upgrade Required");
      });
      this.ownsHttpServer = true;
    }
    this.httpServer.on("upgrade", this.onUpgrade);
  }

  get port(): number | undefined {
    const addr = this.httpServer.address();
    if (addr && typeof addr === "object") {
      return addr.port;
    }
    return undefined;
  }

  address(): AddressInfo | string | null {
    return this.httpServer.address();
  }

  listen(port = 0, host = "127.0.0.1"): Promise<AddressInfo> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        this.httpServer.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        this.httpServer.off("error", onError);
        const addr = this.httpServer.address();
        if (addr && typeof addr === "object") {
          resolve(addr);
        } else {
          reject(new Error("WebSocketTransportServer did not bind to a network address"));
        }
      };
      this.httpServer.once("error", onError);
      this.httpServer.once("listening", onListening);
      this.httpServer.listen(port, host);
    });
  }

  onConnection(handler: (transport: Transport) => void): () => void {
    this.connectionHandlers.add(handler);
    return () => {
      this.connectionHandlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.httpServer.off("upgrade", this.onUpgrade);
    const transports = [...this.activeTransports];
    this.activeTransports.clear();
    await Promise.all(transports.map((t) => t.close("Server closed")));
    if (this.ownsHttpServer && this.httpServer.listening) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    }
  }

  private readonly onUpgrade = (
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): void => {
    void this.handleUpgrade(req, socket, head);
  };

  private async handleUpgrade(
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): Promise<void> {
    if (this.closed) {
      socket.destroy();
      return;
    }

    if (this.options.path !== undefined) {
      const parsedUrl = new URL(req.url ?? "/", "http://localhost");
      if (parsedUrl.pathname !== this.options.path) {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    const upgradeHeader = req.headers["upgrade"];
    const wsKey = req.headers["sec-websocket-key"];
    if (
      typeof upgradeHeader !== "string" ||
      upgradeHeader.toLowerCase() !== "websocket" ||
      typeof wsKey !== "string" ||
      wsKey.length === 0
    ) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const allowedSubprotocols = this.options.subprotocols ?? [AEP_WEBSOCKET_SUBPROTOCOL];
    const rawProtoHeader = req.headers["sec-websocket-protocol"];
    const offeredSubprotocols: string[] =
      typeof rawProtoHeader === "string"
        ? rawProtoHeader
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : [];

    let selectedSubprotocol: string | undefined;
    if (offeredSubprotocols.length > 0) {
      selectedSubprotocol = offeredSubprotocols.find((p) => allowedSubprotocols.includes(p));
      if (!selectedSubprotocol) {
        socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
    } else if (this.options.requireSubprotocol) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    let verifiedIdentity: Record<string, AepValue> | undefined = this.options.peerIdentity
      ? structuredClone(this.options.peerIdentity)
      : undefined;

    if (this.options.verifyClient) {
      try {
        const res = await this.options.verifyClient(req);
        if (res === null) {
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        verifiedIdentity = { ...(verifiedIdentity ?? {}), ...res };
      } catch {
        socket.write("HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    if (this.closed || socket.destroyed) {
      socket.destroy();
      return;
    }

    const acceptKey = createHash("sha1").update(`${wsKey}${WS_GUID}`).digest("base64");
    const subprotocolLine = selectedSubprotocol
      ? `Sec-WebSocket-Protocol: ${selectedSubprotocol}\r\n`
      : "";
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey}\r\n${subprotocolLine}\r\n`,
    );

    const serverSocket = new Rfc6455ServerSocket(socket, head, this.maxFrameBytes);
    const transport = new WebSocketTransport(serverSocket, {
      mode: this.options.mode,
      ...(selectedSubprotocol !== undefined ? { protocol: selectedSubprotocol } : {}),
      binaryCodec: this.options.binaryCodec,
      jsonCodec: this.options.jsonCodec,
      peerIdentity: verifiedIdentity,
    });

    this.activeTransports.add(transport);
    transport.onClose(() => {
      this.activeTransports.delete(transport);
    });

    for (const handler of this.connectionHandlers) {
      handler(transport);
    }
  }
}
