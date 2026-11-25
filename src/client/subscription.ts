import type {
  ChannelClosedParams,
  ChannelCloseResult,
  ChannelChunkParams,
  ChannelEvent,
  ChannelOpenResult,
  ChannelSeekParams,
  ChannelSeekResult,
  ChannelSendParams,
  ChannelSendResult,
  Direction,
  Path,
  PayloadMode,
  SeekUnit,
  StreamRef,
} from "../core/types.js";

export interface ClientSubscriptionBridge {
  send(params: ChannelSendParams): Promise<ChannelSendResult>;
  seek(params: ChannelSeekParams): Promise<ChannelSeekResult>;
  close(subscriptionId: string): Promise<ChannelCloseResult>;
}

const MAX_PRE_ITERATOR_BUFFER = 256;

export class ClientChannelSubscription implements AsyncIterable<ChannelChunkParams> {
  readonly subscriptionId: string;
  readonly path?: Path;
  readonly resolvedPath?: Path;
  readonly reference: StreamRef;
  readonly direction: Direction;
  readonly payloadMode: PayloadMode;

  private readonly bridge: ClientSubscriptionBridge;
  private readonly chunkHandlers = new Set<(chunk: ChannelChunkParams) => void>();
  private readonly closedHandlers = new Set<(event: ChannelClosedParams) => void>();
  private readonly chunkQueue: ChannelChunkParams[] = [];
  private readonly waiters: Array<(result: IteratorResult<ChannelChunkParams>) => void> = [];
  private iteratorActive = false;
  private closed = false;
  private closedEvent?: ChannelClosedParams;
  private latestSequence = 0;

  constructor(info: ChannelOpenResult, bridge: ClientSubscriptionBridge) {
    this.subscriptionId = info.subscriptionId;
    if (info.path !== undefined) {
      this.path = info.path;
    }
    if (info.resolvedPath !== undefined) {
      this.resolvedPath = info.resolvedPath;
    }
    this.reference = structuredClone(info.reference);
    this.direction = info.direction;
    this.payloadMode = info.payloadMode ?? "binary";
    this.bridge = bridge;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get lastSequence(): number {
    return this.latestSequence;
  }

  async send(
    data: Uint8Array,
    options?: {
      leaseId?: string;
      sequence?: number;
      timestamp?: string;
      mediaType?: string;
      isFinal?: boolean;
    },
  ): Promise<ChannelSendResult> {
    return await this.bridge.send({
      subscriptionId: this.subscriptionId,
      data,
      ...(options?.leaseId !== undefined ? { leaseId: options.leaseId } : {}),
      ...(options?.sequence !== undefined ? { sequence: options.sequence } : {}),
      ...(options?.timestamp !== undefined ? { timestamp: options.timestamp } : {}),
      ...(options?.mediaType !== undefined ? { mediaType: options.mediaType } : {}),
      ...(options?.isFinal !== undefined ? { isFinal: options.isFinal } : {}),
    });
  }

  async sendEvent(
    event: ChannelEvent,
    options?: {
      leaseId?: string;
      sequence?: number;
      timestamp?: string;
      mediaType?: string;
      isFinal?: boolean;
    },
  ): Promise<ChannelSendResult> {
    return await this.bridge.send({
      subscriptionId: this.subscriptionId,
      event,
      ...(options?.leaseId !== undefined ? { leaseId: options.leaseId } : {}),
      ...(options?.sequence !== undefined ? { sequence: options.sequence } : {}),
      ...(options?.timestamp !== undefined ? { timestamp: options.timestamp } : {}),
      ...(options?.mediaType !== undefined ? { mediaType: options.mediaType } : {}),
      ...(options?.isFinal !== undefined ? { isFinal: options.isFinal } : {}),
    });
  }

  async seek(offset: number, unit?: SeekUnit): Promise<ChannelSeekResult> {
    return await this.bridge.seek({
      subscriptionId: this.subscriptionId,
      offset,
      ...(unit !== undefined ? { unit } : {}),
    });
  }

  async close(): Promise<ChannelCloseResult> {
    if (this.closed) {
      return { closed: true, subscriptionId: this.subscriptionId };
    }
    return await this.bridge.close(this.subscriptionId);
  }

  onChunk(handler: (chunk: ChannelChunkParams) => void): () => void {
    this.chunkHandlers.add(handler);
    if (!this.iteratorActive && this.chunkHandlers.size === 1 && this.chunkQueue.length > 0) {
      const buffered = this.chunkQueue.splice(0, this.chunkQueue.length);
      for (const chunk of buffered) {
        handler(chunk);
      }
    }
    return () => {
      this.chunkHandlers.delete(handler);
    };
  }

  onClosed(handler: (event: ChannelClosedParams) => void): () => void {
    this.closedHandlers.add(handler);
    if (this.closed && this.closedEvent) {
      const ev = this.closedEvent;
      queueMicrotask(() => {
        if (this.closedHandlers.has(handler)) {
          handler(ev);
        }
      });
    }
    return () => {
      this.closedHandlers.delete(handler);
    };
  }

  _pushChunk(chunk: ChannelChunkParams): void {
    if (typeof chunk.sequence === "number" && chunk.sequence > this.latestSequence) {
      this.latestSequence = chunk.sequence;
    }
    for (const handler of this.chunkHandlers) {
      handler(chunk);
    }

    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter({ value: chunk, done: false });
      return;
    }

    if (this.iteratorActive || this.chunkHandlers.size === 0) {
      this.chunkQueue.push(chunk);
      if (!this.iteratorActive && this.chunkQueue.length > MAX_PRE_ITERATOR_BUFFER) {
        this.chunkQueue.shift();
      }
    }
  }

  _markClosed(event: ChannelClosedParams): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closedEvent = event;
    for (const handler of this.closedHandlers) {
      handler(event);
    }
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<ChannelChunkParams> {
    this.iteratorActive = true;
    return {
      next: (): Promise<IteratorResult<ChannelChunkParams>> => {
        if (this.chunkQueue.length > 0) {
          const item = this.chunkQueue.shift()!;
          return Promise.resolve({ value: item, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
      },
      return: async (): Promise<IteratorResult<ChannelChunkParams>> => {
        if (!this.closed) {
          await this.close().catch(() => {});
        }
        return { value: undefined, done: true };
      },
    };
  }
}
