import { AEP_ERROR_CODES, AepError } from "../core/errors.js";
import { splitParentPath } from "../core/path.js";
import { buildCapabilities } from "../core/profiles.js";
import { cloneNode, findNodeInChildren } from "../core/tree-utils.js";
import {
  AEP_PROTOCOL_VERSION,
  HEAD_KEYS,
  type AepNode,
  type BodyChild,
  type CapabilitiesObject,
  type ChannelClosedParams,
  type ChannelCloseResult,
  type ChannelChunkParams,
  type ChannelOpenParams,
  type ChannelOpenResult,
  type ChannelSampleParams,
  type ChannelSampleResult,
  type ChannelSeekParams,
  type ChannelSeekResult,
  type ChannelSendParams,
  type ChannelSendResult,
  type ClientInfo,
  type ControlEnvelope,
  type GetBinaryOptions,
  type GetBinaryResult,
  type HeadUpdatedParams,
  type MetaMap,
  type NodeAddedParams,
  type NodeEventParams,
  type NodeGetResult,
  type NodeInvokeResult,
  type NodeLoadChildrenResult,
  type NodeRemovedParams,
  type NodeUpdatedParams,
  type NotificationEnvelope,
  type Path,
  type SecurityDescriptor,
  type ServerInfo,
  type SessionDescriptor,
  type SessionInitializeParams,
  type SessionInitializeResult,
  type SessionRole,
  type TreeGetParams,
  type TreeGetResult,
  type TreeQueryParams,
  type TreeQueryResult,
} from "../core/types.js";
import type { Transport } from "../transport/types.js";
import { ClientChannelSubscription } from "./subscription.js";

