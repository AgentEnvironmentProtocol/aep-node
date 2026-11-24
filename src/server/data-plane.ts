import { randomUUID } from "node:crypto";
import { AEP_ERROR_CODES, AepError } from "../core/errors.js";
import { isValidPath } from "../core/path.js";
import type {
  AepNode,
  AepValue,
  BinaryRef,
  BodyChild,
  CapabilitiesObject,
  ChannelNode,
  ChannelOpenOptions,
  ChannelOpenParams,
  ChannelOpenResult,
  ChannelSampleParams,
  ChannelSampleResult,
  ChannelSeekParams,
  ChannelSeekResult,
  ChannelSendParams,
  ChannelSendResult,
  GetBinaryOptions,
  GetBinaryParams,
  GetBinaryResult,
  Path,
  SeekUnit,
  SessionRole,
  StreamRef,
} from "../core/types.js";
import type { TreeStore } from "./tree-store.js";

export interface ServerSessionContext {
  readonly sessionId: string;
  readonly role: SessionRole;
  readonly capabilities: CapabilitiesObject;
  readonly peerIdentity?: Record<string, AepValue>;
}

export type BinaryProviderResult =
  | Uint8Array
  | {
      reference?: Partial<BinaryRef>;
      data: Uint8Array;
    };

export type BinaryProviderFn = (
  params: GetBinaryOptions | undefined,
  session: ServerSessionContext,
) => Promise<BinaryProviderResult> | BinaryProviderResult;

export interface ChannelChunkInput {
  data: Uint8Array;
  mediaType?: string;
  timestamp?: string;
  offset?: number;
  isFinal?: boolean;
}

export interface ChannelSubscriptionContext {
  readonly subscriptionId: string;
  readonly path: Path;
  readonly channel: ChannelNode;
  readonly reference: StreamRef;
  readonly session: ServerSessionContext;
  readonly params?: ChannelOpenOptions;
  sendChunk(chunk: ChannelChunkInput): Promise<void>;
  close(reason?: string): Promise<void>;
}

export interface ServerChannelHandler {
  onOpen?(ctx: ChannelSubscriptionContext): Promise<void> | void;
  onSend?(
    params: ChannelSendParams,
    ctx: ChannelSubscriptionContext,
  ): Promise<{ accepted?: boolean; sequence?: number } | void> | { accepted?: boolean; sequence?: number } | void;
  onSeek?(
    params: ChannelSeekParams,
    ctx: ChannelSubscriptionContext,
  ): Promise<{ offset?: number; unit?: SeekUnit } | void> | { offset?: number; unit?: SeekUnit } | void;
  onSample?(
    params: ChannelSampleParams,
    channel: ChannelNode,
    session: ServerSessionContext,
  ): Promise<{
    data: Uint8Array;
    mediaType?: string;
    timestamp?: string;
    offset?: number;
    unit?: SeekUnit;
  }> | {
    data: Uint8Array;
    mediaType?: string;
    timestamp?: string;
    offset?: number;
    unit?: SeekUnit;
  };
  onClose?(ctx: ChannelSubscriptionContext): Promise<void> | void;
}

interface BinaryEntry {
  reference: BinaryRef;
  provider: BinaryProviderFn;
}

interface ActiveSubscription {
  subscriptionId: string;
  path: Path;
  channel: ChannelNode;
  reference: StreamRef;
  session: ServerSessionContext;
  params?: ChannelOpenOptions;
  handler?: ServerChannelHandler;
  emit: (method: string, params: unknown) => Promise<void>;
  sequence: number;
  ready: boolean;
  pendingNotifications: Array<{ method: string; payload: unknown }>;
  closed: boolean;
  ctx: ChannelSubscriptionContext;
}

function findChannelByRefId(
  children: readonly BodyChild[],
  refId: string,
): { path: Path; node: ChannelNode } | undefined {
  const walk = (nodes: readonly AepNode[], parentPath: Path): { path: Path; node: ChannelNode } | undefined => {
    for (const node of nodes) {
      const nodePath = parentPath === "/" ? `/${node.id}` : `${parentPath}/${node.id}`;
      if (node.kind === "channel") {
        if (node.streamRef?.refId === refId) {
          return { path: nodePath, node };
        }
      } else if (node.children) {
        const found = walk(node.children, nodePath);
        if (found) {
          return found;
        }
      }
    }
    return undefined;
  };
  return walk(children, "/");
}

