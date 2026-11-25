import type { AepValue, ControlEnvelope } from "../core/types.js";
import type { Transport, TransportServer } from "./types.js";

export interface MemoryTransportOptions {
  peerIdentity?: Record<string, AepValue>;
}

export class MemoryTransport implements Transport {
  private peer: MemoryTransport | null = null;
  private closed = false;
  private readonly messageHandlers = new Set<(envelope: ControlEnvelope) => void>();
  private readonly closeHandlers = new Set<(error?: Error) => void>();
  private readonly errorHandlers = new Set<(error: Error) => void>();
  private readonly pendingMessages: ControlEnvelope[] = [];
  readonly peerIdentity?: Record<string, AepValue>;

  constructor(options?: MemoryTransportOptions) {
    if (options?.peerIdentity) {
      this.peerIdentity = structuredClone(options.peerIdentity);
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  attachPeer(peer: MemoryTransport): void {
    this.peer = peer;
  }

  async send(envelope: ControlEnvelope): Promise<void> {
    if (this.closed) {
      throw new Error("MemoryTransport is closed");
    }
    if (!this.peer || this.peer.closed) {
      throw new Error("Peer MemoryTransport is closed or not connected");
    }
    const cloned = structuredClone(envelope);
    const target = this.peer;
    queueMicrotask(() => {
      if (!target.closed) {
        target.deliverMessage(cloned);
      }
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
    this.markClosed(err);
    const peer = this.peer;
    if (peer && !peer.closed) {
      queueMicrotask(() => {
        peer.markClosed(err);
      });
    }
  }

  private deliverMessage(envelope: ControlEnvelope): void {
    if (this.messageHandlers.size === 0) {
      this.pendingMessages.push(envelope);
      return;
    }
    for (const handler of [...this.messageHandlers]) {
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

  private markClosed(error?: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const handler of this.closeHandlers) {
      handler(error);
    }
  }
}

export function createMemoryTransportPair(options?: {
  peerIdentityA?: Record<string, AepValue>;
  peerIdentityB?: Record<string, AepValue>;
}): [MemoryTransport, MemoryTransport] {
  const a = new MemoryTransport({ peerIdentity: options?.peerIdentityA });
  const b = new MemoryTransport({ peerIdentity: options?.peerIdentityB });
  a.attachPeer(b);
  b.attachPeer(a);
  return [a, b];
}

export class MemoryTransportHub implements TransportServer {
  private readonly connectionHandlers = new Set<(transport: Transport) => void>();
  private readonly activeServerTransports = new Set<MemoryTransport>();
  private closed = false;

  onConnection(handler: (transport: Transport) => void): () => void {
    this.connectionHandlers.add(handler);
    return () => {
      this.connectionHandlers.delete(handler);
    };
  }

  connect(options?: {
    clientIdentity?: Record<string, AepValue>;
    serverIdentity?: Record<string, AepValue>;
  }): MemoryTransport {
    if (this.closed) {
      throw new Error("MemoryTransportHub is closed");
    }
    const [clientSide, serverSide] = createMemoryTransportPair({
      peerIdentityA: options?.serverIdentity,
      peerIdentityB: options?.clientIdentity,
    });
    this.activeServerTransports.add(serverSide);
    serverSide.onClose(() => {
      this.activeServerTransports.delete(serverSide);
    });
    for (const handler of this.connectionHandlers) {
      handler(serverSide);
    }
    return clientSide;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const transports = [...this.activeServerTransports];
    this.activeServerTransports.clear();
    await Promise.all(transports.map((t) => t.close("Server closed")));
  }
}