export interface AepClientOptions {
  clientInfo?: ClientInfo;
  supportedVersions?: string[];
  capabilities?: "aep-core-static" | "aep-core-streaming" | Partial<CapabilitiesObject>;
  security?: SecurityDescriptor;
  session?: {
    role?: SessionRole;
    allowDowngradeToObserver?: boolean;
  };
  requestTimeoutMs?: number;
  syncTree?: boolean;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  onResult?: (result: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_CLIENT_INFO: ClientInfo = {
  name: "aep-node-client",
  version: "0.1.0",
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class AepClient {
  private readonly transport: Transport;
  private readonly options: AepClientOptions;
  private readonly requestTimeoutMs: number;
  private readonly syncTree: boolean;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly subscriptions = new Map<string, ClientChannelSubscription>();
  private readonly unsubscribers: Array<() => void> = [];

  private nextRequestSeq = 1;
  private initialized = false;
  private closed = false;
  private currentProtocolVersion = AEP_PROTOCOL_VERSION;
  private currentServerInfo?: ServerInfo;
  private currentHead: MetaMap = {};
  private currentCapabilities?: CapabilitiesObject;
  private currentSession?: SessionDescriptor;
  private currentSecurity?: SecurityDescriptor;
  private syncedBody?: BodyChild[];

  private readonly headUpdatedHandlers = new Set<(event: HeadUpdatedParams) => void>();
  private readonly nodeAddedHandlers = new Set<(event: NodeAddedParams) => void>();
  private readonly nodeUpdatedHandlers = new Set<(event: NodeUpdatedParams) => void>();
  private readonly nodeRemovedHandlers = new Set<(event: NodeRemovedParams) => void>();
  private readonly nodeEventHandlers = new Set<(event: NodeEventParams) => void>();
  private readonly channelChunkHandlers = new Set<(event: ChannelChunkParams) => void>();
  private readonly channelClosedHandlers = new Set<(event: ChannelClosedParams) => void>();
  private readonly notificationHandlers = new Set<(envelope: NotificationEnvelope) => void>();
  private readonly closeHandlers = new Set<(error?: Error) => void>();
  private readonly errorHandlers = new Set<(error: Error) => void>();

  constructor(transport: Transport, options: AepClientOptions = {}) {
    this.transport = transport;
    this.options = options;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.syncTree = Boolean(options.syncTree);

    this.unsubscribers.push(
      transport.onMessage((envelope) => {
        this.handleEnvelope(envelope);
      }),
    );
    this.unsubscribers.push(
      transport.onClose((err) => {
        this.handleTransportClosed(err);
      }),
    );
    this.unsubscribers.push(
      transport.onError((err) => {
        for (const handler of this.errorHandlers) {
          handler(err);
        }
      }),
    );
  }

  static async connect(transport: Transport, options?: AepClientOptions): Promise<AepClient> {
    const client = new AepClient(transport, options);
    await client.initialize();
    return client;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  get isClosed(): boolean {
    return this.closed || this.transport.isClosed;
  }

  get protocolVersion(): string {
    return this.currentProtocolVersion;
  }

  get serverInfo(): ServerInfo | undefined {
    return this.currentServerInfo ? { ...this.currentServerInfo } : undefined;
  }

  get head(): MetaMap {
    return structuredClone(this.currentHead);
  }

  get capabilities(): CapabilitiesObject | undefined {
    return this.currentCapabilities ? structuredClone(this.currentCapabilities) : undefined;
  }

  get session(): SessionDescriptor | undefined {
    return this.currentSession ? { ...this.currentSession } : undefined;
  }

  get security(): SecurityDescriptor | undefined {
    return this.currentSecurity ? { ...this.currentSecurity } : undefined;
  }

  get cachedBody(): BodyChild[] | undefined {
    return this.syncedBody ? this.syncedBody.map((n) => cloneNode(n)) : undefined;
  }

  async initialize(overrides?: Partial<SessionInitializeParams>): Promise<SessionInitializeResult> {
    const requestedCaps =
      overrides?.capabilities ??
      (typeof this.options.capabilities === "string" || this.options.capabilities
        ? buildCapabilities(this.options.capabilities)
        : buildCapabilities("aep-core-streaming"));

    const params: SessionInitializeParams = {
      clientInfo: overrides?.clientInfo ?? this.options.clientInfo ?? { ...DEFAULT_CLIENT_INFO },
      supportedVersions: overrides?.supportedVersions ??
        this.options.supportedVersions ?? [AEP_PROTOCOL_VERSION],
      capabilities: requestedCaps,
      ...(overrides?.security !== undefined
        ? { security: overrides.security }
        : this.options.security !== undefined
          ? { security: this.options.security }
          : { security: { mode: "unauthenticated", reserved: true } }),
      ...(overrides?.session !== undefined
        ? { session: overrides.session }
        : this.options.session !== undefined
          ? { session: this.options.session }
          : {}),
    };

    const result = (await this.sendRequest(
      "session.initialize",
      params,
    )) as SessionInitializeResult;

    this.currentProtocolVersion = result.protocolVersion;
    this.currentServerInfo = result.serverInfo;
    this.currentHead = structuredClone(result.head);
    this.currentSession = result.session;
    this.currentSecurity = result.security;
    const headCaps = result.head[HEAD_KEYS.CAPABILITIES];
    if (headCaps && typeof headCaps === "object" && !Array.isArray(headCaps)) {
      this.currentCapabilities = headCaps as unknown as CapabilitiesObject;
    }
    this.initialized = true;

    if (this.syncTree) {
      await this.getTree({ path: "/", includeHead: true });
    }

    return result;
  }

  async close(reason?: string): Promise<void> {
    if (this.closed) {
      return;
    }
    try {
      if (this.initialized && !this.transport.isClosed) {
        await this.sendRequest("session.close", reason ? { reason } : {});
      }
    } catch {
      // Ignore errors during graceful close
    } finally {
      this.handleTransportClosed(reason ? new Error(reason) : undefined);
      await this.transport.close(reason).catch(() => {});
    }
  }

  async getTree(params: TreeGetParams = {}): Promise<TreeGetResult> {
    const res = (await this.sendRequest("tree.get", params)) as TreeGetResult;
    if (this.syncTree) {
      if (res.head) {
        this.currentHead = structuredClone(res.head);
      }
      if ((params.path ?? "/") === "/" && params.maxDepth === undefined && res.node.kind === "body") {
        this.syncedBody = res.node.children.map((c) => cloneNode(c));
      }
    }
    return res;
  }

  async queryTree(params: TreeQueryParams = {}): Promise<TreeQueryResult> {
    return (await this.sendRequest("tree.query", params)) as TreeQueryResult;
  }

  async getNode(path: Path, options?: { maxDepth?: number }): Promise<NodeGetResult> {
    return (await this.sendRequest("node.get", {
      path,
      ...(options?.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
    })) as NodeGetResult;
  }

  async loadChildren(
    path: Path,
    options?: { cursor?: string; limit?: number },
  ): Promise<NodeLoadChildrenResult> {
    const res = (await this.sendRequest("node.loadChildren", {
      path,
      ...(options?.cursor !== undefined ? { cursor: options.cursor } : {}),
      ...(options?.limit !== undefined ? { limit: options.limit } : {}),
    })) as NodeLoadChildrenResult;

    if (this.syncTree && this.syncedBody) {
      const target = findNodeInChildren(this.syncedBody, path);
      if (target && target.kind !== "channel") {
        const existing = target.children ?? [];
        for (const child of res.children) {
          const idx = existing.findIndex((c) => c.id === child.id);
          if (idx >= 0) {
            existing[idx] = cloneNode(child) as never;
          } else {
            existing.push(cloneNode(child) as never);
          }
        }
        target.children = existing as never;
        target.hasChildren = Boolean(res.hasMore);
      }
    }

    return res;
  }

  async invoke<T = unknown>(
    path: Path,
    method: string,
    params?: unknown,
  ): Promise<NodeInvokeResult<T>> {
    return (await this.sendRequest("node.invoke", {
      path,
      method,
      ...(params !== undefined ? { params } : {}),
    })) as NodeInvokeResult<T>;
  }

  async getBinary(refId: string, params?: GetBinaryOptions): Promise<GetBinaryResult> {
    return (await this.sendRequest("data.getBinary", {
      refId,
      ...(params !== undefined ? { params } : {}),
    })) as GetBinaryResult;
  }

  async openChannel(params: ChannelOpenParams): Promise<ClientChannelSubscription> {
    let createdSub: ClientChannelSubscription | undefined;
    await this.sendRequest("channel.open", params, (rawRes) => {
      const res = rawRes as ChannelOpenResult;
      const sub = new ClientChannelSubscription(res, {
        send: (sendParams) => this.sendChannel(sendParams),
        seek: (seekParams) => this.seekChannel(seekParams),
        close: (subscriptionId) => this.closeChannel(subscriptionId),
      });
      this.subscriptions.set(res.subscriptionId, sub);
      createdSub = sub;
    });
    return createdSub!;
  }

  async sendChannel(params: ChannelSendParams): Promise<ChannelSendResult> {
    return (await this.sendRequest("channel.send", params)) as ChannelSendResult;
  }

  async seekChannel(params: ChannelSeekParams): Promise<ChannelSeekResult> {
    return (await this.sendRequest("channel.seek", params)) as ChannelSeekResult;
  }

  async sampleChannel(params: ChannelSampleParams): Promise<ChannelSampleResult> {
    return (await this.sendRequest("channel.sample", params)) as ChannelSampleResult;
  }

  async closeChannel(subscriptionId: string): Promise<ChannelCloseResult> {
    const res = (await this.sendRequest("channel.close", {
      subscriptionId,
    })) as ChannelCloseResult;
    const sub = this.subscriptions.get(subscriptionId);
    if (sub) {
      this.subscriptions.delete(subscriptionId);
      sub._markClosed({
        subscriptionId,
        refId: sub.reference.refId,
        reason: "Closed by client",
      });
    }
    return res;
  }

  onHeadUpdated(handler: (event: HeadUpdatedParams) => void): () => void {
    this.headUpdatedHandlers.add(handler);
    return () => {
      this.headUpdatedHandlers.delete(handler);
    };
  }

  onNodeAdded(handler: (event: NodeAddedParams) => void): () => void {
    this.nodeAddedHandlers.add(handler);
    return () => {
      this.nodeAddedHandlers.delete(handler);
    };
  }

  onNodeUpdated(handler: (event: NodeUpdatedParams) => void): () => void {
    this.nodeUpdatedHandlers.add(handler);
    return () => {
      this.nodeUpdatedHandlers.delete(handler);
    };
  }

  onNodeRemoved(handler: (event: NodeRemovedParams) => void): () => void {
    this.nodeRemovedHandlers.add(handler);
    return () => {
      this.nodeRemovedHandlers.delete(handler);
    };
  }

  onNodeEvent(handler: (event: NodeEventParams) => void): () => void {
    this.nodeEventHandlers.add(handler);
    return () => {
      this.nodeEventHandlers.delete(handler);
    };
  }

  onChannelChunk(handler: (event: ChannelChunkParams) => void): () => void {
    this.channelChunkHandlers.add(handler);
    return () => {
      this.channelChunkHandlers.delete(handler);
    };
  }

  onChannelClosed(handler: (event: ChannelClosedParams) => void): () => void {
    this.channelClosedHandlers.add(handler);
    return () => {
      this.channelClosedHandlers.delete(handler);
    };
  }

  onNotification(handler: (envelope: NotificationEnvelope) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
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

  private async sendRequest(
    method: string,
    params?: unknown,
    onResult?: (result: unknown) => void,
  ): Promise<unknown> {
    if (this.isClosed) {
      throw new AepError(AEP_ERROR_CODES.MOUNT_UNAVAILABLE, "Client transport is closed");
    }

    const id = `req-${this.nextRequestSeq++}`;
    const envelope: ControlEnvelope = {
      protocolVersion: this.currentProtocolVersion,
      kind: "request",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    return await new Promise<unknown>((resolve, reject) => {
      const timer =
        this.requestTimeoutMs > 0
          ? setTimeout(() => {
              this.pendingRequests.delete(id);
              reject(
                new AepError(
                  AEP_ERROR_CODES.MOUNT_TIMEOUT,
                  `Request "${method}" (${id}) timed out after ${this.requestTimeoutMs}ms`,
                ),
              );
            }, this.requestTimeoutMs)
          : undefined;

      this.pendingRequests.set(id, { resolve, reject, onResult, timer });

      void this.transport.send(envelope).catch((err) => {
        const pending = this.pendingRequests.get(id);
        if (pending) {
          this.pendingRequests.delete(id);
          if (pending.timer) {
            clearTimeout(pending.timer);
          }
          pending.reject(AepError.from(err, AEP_ERROR_CODES.MOUNT_UNAVAILABLE));
        }
      });
    });
  }

  private handleEnvelope(envelope: ControlEnvelope): void {
    if (envelope.kind === "response") {
      const pending = this.pendingRequests.get(envelope.id);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(envelope.id);
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      if (envelope.ok) {
        try {
          pending.onResult?.(envelope.result);
        } catch (err) {
          pending.reject(err);
          return;
        }
        pending.resolve(envelope.result);
      } else {
        pending.reject(AepError.from(envelope.error));
      }
      return;
    }

    if (envelope.kind === "notification") {
      this.handleNotification(envelope);
    }
  }

  private handleNotification(envelope: NotificationEnvelope): void {
    for (const handler of this.notificationHandlers) {
      handler(envelope);
    }

    switch (envelope.method) {
      case "head.updated": {
        const params = envelope.params as HeadUpdatedParams;
        this.currentHead = structuredClone(params.head);
        for (const handler of this.headUpdatedHandlers) {
          handler(params);
        }
        break;
      }
      case "node.added": {
        const params = envelope.params as NodeAddedParams;
        this.applyNodeAdded(params);
        for (const handler of this.nodeAddedHandlers) {
          handler(params);
        }
        break;
      }
      case "node.updated": {
        const params = envelope.params as NodeUpdatedParams;
        this.applyNodeUpdated(params);
        for (const handler of this.nodeUpdatedHandlers) {
          handler(params);
        }
        break;
      }
      case "node.removed": {
        const params = envelope.params as NodeRemovedParams;
        this.applyNodeRemoved(params);
        for (const handler of this.nodeRemovedHandlers) {
          handler(params);
        }
        break;
      }
      case "node.event": {
        const params = envelope.params as NodeEventParams;
        for (const handler of this.nodeEventHandlers) {
          handler(params);
        }
        break;
      }
      case "channel.chunk": {
        const params = envelope.params as ChannelChunkParams;
        const sub = this.subscriptions.get(params.subscriptionId);
        if (sub) {
          sub._pushChunk(params);
        }
        for (const handler of this.channelChunkHandlers) {
          handler(params);
        }
        break;
      }
      case "channel.closed": {
        const params = envelope.params as ChannelClosedParams;
        const sub = this.subscriptions.get(params.subscriptionId);
        if (sub) {
          this.subscriptions.delete(params.subscriptionId);
          sub._markClosed(params);
        }
        for (const handler of this.channelClosedHandlers) {
          handler(params);
        }
        break;
      }
      default:
        break;
    }
  }

  private applyNodeAdded(params: NodeAddedParams): void {
    if (!this.syncTree || !this.syncedBody) {
      return;
    }
    const cloned = cloneNode(params.node);
    if (params.parentPath === "/") {
      const idx = params.index ?? this.syncedBody.length;
      this.syncedBody.splice(idx, 0, cloned as BodyChild);
      return;
    }
    const parent = findNodeInChildren(this.syncedBody, params.parentPath);
    if (!parent || parent.kind === "channel") {
      return;
    }
    if (!parent.children) {
      parent.children = [];
    }
    const idx = params.index ?? parent.children.length;
    (parent.children as AepNode[]).splice(idx, 0, cloned);
  }

  private applyNodeUpdated(params: NodeUpdatedParams): void {
    if (!this.syncTree || !this.syncedBody || params.path === "/") {
      return;
    }
    try {
      const { parentPath, id } = splitParentPath(params.path);
      const cloned = cloneNode(params.node);
      if (parentPath === "/") {
        const idx = this.syncedBody.findIndex((c) => c.id === id);
        if (idx >= 0) {
          this.syncedBody[idx] = cloned as BodyChild;
        }
        return;
      }
      const parent = findNodeInChildren(this.syncedBody, parentPath);
      if (!parent || parent.kind === "channel" || !parent.children) {
        return;
      }
      const idx = parent.children.findIndex((c) => c.id === id);
      if (idx >= 0) {
        (parent.children as AepNode[])[idx] = cloned;
      }
    } catch {
      // Ignore invalid paths on sync mirror
    }
  }

  private applyNodeRemoved(params: NodeRemovedParams): void {
    if (!this.syncTree || !this.syncedBody || params.path === "/") {
      return;
    }
    try {
      const { parentPath, id } = splitParentPath(params.path);
      if (parentPath === "/") {
        const idx = this.syncedBody.findIndex((c) => c.id === id);
        if (idx >= 0) {
          this.syncedBody.splice(idx, 1);
        }
        return;
      }
      const parent = findNodeInChildren(this.syncedBody, parentPath);
      if (!parent || parent.kind === "channel" || !parent.children) {
        return;
      }
      const idx = parent.children.findIndex((c) => c.id === id);
      if (idx >= 0) {
        parent.children.splice(idx, 1);
      }
    } catch {
      // Ignore invalid paths on sync mirror
    }
  }

  private handleTransportClosed(error?: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;

    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers.length = 0;

    for (const [id, pending] of this.pendingRequests.entries()) {
      this.pendingRequests.delete(id);
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(
        new AepError(
          AEP_ERROR_CODES.MOUNT_UNAVAILABLE,
          error ? `Transport closed: ${error.message}` : "Transport closed",
        ),
      );
    }

    for (const [subId, sub] of this.subscriptions.entries()) {
      this.subscriptions.delete(subId);
      sub._markClosed({
        subscriptionId: subId,
        refId: sub.reference.refId,
        reason: error?.message ?? "Transport closed",
      });
    }

    for (const handler of this.closeHandlers) {
      handler(error);
    }
  }
}