function validateRegionParam(region: unknown): void {
  if (region === undefined) {
    return;
  }
  if (typeof region !== "object" || region === null || Array.isArray(region)) {
    throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, "region must be an object");
  }
  const r = region as Record<string, unknown>;
  if (
    typeof r["x"] !== "number" ||
    !Number.isFinite(r["x"]) ||
    typeof r["y"] !== "number" ||
    !Number.isFinite(r["y"]) ||
    typeof r["width"] !== "number" ||
    !Number.isFinite(r["width"]) ||
    r["width"] < 0 ||
    typeof r["height"] !== "number" ||
    !Number.isFinite(r["height"]) ||
    r["height"] < 0
  ) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_PARAMS,
      "region requires finite x, y, width >= 0, height >= 0",
    );
  }
}

export class DataPlaneManager {
  private readonly treeStore: TreeStore;
  private readonly binaries = new Map<string, BinaryEntry>();
  private readonly channelHandlers = new Map<string, ServerChannelHandler>();
  private readonly subscriptions = new Map<string, ActiveSubscription>();

  constructor(treeStore: TreeStore) {
    this.treeStore = treeStore;
  }

  registerBinary(
    reference: BinaryRef,
    provider: Uint8Array | BinaryProviderFn,
  ): void {
    if (!reference.refId || !reference.mediaType) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_REFERENCE,
        "BinaryRef requires non-empty refId and mediaType",
      );
    }
    const fn: BinaryProviderFn =
      provider instanceof Uint8Array
        ? () => new Uint8Array(provider)
        : provider;
    this.binaries.set(reference.refId, {
      reference: structuredClone(reference),
      provider: fn,
    });
  }

  unregisterBinary(refId: string): boolean {
    return this.binaries.delete(refId);
  }

  registerChannel(pathOrRefId: string, handler: ServerChannelHandler): void {
    this.channelHandlers.set(pathOrRefId, handler);
  }

  unregisterChannel(pathOrRefId: string): boolean {
    return this.channelHandlers.delete(pathOrRefId);
  }

  async getBinary(
    params: GetBinaryParams,
    session: ServerSessionContext,
  ): Promise<GetBinaryResult> {
    if (!session.capabilities.dataPlane.binaryReferences) {
      throw new AepError(
        AEP_ERROR_CODES.UNSUPPORTED_CAPABILITY,
        "binaryReferences capability is disabled for this session",
      );
    }
    if (!params || typeof params.refId !== "string" || params.refId.length === 0) {
      throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, "data.getBinary requires non-empty refId");
    }
    validateRegionParam(params.params?.region);

    const entry = this.binaries.get(params.refId);
    if (!entry) {
      throw new AepError(
        AEP_ERROR_CODES.BINARY_NOT_FOUND,
        `BinaryRef "${params.refId}" not found`,
      );
    }

    const result = await entry.provider(params.params, session);
    if (result instanceof Uint8Array) {
      return {
        reference: {
          ...structuredClone(entry.reference),
          sizeBytes: result.byteLength,
        },
        data: result,
      };
    }

    const mergedRef: BinaryRef = {
      ...structuredClone(entry.reference),
      ...result.reference,
      sizeBytes: result.reference?.sizeBytes ?? result.data.byteLength,
    };
    return {
      reference: mergedRef,
      data: result.data,
    };
  }

  resolveChannelTarget(
    path?: Path,
    refId?: string,
  ): { path: Path; channel: ChannelNode } {
    if ((path === undefined || path === "") && (refId === undefined || refId === "")) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PARAMS,
        "At least one of path or refId MUST be provided",
      );
    }

    let byPath: { path: Path; channel: ChannelNode } | undefined;
    if (path !== undefined) {
      if (!isValidPath(path) || path === "/") {
        throw new AepError(AEP_ERROR_CODES.INVALID_PATH, `Invalid channel path: "${path}"`);
      }
      const node = this.treeStore.findNodeInternal(path);
      if (!node || node.kind !== "channel") {
        throw new AepError(
          AEP_ERROR_CODES.CHANNEL_NOT_FOUND,
          `Channel not found at path "${path}"`,
        );
      }
      byPath = { path, channel: node };
    }

    let byRef: { path: Path; channel: ChannelNode } | undefined;
    if (refId !== undefined) {
      if (typeof refId !== "string" || refId.length === 0) {
        throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, "refId must be a non-empty string");
      }
      const found = findChannelByRefId(this.treeStore.getRawBody(), refId);
      if (found) {
        byRef = { path: found.path, channel: found.node };
      } else if (isValidPath(refId) && refId !== "/") {
        const fallback = this.treeStore.findNodeInternal(refId);
        if (fallback && fallback.kind === "channel") {
          byRef = { path: refId, channel: fallback };
        }
      }
      if (!byRef) {
        throw new AepError(
          AEP_ERROR_CODES.CHANNEL_NOT_FOUND,
          `Channel StreamRef "${refId}" not found`,
        );
      }
    }

    if (byPath && byRef && byPath.path !== byRef.path) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PARAMS,
        `Channel path "${byPath.path}" and refId "${refId}" resolve to different channels`,
      );
    }

    return (byPath ?? byRef)!;
  }

  private lookupHandler(path: Path, refId?: string): ServerChannelHandler | undefined {
    return this.channelHandlers.get(path) ?? (refId ? this.channelHandlers.get(refId) : undefined);
  }

  async openChannel(
    params: ChannelOpenParams,
    session: ServerSessionContext,
    emit: (method: string, payload: unknown) => Promise<void>,
  ): Promise<ChannelOpenResult> {
    if (
      !session.capabilities.nodeKinds.includes("channel") ||
      !session.capabilities.dataPlane.streamReferences
    ) {
      throw new AepError(
        AEP_ERROR_CODES.UNSUPPORTED_CAPABILITY,
        "Streaming channels are not supported in the negotiated profile",
      );
    }

    const { path, channel } = this.resolveChannelTarget(params?.path, params?.refId);

    if (!session.capabilities.channelDirections.includes(channel.direction)) {
      throw new AepError(
        AEP_ERROR_CODES.UNSUPPORTED_CAPABILITY,
        `Channel direction "${channel.direction}" is outside negotiated capabilities`,
      );
    }
    if (!session.capabilities.deliveryModes.includes(channel.deliveryMode)) {
      throw new AepError(
        AEP_ERROR_CODES.UNSUPPORTED_CAPABILITY,
        `Channel deliveryMode "${channel.deliveryMode}" is outside negotiated capabilities`,
      );
    }

    if (session.role === "observer") {
      if (channel.direction === "act") {
        throw new AepError(
          AEP_ERROR_CODES.READ_ONLY_SESSION,
          `Observer session cannot open "act" channel "${path}"`,
        );
      }
      if (
        channel.direction === "duplex" &&
        session.capabilities.sessions?.allowObserverStreams === false
      ) {
        throw new AepError(
          AEP_ERROR_CODES.READ_ONLY_SESSION,
          `Observer session cannot subscribe to "duplex" channel "${path}"`,
        );
      }
    }

    const reference: StreamRef = channel.streamRef
      ? structuredClone(channel.streamRef)
      : {
          refId: path,
          mediaType: channel.mediaType,
        };

    const subscriptionId = `sub-${randomUUID()}`;
    const handler = this.lookupHandler(path, reference.refId);

    const sub: ActiveSubscription = {
      subscriptionId,
      path,
      channel,
      reference,
      session,
      params: params?.params,
      handler,
      emit,
      sequence: 0,
      ready: false,
      pendingNotifications: [],
      closed: false,
      ctx: null as unknown as ChannelSubscriptionContext,
    };

    const ctx: ChannelSubscriptionContext = {
      subscriptionId,
      path,
      channel,
      reference,
      session,
      params: params?.params,
      sendChunk: async (chunk) => {
        if (sub.closed) {
          return;
        }
        if (channel.direction === "act") {
          throw new AepError(
            AEP_ERROR_CODES.DIRECTION_MISMATCH,
            `Cannot push server chunks on "act"-only channel "${path}"`,
          );
        }
        sub.sequence += 1;
        const payload = {
          subscriptionId: sub.subscriptionId,
          refId: sub.reference.refId,
          sequence: sub.sequence,
          timestamp: chunk.timestamp ?? new Date().toISOString(),
          mediaType: chunk.mediaType ?? sub.channel.mediaType,
          ...(chunk.offset !== undefined ? { offset: chunk.offset } : {}),
          data: chunk.data,
          ...(chunk.isFinal !== undefined ? { isFinal: chunk.isFinal } : {}),
        };
        if (!sub.ready) {
          sub.pendingNotifications.push({ method: "channel.chunk", payload });
          return;
        }
        await sub.emit("channel.chunk", payload);
      },
      close: async (reason?: string) => {
        await this.closeSubscriptionByServer(sub.subscriptionId, reason);
      },
    };
    sub.ctx = ctx;

    this.subscriptions.set(subscriptionId, sub);

    if (handler?.onOpen) {
      try {
        await handler.onOpen(ctx);
      } catch (err) {
        this.subscriptions.delete(subscriptionId);
        sub.closed = true;
        throw err;
      }
    }

    return {
      subscriptionId,
      path,
      reference: structuredClone(reference),
      direction: channel.direction,
    };
  }

  async sendChannel(
    params: ChannelSendParams,
    session: ServerSessionContext,
  ): Promise<ChannelSendResult> {
    if (!params || typeof params.subscriptionId !== "string" || !(params.data instanceof Uint8Array)) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PARAMS,
        "channel.send requires subscriptionId and Uint8Array data",
      );
    }

    const sub = this.subscriptions.get(params.subscriptionId);
    if (!sub || sub.closed || sub.session.sessionId !== session.sessionId) {
      throw new AepError(
        AEP_ERROR_CODES.CHANNEL_NOT_FOUND,
        `Active subscription "${params.subscriptionId}" not found`,
      );
    }

    if (session.role === "observer") {
      throw new AepError(
        AEP_ERROR_CODES.READ_ONLY_SESSION,
        "Observer session cannot send frames on a channel",
      );
    }

    if (sub.channel.direction === "sense") {
      throw new AepError(
        AEP_ERROR_CODES.DIRECTION_MISMATCH,
        `Cannot call channel.send on "sense"-only channel "${sub.path}"`,
      );
    }

    if (sub.handler?.onSend) {
      const res = await sub.handler.onSend(params, sub.ctx);
      return {
        accepted: res?.accepted ?? true,
        ...(res?.sequence !== undefined
          ? { sequence: res.sequence }
          : params.sequence !== undefined
            ? { sequence: params.sequence }
            : {}),
      };
    }

    return {
      accepted: true,
      ...(params.sequence !== undefined ? { sequence: params.sequence } : {}),
    };
  }

  async seekChannel(
    params: ChannelSeekParams,
    session: ServerSessionContext,
  ): Promise<ChannelSeekResult> {
    if (!params || typeof params.subscriptionId !== "string" || typeof params.offset !== "number" || !Number.isFinite(params.offset)) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PARAMS,
        "channel.seek requires subscriptionId and finite numeric offset",
      );
    }

    const sub = this.subscriptions.get(params.subscriptionId);
    if (!sub || sub.closed || sub.session.sessionId !== session.sessionId) {
      throw new AepError(
        AEP_ERROR_CODES.CHANNEL_NOT_FOUND,
        `Active subscription "${params.subscriptionId}" not found`,
      );
    }

    if (
      !session.capabilities.dataPlane.seek ||
      sub.channel.deliveryMode !== "stream+seek" ||
      sub.reference.seek?.seekable === false
    ) {
      throw new AepError(
        AEP_ERROR_CODES.UNSUPPORTED_CAPABILITY,
        `Channel "${sub.path}" does not support seek`,
      );
    }

    if (sub.handler?.onSeek) {
      const res = await sub.handler.onSeek(params, sub.ctx);
      const unit = res?.unit ?? params.unit ?? sub.reference.seek?.unit;
      return {
        subscriptionId: sub.subscriptionId,
        offset: res?.offset ?? params.offset,
        ...(unit !== undefined ? { unit } : {}),
      };
    }

    const unit = params.unit ?? sub.reference.seek?.unit;
    return {
      subscriptionId: sub.subscriptionId,
      offset: params.offset,
      ...(unit !== undefined ? { unit } : {}),
    };
  }

  async sampleChannel(
    params: ChannelSampleParams,
    session: ServerSessionContext,
  ): Promise<ChannelSampleResult> {
    if (!session.capabilities.dataPlane.sample) {
      throw new AepError(
        AEP_ERROR_CODES.UNSUPPORTED_CAPABILITY,
        "channel.sample capability is disabled for this session",
      );
    }
    if (!params || typeof params.offset !== "number" || !Number.isFinite(params.offset)) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PARAMS,
        "channel.sample requires a finite numeric offset",
      );
    }

    const { path, channel } = this.resolveChannelTarget(params.path, params.refId);
    if (channel.deliveryMode !== "stream+seek" || channel.streamRef?.seek?.seekable === false) {
      throw new AepError(
        AEP_ERROR_CODES.UNSUPPORTED_CAPABILITY,
        `Channel "${path}" does not support stream+seek sampling`,
      );
    }

    const reference: StreamRef = channel.streamRef
      ? structuredClone(channel.streamRef)
      : { refId: path, mediaType: channel.mediaType };
    const handler = this.lookupHandler(path, reference.refId);
    if (!handler?.onSample) {
      throw new AepError(
        AEP_ERROR_CODES.UNSUPPORTED_CAPABILITY,
        `Channel "${path}" has no sample provider registered`,
      );
    }

    const sampled = await handler.onSample(params, channel, session);
    const unit = sampled.unit ?? params.unit ?? reference.seek?.unit;

    return {
      reference,
      offset: sampled.offset ?? params.offset,
      ...(unit !== undefined ? { unit } : {}),
      mediaType: sampled.mediaType ?? channel.mediaType,
      ...(sampled.timestamp !== undefined ? { timestamp: sampled.timestamp } : {}),
      data: sampled.data,
    };
  }

  async closeChannel(
    subscriptionId: string,
    sessionId: string,
  ): Promise<{ closed: boolean; subscriptionId: string }> {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub || sub.session.sessionId !== sessionId) {
      throw new AepError(
        AEP_ERROR_CODES.CHANNEL_NOT_FOUND,
        `Active subscription "${subscriptionId}" not found`,
      );
    }
    this.subscriptions.delete(subscriptionId);
    if (!sub.closed) {
      sub.closed = true;
      if (sub.handler?.onClose) {
        await sub.handler.onClose(sub.ctx);
      }
    }
    return { closed: true, subscriptionId };
  }

  async activateSubscription(subscriptionId: string): Promise<void> {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub || sub.ready) {
      return;
    }
    sub.ready = true;
    const queued = sub.pendingNotifications.splice(0, sub.pendingNotifications.length);
    for (const item of queued) {
      try {
        await sub.emit(item.method, item.payload);
      } catch {
        // Ignore notification failure if session disconnected
      }
    }
    if (sub.closed) {
      this.subscriptions.delete(subscriptionId);
    }
  }

  async closeSubscriptionByServer(subscriptionId: string, reason?: string): Promise<void> {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub || sub.closed) {
      return;
    }
    sub.closed = true;
    if (sub.ready) {
      this.subscriptions.delete(subscriptionId);
    }
    if (sub.handler?.onClose) {
      try {
        await sub.handler.onClose(sub.ctx);
      } catch {
        // Ignore handler teardown error
      }
    }
    const payload = {
      subscriptionId: sub.subscriptionId,
      refId: sub.reference.refId,
      ...(reason !== undefined ? { reason } : {}),
    };
    if (!sub.ready) {
      sub.pendingNotifications.push({ method: "channel.closed", payload });
      return;
    }
    try {
      await sub.emit("channel.closed", payload);
    } catch {
      // Ignore notification failure if session disconnected
    }
  }

  async publishChannelChunk(pathOrRefId: string, chunk: ChannelChunkInput): Promise<void> {
    const targets: ActiveSubscription[] = [];
    for (const sub of this.subscriptions.values()) {
      if (
        !sub.closed &&
        sub.channel.direction !== "act" &&
        (sub.path === pathOrRefId || sub.reference.refId === pathOrRefId)
      ) {
        targets.push(sub);
      }
    }
    await Promise.all(targets.map((sub) => sub.ctx.sendChunk(chunk)));
  }

  async pushSubscriptionChunk(subscriptionId: string, chunk: ChannelChunkInput): Promise<void> {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub || sub.closed) {
      throw new AepError(
        AEP_ERROR_CODES.CHANNEL_NOT_FOUND,
        `Active subscription "${subscriptionId}" not found`,
      );
    }
    await sub.ctx.sendChunk(chunk);
  }

  async closeSessionSubscriptions(sessionId: string): Promise<void> {
    const owned = [...this.subscriptions.values()].filter((s) => s.session.sessionId === sessionId);
    for (const sub of owned) {
      this.subscriptions.delete(sub.subscriptionId);
      if (!sub.closed) {
        sub.closed = true;
        if (sub.handler?.onClose) {
          try {
            await sub.handler.onClose(sub.ctx);
          } catch {
            // Ignore cleanup errors
          }
        }
      }
    }
  }
}
