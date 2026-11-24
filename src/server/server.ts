import { randomUUID } from "node:crypto";
import { AEP_ERROR_CODES, AepError } from "../core/errors.js";
import { isValidNamespacedIdent, isValidPath, parsePath } from "../core/path.js";
import { buildCapabilities, negotiateCapabilities } from "../core/profiles.js";
import { cloneNode, paginateMatches, querySubtree } from "../core/tree-utils.js";
import {
  AEP_PROTOCOL_VERSION,
  HEAD_KEYS,
  type AepNode,
  type AepValue,
  type BinaryRef,
  type BodyChild,
  type CapabilitiesObject,
  type ChannelCloseParams,
  type ChannelOpenParams,
  type ChannelSampleParams,
  type ChannelSeekParams,
  type ChannelSendParams,
  type ControlEnvelope,
  type GetBinaryParams,
  type MetaMap,
  type NodeGetParams,
  type NodeInvokeParams,
  type NodeLoadChildrenParams,
  type NodeLoadChildrenResult,
  type Path,
  type SecurityDescriptor,
  type ServerInfo,
  type SessionCloseParams,
  type SessionDescriptor,
  type SessionInitializeParams,
  type SessionInitializeResult,
  type SessionPolicy,
  type SessionRole,
  type TreeGetParams,
  type TreeQueryParams,
} from "../core/types.js";
import { validateNode, validateNodeCapabilities } from "../core/validation.js";
import type { Transport, TransportServer } from "../transport/types.js";
import {
  DataPlaneManager,
  type BinaryProviderFn,
  type ChannelChunkInput,
  type ServerChannelHandler,
  type ServerSessionContext,
} from "./data-plane.js";
import { ServerMountManager, type ServerMountOptions } from "./mount-manager.js";
import { TreeStore } from "./tree-store.js";

export interface MethodHandlerContext {
  readonly path: Path;
  readonly method: string;
  readonly node: AepNode;
  readonly session: ServerSessionContext;
  addNode(parentPath: Path, node: AepNode, index?: number): Promise<AepNode>;
  updateNode(path: Path, updater: AepNode | ((prev: AepNode) => AepNode)): Promise<AepNode>;
  removeNode(path: Path): Promise<void>;
  emitEvent(path: Path, event: string, data?: unknown, timestamp?: string): Promise<void>;
}

export type ServerMethodHandler = (
  params: unknown,
  ctx: MethodHandlerContext,
) => Promise<unknown> | unknown;

export interface ChildrenLoaderRequest {
  readonly path: Path;
  readonly node: AepNode;
  readonly cursor?: string;
  readonly limit?: number;
}

export type ServerChildrenLoaderResult =
  | AepNode[]
  | {
      children: AepNode[];
      hasMore?: boolean;
      nextCursor?: string;
    };

export type ServerChildrenLoader = (
  request: ChildrenLoaderRequest,
  session: ServerSessionContext,
) => Promise<ServerChildrenLoaderResult> | ServerChildrenLoaderResult;

export interface AepServerSecurityOptions {
  allowedModes?: string[];
  authenticate?: (
    security: SecurityDescriptor | undefined,
    params: SessionInitializeParams,
    transport: Transport,
  ) => Promise<SecurityDescriptor | null> | SecurityDescriptor | null;
}

export interface AepServerOptions {
  serverInfo?: ServerInfo;
  protocolVersions?: string[];
  capabilities?: "aep-core-static" | "aep-core-streaming" | Partial<CapabilitiesObject>;
  head?: MetaMap;
  body?: BodyChild[];
  security?: AepServerSecurityOptions;
  originId?: string;
}

export interface ServerSessionHandle {
  readonly sessionId: string;
  readonly initialized: boolean;
  readonly role?: SessionRole;
  readonly capabilities?: CapabilitiesObject;
  close(reason?: string): Promise<void>;
}

interface InternalSession {
  sessionId: string;
  transport: Transport;
  initialized: boolean;
  closed: boolean;
  protocolVersion: string;
  role: SessionRole;
  policy: SessionPolicy;
  capabilities: CapabilitiesObject;
  security: SecurityDescriptor;
  treeStore: TreeStore;
  dataPlane: DataPlaneManager;
  unsubscribers: Array<() => void>;
}

const DEFAULT_SERVER_INFO: ServerInfo = {
  name: "aep-node-server",
  version: "0.1.0",
};

export class AepServer {
  readonly originId: string;
  private readonly serverInfo: ServerInfo;
  private readonly supportedVersions: string[];
  private readonly serverCapabilities: CapabilitiesObject;
  private readonly securityOptions?: AepServerSecurityOptions;
  private readonly treeStore: TreeStore;
  private readonly dataPlane: DataPlaneManager;
  private readonly mountManager: ServerMountManager;
  private readonly sessions = new Map<string, InternalSession>();
  private readonly methodHandlers = new Map<string, ServerMethodHandler>();
  private fallbackInvokeHandler?: ServerMethodHandler;
  private readonly childrenLoaders = new Map<Path, ServerChildrenLoader>();
  private fallbackChildrenLoader?: ServerChildrenLoader;
  private activeControllerSessionId: string | null = null;
  private closed = false;

  constructor(options: AepServerOptions = {}) {
    this.originId = options.originId ?? `srv-${randomUUID()}`;
    this.serverInfo = options.serverInfo ?? { ...DEFAULT_SERVER_INFO };
    this.supportedVersions = options.protocolVersions
      ? [...options.protocolVersions]
      : [AEP_PROTOCOL_VERSION];
    this.serverCapabilities = buildCapabilities(options.capabilities);
    this.securityOptions = options.security;

    const initialHead: MetaMap = {
      ...(options.head ?? {}),
      [HEAD_KEYS.PROTOCOL_VERSION]: this.supportedVersions[0] ?? AEP_PROTOCOL_VERSION,
      [HEAD_KEYS.SERVER_INFO]: this.serverInfo as unknown as AepValue,
      [HEAD_KEYS.CAPABILITIES]: this.serverCapabilities as unknown as AepValue,
      [HEAD_KEYS.PROFILES]: this.serverCapabilities.profile ? [this.serverCapabilities.profile] : [],
      [HEAD_KEYS.ORIGIN_ID]: this.originId,
      [HEAD_KEYS.MOUNT_ORIGINS]: [this.originId],
    };

    this.treeStore = new TreeStore(
      initialHead,
      options.body ?? [],
      this.serverCapabilities,
    );
    this.dataPlane = new DataPlaneManager(this.treeStore);
    this.mountManager = new ServerMountManager(this.treeStore, {
      getCapabilities: () => this.serverCapabilities,
      getOriginId: () => this.originId,
      broadcastNotification: (method, params) => this.broadcastNotification(method, params),
      onMountHeadsChanged: () => this.syncMountHeadMetadata(),
    });
  }

  get capabilities(): CapabilitiesObject {
    return structuredClone(this.serverCapabilities);
  }

  getHead(): MetaMap {
    return this.treeStore.getHead();
  }

  getTree(path: Path = "/", maxDepth?: number) {
    return this.mountManager.getTree(path, maxDepth);
  }

  accept(transport: Transport): ServerSessionHandle {
    if (this.closed) {
      throw new Error("AepServer is closed");
    }
    const sessionId = `sess-${randomUUID()}`;
    const policy: SessionPolicy = this.serverCapabilities.sessions?.policy ?? "single-controller";

    const session: InternalSession = {
      sessionId,
      transport,
      initialized: false,
      closed: false,
      protocolVersion: this.supportedVersions[0] ?? AEP_PROTOCOL_VERSION,
      role: "observer",
      policy,
      capabilities: structuredClone(this.serverCapabilities),
      security: { ...this.serverCapabilities.security },
      treeStore: this.treeStore,
      dataPlane: this.dataPlane,
      unsubscribers: [],
    };

    this.sessions.set(sessionId, session);

    session.unsubscribers.push(
      transport.onMessage((envelope) => {
        void this.handleIncomingEnvelope(session, envelope);
      }),
    );
    session.unsubscribers.push(
      transport.onClose(() => {
        void this.cleanupSession(session);
      }),
    );

    return {
      sessionId,
      get initialized() {
        return session.initialized;
      },
      get role() {
        return session.initialized ? session.role : undefined;
      },
      get capabilities() {
        return session.initialized ? structuredClone(session.capabilities) : undefined;
      },
      close: async (reason?: string) => {
        await this.cleanupSession(session, reason);
      },
    };
  }

  listen(transportServer: TransportServer): () => Promise<void> {
    const unsubscribe = transportServer.onConnection((transport) => {
      if (!this.closed) {
        this.accept(transport);
      } else {
        void transport.close("Server closed");
      }
    });
    return async () => {
      unsubscribe();
      await transportServer.close();
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.mountManager.closeAll();
    const active = [...this.sessions.values()];
    await Promise.all(active.map((session) => this.cleanupSession(session, "Server closed")));
  }

  registerMethod(path: Path, methodName: string, handler: ServerMethodHandler): void {
    parsePath(path);
    if (!isValidNamespacedIdent(methodName)) {
      throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, `Invalid method name "${methodName}"`);
    }
    this.methodHandlers.set(`${path}::${methodName}`, handler);
  }

  onInvoke(handler: ServerMethodHandler): void {
    this.fallbackInvokeHandler = handler;
  }

  registerChildrenLoader(path: Path, loader: ServerChildrenLoader): void {
    if (path === "/") {
      throw new AepError(AEP_ERROR_CODES.INVALID_PATH, 'Children loader cannot target root "/"');
    }
    parsePath(path);
    this.childrenLoaders.set(path, loader);
  }

  onLoadChildren(loader: ServerChildrenLoader): void {
    this.fallbackChildrenLoader = loader;
  }

  registerBinary(reference: BinaryRef, provider: Uint8Array | BinaryProviderFn): void {
    this.dataPlane.registerBinary(reference, provider);
  }

  unregisterBinary(refId: string): boolean {
    return this.dataPlane.unregisterBinary(refId);
  }

  registerChannel(pathOrRefId: string, handler: ServerChannelHandler): void {
    this.dataPlane.registerChannel(pathOrRefId, handler);
  }

  unregisterChannel(pathOrRefId: string): boolean {
    return this.dataPlane.unregisterChannel(pathOrRefId);
  }

  async publishChannelChunk(pathOrRefId: string, chunk: ChannelChunkInput): Promise<void> {
    await this.dataPlane.publishChannelChunk(pathOrRefId, chunk);
  }

  async pushSubscriptionChunk(subscriptionId: string, chunk: ChannelChunkInput): Promise<void> {
    await this.dataPlane.pushSubscriptionChunk(subscriptionId, chunk);
  }

  async mount(options: ServerMountOptions): Promise<{ anchorPath: Path; mountKey: string }> {
    return await this.mountManager.mount(options);
  }

  async unmount(anchorPath: Path): Promise<void> {
    await this.mountManager.unmount(anchorPath);
  }

  async updateHead(patch: MetaMap): Promise<MetaMap> {
    const next = this.treeStore.setHead(patch);
    const promises: Array<Promise<void>> = [];
    for (const session of this.sessions.values()) {
      if (!session.initialized || session.closed) {
        continue;
      }
      if (session.treeStore !== this.treeStore) {
        session.treeStore.setHead(patch);
      }
      const effectiveHead = this.buildSessionHead(session);
      promises.push(this.sendNotification(session, "head.updated", { head: effectiveHead }));
    }
    await Promise.all(promises);
    return next;
  }

  async addNode(parentPath: Path, node: AepNode, index?: number): Promise<AepNode> {
    const added = this.treeStore.addNode(parentPath, node, index, this.serverCapabilities);
    const promises: Array<Promise<void>> = [];
    for (const session of this.sessions.values()) {
      if (!session.initialized || session.closed) {
        continue;
      }
      if (session.treeStore !== this.treeStore) {
        session.treeStore.addNode(parentPath, node, index, this.serverCapabilities);
      }
      promises.push(
        this.sendNotification(session, "node.added", {
          parentPath,
          node: cloneNode(added),
          ...(index !== undefined ? { index } : {}),
        }),
      );
    }
    await Promise.all(promises);
    return added;
  }

  async updateNode(
    path: Path,
    updater: AepNode | ((prev: AepNode) => AepNode),
  ): Promise<AepNode> {
    const updated = this.treeStore.updateNode(path, updater, this.serverCapabilities);
    const promises: Array<Promise<void>> = [];
    for (const session of this.sessions.values()) {
      if (!session.initialized || session.closed) {
        continue;
      }
      if (session.treeStore !== this.treeStore) {
        session.treeStore.updateNode(path, updated, this.serverCapabilities);
      }
      promises.push(
        this.sendNotification(session, "node.updated", {
          path,
          node: cloneNode(updated),
        }),
      );
    }
    await Promise.all(promises);
    return updated;
  }

  async removeNode(path: Path): Promise<void> {
    this.treeStore.removeNode(path);
    const promises: Array<Promise<void>> = [];
    for (const session of this.sessions.values()) {
      if (!session.initialized || session.closed) {
        continue;
      }
      if (session.treeStore !== this.treeStore && session.treeStore.findNodeInternal(path)) {
        session.treeStore.removeNode(path);
      }
      promises.push(this.sendNotification(session, "node.removed", { path }));
    }
    await Promise.all(promises);
  }

  async emitNodeEvent(
    path: Path,
    event: string,
    data?: unknown,
    timestamp: string = new Date().toISOString(),
  ): Promise<void> {
    if (path === "/" || !isValidPath(path)) {
      throw new AepError(AEP_ERROR_CODES.INVALID_PATH, `Invalid event node path "${path}"`);
    }
    if (!isValidNamespacedIdent(event)) {
      throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, `Invalid event name "${event}"`);
    }
    await this.broadcastNotification("node.event", {
      path,
      event,
      timestamp,
      ...(data !== undefined ? { data } : {}),
    });
  }

  private async syncMountHeadMetadata(): Promise<void> {
    const mountOrigins = [this.originId, ...this.mountManager.getMountedOriginIds()];
    const existingVocabsRaw = this.treeStore.getHead()[HEAD_KEYS.VOCABULARIES];
    const existingVocabs = Array.isArray(existingVocabsRaw)
      ? existingVocabsRaw.filter((v): v is string => typeof v === "string")
      : [];
    const mergedVocabs = [...new Set([...existingVocabs, ...this.mountManager.getMountedVocabularies()])];

    await this.updateHead({
      [HEAD_KEYS.MOUNT_ORIGINS]: mountOrigins,
      ...(mergedVocabs.length > 0 ? { [HEAD_KEYS.VOCABULARIES]: mergedVocabs } : {}),
    });
  }

  private buildSessionHead(session: InternalSession): MetaMap {
    const baseHead = session.treeStore.getHead();
    return {
      ...baseHead,
      [HEAD_KEYS.PROTOCOL_VERSION]: session.protocolVersion,
      [HEAD_KEYS.SERVER_INFO]: this.serverInfo as unknown as AepValue,
      [HEAD_KEYS.CAPABILITIES]: session.capabilities as unknown as AepValue,
      [HEAD_KEYS.PROFILES]: session.capabilities.profile ? [session.capabilities.profile] : [],
      [HEAD_KEYS.SESSION]: {
        sessionId: session.sessionId,
        role: session.role,
        policy: session.policy,
      },
      [HEAD_KEYS.SECURITY]: session.security as MetaMap,
      [HEAD_KEYS.ORIGIN_ID]: this.originId,
      [HEAD_KEYS.MOUNT_ORIGINS]: [this.originId, ...this.mountManager.getMountedOriginIds()],
    };
  }

  private toSessionContext(session: InternalSession): ServerSessionContext {
    return {
      sessionId: session.sessionId,
      role: session.role,
      capabilities: session.capabilities,
      peerIdentity: session.transport.peerIdentity,
    };
  }

  private async broadcastNotification(method: string, params: unknown): Promise<void> {
    const promises: Array<Promise<void>> = [];
    for (const session of this.sessions.values()) {
      if (session.initialized && !session.closed) {
        promises.push(this.sendNotification(session, method, params));
      }
    }
    await Promise.all(promises);
  }

  private async sendNotification(
    session: InternalSession,
    method: string,
    params: unknown,
  ): Promise<void> {
    if (session.closed || session.transport.isClosed) {
      return;
    }
    const envelope: ControlEnvelope = {
      protocolVersion: session.protocolVersion,
      kind: "notification",
      method,
      params,
    };
    try {
      await session.transport.send(envelope);
    } catch {
      // Ignore send errors on closing transports
    }
  }

  private async handleIncomingEnvelope(
    session: InternalSession,
    envelope: ControlEnvelope,
  ): Promise<void> {
    if (session.closed || envelope.kind !== "request") {
      return;
    }

    try {
      const result = await this.dispatchRequest(session, envelope.method, envelope.params);
      if (!session.closed && !session.transport.isClosed) {
        await session.transport.send({
          protocolVersion: session.protocolVersion,
          kind: "response",
          id: envelope.id,
          ok: true,
          result,
        });
      }
      if (
        envelope.method === "channel.open" &&
        result &&
        typeof (result as { subscriptionId?: unknown }).subscriptionId === "string"
      ) {
        const subId = (result as { subscriptionId: string }).subscriptionId;
        if (session.treeStore === this.treeStore && this.mountManager.hasProxySubscription(subId)) {
          await this.mountManager.activateSubscription(subId);
        } else {
          await session.dataPlane.activateSubscription(subId);
        }
      }
      if (envelope.method === "session.close") {
        await this.cleanupSession(session, "Session closed by client");
      }
    } catch (err) {
      const aepErr = AepError.from(err, AEP_ERROR_CODES.INTERNAL_ERROR);
      if (!session.closed && !session.transport.isClosed) {
        try {
          await session.transport.send({
            protocolVersion: session.protocolVersion,
            kind: "response",
            id: envelope.id,
            ok: false,
            error: aepErr.toJSON(),
          });
        } catch {
          // Ignore send errors on closed transport
        }
      }
    }
  }

  private async dispatchRequest(
    session: InternalSession,
    method: string,
    rawParams: unknown,
  ): Promise<unknown> {
    if (method === "session.initialize") {
      return await this.handleSessionInitialize(session, rawParams as SessionInitializeParams);
    }

    if (!session.initialized) {
      throw new AepError(
        AEP_ERROR_CODES.NOT_INITIALIZED,
        `Method "${method}" invoked before session.initialize completed`,
      );
    }

    switch (method) {
      case "session.close": {
        const _params = rawParams as SessionCloseParams | undefined;
        return { closed: true };
      }
      case "tree.get":
        return await this.handleTreeGet(session, (rawParams ?? {}) as TreeGetParams);
      case "tree.query":
        return await this.handleTreeQuery(session, (rawParams ?? {}) as TreeQueryParams);
      case "node.get":
        return await this.handleNodeGet(session, rawParams as NodeGetParams);
      case "node.loadChildren":
        return await this.handleNodeLoadChildren(session, rawParams as NodeLoadChildrenParams);
      case "node.invoke":
        return await this.handleNodeInvoke(session, rawParams as NodeInvokeParams);
      case "data.getBinary":
        return await this.handleDataGetBinary(session, rawParams as GetBinaryParams);
      case "channel.open":
        return await this.handleChannelOpen(session, rawParams as ChannelOpenParams);
      case "channel.send":
        return await this.handleChannelSend(session, rawParams as ChannelSendParams);
      case "channel.seek":
        return await this.handleChannelSeek(session, rawParams as ChannelSeekParams);
      case "channel.sample":
        return await this.handleChannelSample(session, rawParams as ChannelSampleParams);
      case "channel.close":
        return await this.handleChannelClose(session, rawParams as ChannelCloseParams);
      default:
        throw new AepError(
          AEP_ERROR_CODES.METHOD_NOT_FOUND,
          `Unknown Control-Plane method "${method}"`,
        );
    }
  }

  private async handleSessionInitialize(
    session: InternalSession,
    params: SessionInitializeParams,
  ): Promise<SessionInitializeResult> {
    if (session.initialized) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        "session.initialize already completed on this session",
      );
    }
    if (
      !params ||
      typeof params !== "object" ||
      !params.clientInfo ||
      typeof params.clientInfo.name !== "string" ||
      typeof params.clientInfo.version !== "string" ||
      !Array.isArray(params.supportedVersions)
    ) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PARAMS,
        "session.initialize requires clientInfo and supportedVersions",
      );
    }

    const selectedVersion = params.supportedVersions.find((v) =>
      this.supportedVersions.includes(v),
    );
    if (!selectedVersion) {
      throw new AepError(
        AEP_ERROR_CODES.UNSUPPORTED_VERSION,
        `No mutually supported protocol version among [${params.supportedVersions.join(", ")}]`,
      );
    }

    const requestedSecurity: SecurityDescriptor = params.security ?? {
      mode: "unauthenticated",
      reserved: true,
    };
    if (typeof requestedSecurity.mode !== "string" || requestedSecurity.mode.length === 0) {
      throw new AepError(
        AEP_ERROR_CODES.UNSUPPORTED_AUTH_MODE,
        "security.mode must be a non-empty string",
      );
    }

    let resolvedSecurity: SecurityDescriptor;
    if (this.securityOptions?.authenticate) {
      const authRes = await this.securityOptions.authenticate(
        params.security,
        params,
        session.transport,
      );
      if (!authRes) {
        throw new AepError(
          AEP_ERROR_CODES.UNSUPPORTED_AUTH_MODE,
          `Authentication rejected for security.mode "${requestedSecurity.mode}"`,
        );
      }
      resolvedSecurity = authRes;
    } else {
      const allowedModes = this.securityOptions?.allowedModes ?? [
        this.serverCapabilities.security.mode,
      ];
      if (!allowedModes.includes(requestedSecurity.mode)) {
        throw new AepError(
          AEP_ERROR_CODES.UNSUPPORTED_AUTH_MODE,
          `Unsupported security.mode "${requestedSecurity.mode}"`,
        );
      }
      resolvedSecurity = { ...requestedSecurity };
    }

    const negotiatedCaps = negotiateCapabilities(this.serverCapabilities, params.capabilities);
    const policy = negotiatedCaps.sessions?.policy ?? "single-controller";
    const requestedRole = params.session?.role ?? "controller";
    if (requestedRole !== "controller" && requestedRole !== "observer") {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PARAMS,
        `Invalid session role "${String(requestedRole)}"`,
      );
    }

    let assignedRole: SessionRole = requestedRole;
    if (policy === "single-controller" && requestedRole === "controller") {
      const controllerActive =
        this.activeControllerSessionId !== null &&
        this.sessions.has(this.activeControllerSessionId);
      if (controllerActive) {
        const allowDowngrade = params.session?.allowDowngradeToObserver ?? true;
        if (!allowDowngrade) {
          throw new AepError(
            AEP_ERROR_CODES.CONTROLLER_OCCUPIED,
            "single-controller session is already occupied",
          );
        }
        assignedRole = "observer";
      } else {
        this.activeControllerSessionId = session.sessionId;
      }
    }

    session.protocolVersion = selectedVersion;
    session.capabilities = negotiatedCaps;
    session.policy = policy;
    session.role = assignedRole;
    session.security = resolvedSecurity;

    if (policy === "isolated") {
      session.treeStore = new TreeStore(
        this.treeStore.getHead(),
        this.treeStore.getRawBody(),
        negotiatedCaps,
      );
      session.dataPlane = new DataPlaneManager(session.treeStore);
    }

    session.initialized = true;
    const head = this.buildSessionHead(session);
    const descriptor: SessionDescriptor = {
      sessionId: session.sessionId,
      role: assignedRole,
      policy,
    };

    return {
      protocolVersion: selectedVersion,
      serverInfo: { ...this.serverInfo },
      head,
      session: descriptor,
      security: resolvedSecurity,
    };
  }

  private async handleTreeGet(
    session: InternalSession,
    params: TreeGetParams,
  ): Promise<{ head?: MetaMap; node: unknown }> {
    const path = params.path ?? "/";
    parsePath(path);
    const includeHead = params.includeHead ?? true;
    const node =
      session.treeStore === this.treeStore
        ? await this.mountManager.getTree(path, params.maxDepth)
        : session.treeStore.getTree(path, params.maxDepth);

    return {
      ...(includeHead ? { head: this.buildSessionHead(session) } : {}),
      node,
    };
  }

  private async handleTreeQuery(session: InternalSession, params: TreeQueryParams) {
    if (session.capabilities.queries?.treeQuery === false) {
      throw new AepError(
        AEP_ERROR_CODES.UNSUPPORTED_CAPABILITY,
        "tree.query is disabled in the negotiated capabilities",
      );
    }
    if (session.treeStore === this.treeStore && this.mountManager.hasMounts()) {
      return await this.mountManager.queryTree(params);
    }
    const rootPath = params.rootPath ?? "/";
    const target = session.treeStore.getTree(rootPath);
    const allMatches = querySubtree(target, rootPath, params);
    return paginateMatches(allMatches, params.cursor, params.limit);
  }

  private async handleNodeGet(session: InternalSession, params: NodeGetParams) {
    if (!params || typeof params.path !== "string") {
      throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, "node.get requires path");
    }
    if (params.path === "/") {
      throw new AepError(AEP_ERROR_CODES.INVALID_PATH, 'node.get cannot target root "/"');
    }
    parsePath(params.path);
    const node =
      session.treeStore === this.treeStore
        ? await this.mountManager.getNode(params.path, params.maxDepth)
        : session.treeStore.getNode(params.path, params.maxDepth);
    return { path: params.path, node };
  }

  private async handleNodeLoadChildren(
    session: InternalSession,
    params: NodeLoadChildrenParams,
  ): Promise<NodeLoadChildrenResult> {
    if (session.capabilities.queries?.loadChildren === false) {
      throw new AepError(
        AEP_ERROR_CODES.UNSUPPORTED_CAPABILITY,
        "node.loadChildren is disabled in the negotiated capabilities",
      );
    }
    if (!params || typeof params.path !== "string") {
      throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, "node.loadChildren requires path");
    }
    if (params.path === "/") {
      throw new AepError(AEP_ERROR_CODES.INVALID_PATH, 'node.loadChildren cannot target root "/"');
    }
    parsePath(params.path);

    if (session.treeStore === this.treeStore) {
      const mount = this.mountManager.findMountForPath(params.path);
      if (mount) {
        return await this.mountManager.loadChildren(mount, params);
      }
    }

    const node = session.treeStore.findNodeInternal(params.path);
    if (!node) {
      throw new AepError(
        AEP_ERROR_CODES.NODE_NOT_FOUND,
        `Node not found at path "${params.path}"`,
      );
    }
    if (node.kind === "channel") {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PARAMS,
        `Channel node "${params.path}" is a leaf and cannot load children`,
      );
    }

    const loader = this.childrenLoaders.get(params.path) ?? this.fallbackChildrenLoader;
    if (loader) {
      const loaded = await loader(
        {
          path: params.path,
          node: cloneNode(node),
          ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        },
        this.toSessionContext(session),
      );
      const rawChildren = Array.isArray(loaded) ? loaded : loaded.children;
      const hasMore = Array.isArray(loaded) ? false : Boolean(loaded.hasMore);
      const nextCursor = Array.isArray(loaded) ? undefined : loaded.nextCursor;

      const validatedChildren = rawChildren.map((child) => {
        const cloned = cloneNode(child);
        validateNode(cloned, node.kind, new Set([node]), params.path, node.type);
        validateNodeCapabilities(
          cloned,
          session.capabilities,
          `${params.path}/${cloned.id}`,
        );
        return cloned;
      });

      const existingChildren = node.children ?? [];
      for (const child of validatedChildren) {
        const existingIdx = existingChildren.findIndex((c) => c.id === child.id);
        if (existingIdx >= 0) {
          existingChildren[existingIdx] = cloneNode(child) as never;
        } else {
          existingChildren.push(cloneNode(child) as never);
        }
      }
      node.children = existingChildren as never;
      node.hasChildren = hasMore;

      return {
        path: params.path,
        children: validatedChildren,
        hasMore,
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      };
    }

    const existing = (node.children ?? []).map((c) => cloneNode(c));
    let offset = 0;
    if (params.cursor !== undefined) {
      if (!/^\d+$/.test(params.cursor)) {
        throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, `Invalid cursor "${params.cursor}"`);
      }
      offset = Number(params.cursor);
    }
    if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit <= 0)) {
      throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, "limit must be a positive integer");
    }
    const end = params.limit !== undefined ? offset + params.limit : undefined;
    const page = existing.slice(offset, end);
    const nextOffset = offset + page.length;
    const hasMore = params.limit !== undefined && nextOffset < existing.length;

    return {
      path: params.path,
      children: page,
      hasMore,
      ...(hasMore ? { nextCursor: String(nextOffset) } : {}),
    };
  }

  private async handleNodeInvoke(session: InternalSession, params: NodeInvokeParams) {
    if (!params || typeof params.path !== "string" || typeof params.method !== "string") {
      throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, "node.invoke requires path and method");
    }
    if (params.path === "/") {
      throw new AepError(AEP_ERROR_CODES.INVALID_PATH, 'node.invoke cannot target root "/"');
    }
    parsePath(params.path);
    if (!isValidNamespacedIdent(params.method)) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PARAMS,
        `Invalid method name "${params.method}"`,
      );
    }

    const sessionCtx = this.toSessionContext(session);

    if (session.treeStore === this.treeStore) {
      const mount = this.mountManager.findMountForPath(params.path);
      if (mount) {
        const localKey = `${params.path}::${params.method}`;
        const isRootMountAnchor = params.path === mount.anchorPath && mount.sourcePath === "/";
        if (!(isRootMountAnchor && this.methodHandlers.has(localKey))) {
          const result = await this.mountManager.invokeMounted(
            mount,
            params.path,
            params.method,
            params.params,
            sessionCtx,
          );
          return { path: params.path, method: params.method, result };
        }
      }
    }

    const node = session.treeStore.findNodeInternal(params.path);
    if (!node) {
      throw new AepError(
        AEP_ERROR_CODES.NODE_NOT_FOUND,
        `Node not found at path "${params.path}"`,
      );
    }

    const decl = node.methods?.find((m) => m.name === params.method);
    const sideEffects = decl?.sideEffects ?? "write";
    const specificHandler = this.methodHandlers.get(`${params.path}::${params.method}`);

    if (!decl && !specificHandler && !this.fallbackInvokeHandler) {
      throw new AepError(
        AEP_ERROR_CODES.METHOD_NOT_FOUND,
        `Method "${params.method}" not found on node "${params.path}"`,
      );
    }

    if (session.role === "observer" && sideEffects === "write") {
      throw new AepError(
        AEP_ERROR_CODES.READ_ONLY_SESSION,
        `Observer session cannot invoke write method "${params.method}" on "${params.path}"`,
      );
    }

    const handler = specificHandler ?? this.fallbackInvokeHandler;
    if (!handler) {
      throw new AepError(
        AEP_ERROR_CODES.METHOD_NOT_FOUND,
        `No handler registered for method "${params.method}" on "${params.path}"`,
      );
    }

    const isIsolated = session.treeStore !== this.treeStore;
    const ctx: MethodHandlerContext = {
      path: params.path,
      method: params.method,
      node: cloneNode(node),
      session: sessionCtx,
      addNode: async (parentPath, child, index) => {
        if (!isIsolated) {
          return await this.addNode(parentPath, child, index);
        }
        const added = session.treeStore.addNode(parentPath, child, index, session.capabilities);
        await this.sendNotification(session, "node.added", {
          parentPath,
          node: cloneNode(added),
          ...(index !== undefined ? { index } : {}),
        });
        return added;
      },
      updateNode: async (targetPath, updater) => {
        if (!isIsolated) {
          return await this.updateNode(targetPath, updater);
        }
        const updated = session.treeStore.updateNode(targetPath, updater, session.capabilities);
        await this.sendNotification(session, "node.updated", {
          path: targetPath,
          node: cloneNode(updated),
        });
        return updated;
      },
      removeNode: async (targetPath) => {
        if (!isIsolated) {
          await this.removeNode(targetPath);
          return;
        }
        session.treeStore.removeNode(targetPath);
        await this.sendNotification(session, "node.removed", { path: targetPath });
      },
      emitEvent: async (targetPath, event, data, timestamp) => {
        if (!isIsolated) {
          await this.emitNodeEvent(targetPath, event, data, timestamp);
          return;
        }
        await this.sendNotification(session, "node.event", {
          path: targetPath,
          event,
          timestamp: timestamp ?? new Date().toISOString(),
          ...(data !== undefined ? { data } : {}),
        });
      },
    };

    const result = await handler(params.params, ctx);
    return {
      path: params.path,
      method: params.method,
      result,
    };
  }

  private async handleDataGetBinary(session: InternalSession, params: GetBinaryParams) {
    if (!session.capabilities.dataPlane.binaryReferences) {
      throw new AepError(
        AEP_ERROR_CODES.UNSUPPORTED_CAPABILITY,
        "binaryReferences capability is disabled for this session",
      );
    }
    if (!params || typeof params.refId !== "string" || params.refId.length === 0) {
      throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, "data.getBinary requires refId");
    }
    if (session.treeStore === this.treeStore && this.mountManager.canHandleBinaryRef(params.refId)) {
      return await this.mountManager.getBinary(params);
    }
    return await session.dataPlane.getBinary(params, this.toSessionContext(session));
  }

  private async handleChannelOpen(session: InternalSession, params: ChannelOpenParams) {
    if (!params || (params.path === undefined && params.refId === undefined)) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PARAMS,
        "channel.open requires at least one of path or refId",
      );
    }
    if (
      !session.capabilities.nodeKinds.includes("channel") ||
      !session.capabilities.dataPlane.streamReferences
    ) {
      throw new AepError(
        AEP_ERROR_CODES.UNSUPPORTED_CAPABILITY,
        "Channel streams are disabled in the negotiated capabilities",
      );
    }
    if (session.treeStore === this.treeStore) {
      const mountTarget = this.mountManager.resolveMountedChannelTarget(params.path, params.refId);
      if (mountTarget) {
        return await this.mountManager.openChannel(
          mountTarget,
          params,
          this.toSessionContext(session),
          (method, payload) => this.sendNotification(session, method, payload),
        );
      }
    }
    return await session.dataPlane.openChannel(
      params,
      this.toSessionContext(session),
      (method, payload) => this.sendNotification(session, method, payload),
    );
  }

  private async handleChannelSend(session: InternalSession, params: ChannelSendParams) {
    if (
      session.treeStore === this.treeStore &&
      params &&
      typeof params.subscriptionId === "string" &&
      this.mountManager.hasProxySubscription(params.subscriptionId)
    ) {
      return await this.mountManager.sendChannel(params, this.toSessionContext(session));
    }
    return await session.dataPlane.sendChannel(params, this.toSessionContext(session));
  }

  private async handleChannelSeek(session: InternalSession, params: ChannelSeekParams) {
    if (
      session.treeStore === this.treeStore &&
      params &&
      typeof params.subscriptionId === "string" &&
      this.mountManager.hasProxySubscription(params.subscriptionId)
    ) {
      return await this.mountManager.seekChannel(params, this.toSessionContext(session));
    }
    return await session.dataPlane.seekChannel(params, this.toSessionContext(session));
  }

  private async handleChannelSample(session: InternalSession, params: ChannelSampleParams) {
    if (!session.capabilities.dataPlane.sample) {
      throw new AepError(
        AEP_ERROR_CODES.UNSUPPORTED_CAPABILITY,
        "channel.sample capability is disabled for this session",
      );
    }
    if (!params || (params.path === undefined && params.refId === undefined)) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PARAMS,
        "channel.sample requires at least one of path or refId",
      );
    }
    if (session.treeStore === this.treeStore) {
      const mountTarget = this.mountManager.resolveMountedChannelTarget(params.path, params.refId);
      if (mountTarget) {
        return await this.mountManager.sampleChannel(mountTarget, params);
      }
    }
    return await session.dataPlane.sampleChannel(params, this.toSessionContext(session));
  }

  private async handleChannelClose(session: InternalSession, params: ChannelCloseParams) {
    if (!params || typeof params.subscriptionId !== "string") {
      throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, "channel.close requires subscriptionId");
    }
    if (
      session.treeStore === this.treeStore &&
      this.mountManager.hasProxySubscription(params.subscriptionId)
    ) {
      return await this.mountManager.closeChannel(params.subscriptionId, session.sessionId);
    }
    return await session.dataPlane.closeChannel(params.subscriptionId, session.sessionId);
  }

  private async cleanupSession(session: InternalSession, reason?: string): Promise<void> {
    if (session.closed) {
      return;
    }
    session.closed = true;
    this.sessions.delete(session.sessionId);

    if (this.activeControllerSessionId === session.sessionId) {
      this.activeControllerSessionId = null;
    }

    for (const unsub of session.unsubscribers) {
      unsub();
    }
    session.unsubscribers.length = 0;

    await session.dataPlane.closeSessionSubscriptions(session.sessionId);
    if (session.treeStore === this.treeStore) {
      await this.mountManager.closeSessionSubscriptions(session.sessionId);
    }

    if (!session.transport.isClosed) {
      await session.transport.close(reason);
    }
  }
}
