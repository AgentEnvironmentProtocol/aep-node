import { randomUUID } from "node:crypto";
import { AEP_ERROR_CODES, AepError } from "../core/errors.js";
import { isPathWithin, isValidNamespacedIdent, isValidPath, parsePath, rebasePath } from "../core/path.js";
import { buildCapabilities, negotiateCapabilities } from "../core/profiles.js";
import { synthesizeRenderMinimal } from "../core/render-minimal.js";
import { cloneNode, paginateMatches, querySubtree } from "../core/tree-utils.js";
import {
  AEP_PROTOCOL_VERSION,
  HEAD_KEYS,
  type AepNode,
  type AepValue,
  type AllowedFactor,
  type AuthChallenge,
  type BinaryRef,
  type BodyChild,
  type CapabilitiesObject,
  type ChannelCloseParams,
  type ChannelOpenParams,
  type ChannelSampleParams,
  type ChannelSeekParams,
  type ChannelSendParams,
  type ControlEnvelope,
  type DataRenderOptions,
  type DataRenderParams,
  type DataRenderResult,
  type ElevationAuditRecord,
  type ElevationChallengeData,
  type ElevationGrantSummary,
  type ElevationLevel,
  type ElevationSpec,
  type GetBinaryParams,
  type LeaseMode,
  type MetaMap,
  type NodeGetParams,
  type NodeInvokeParams,
  type NodeLoadChildrenParams,
  type NodeLoadChildrenResult,
  type NotificationEnvelope,
  type Path,
  type RenderMode,
  type SecurityDescriptor,
  type ServerInfo,
  type SessionAcquireLeaseParams,
  type SessionAcquireLeaseResult,
  type SessionAuthenticateParams,
  type SessionAuthenticateResult,
  type SessionCloseParams,
  type SessionDescriptor,
  type SessionDropElevationParams,
  type SessionDropElevationResult,
  type SessionElevateParams,
  type SessionElevateResult,
  type SessionInitializeParams,
  type SessionInitializeResult,
  type SessionPolicy,
  type SessionReleaseLeaseParams,
  type SessionReleaseLeaseResult,
  type SessionResumeParams,
  type SessionResumeResult,
  type SessionRole,
  type TreeGetParams,
  type TreeQueryParams,
} from "../core/types.js";
import { validateNode, validateNodeCapabilities } from "../core/validation.js";
import {
  buildSupportedVersionList,
  negotiateProtocolVersion,
  type ProtocolVersionAdapter,
} from "../core/version.js";
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

export interface ServerRenderRequest {
  readonly path: Path;
  readonly node: AepNode;
  readonly mode: RenderMode;
  readonly params?: DataRenderOptions;
}

export type ServerRenderHandler = (
  request: ServerRenderRequest,
  session: ServerSessionContext,
) =>
  | Promise<
      | DataRenderResult
      | {
          mediaType: string;
          data: Uint8Array | string;
          reference?: BinaryRef;
          pathMap?: Record<string, Path>;
        }
    >
  | DataRenderResult
  | {
      mediaType: string;
      data: Uint8Array | string;
      reference?: BinaryRef;
      pathMap?: Record<string, Path>;
    };

export interface ChallengeIssuerResult {
  challenge: AuthChallenge;
  verify: (
    params: SessionAuthenticateParams,
    transport: Transport,
  ) => Promise<SecurityDescriptor | null> | SecurityDescriptor | null;
}

export interface ServerElevationOptions {
  enabled?: boolean;
  maxDurationMs?: number;
  defaultAllowedFactors?: AllowedFactor[];
  evaluate?: (
    params: SessionElevateParams,
    ctx: { session: ServerSessionContext; challenge?: ElevationChallengeData },
  ) =>
    | Promise<{ status: "granted" | "pending" | "denied"; expiresAt?: string; reason?: string }>
    | { status: "granted" | "pending" | "denied"; expiresAt?: string; reason?: string };
  onAudit?: (record: ElevationAuditRecord) => void;
}

export interface AepServerSecurityOptions {
  allowedModes?: string[];
  allowInsecureTransport?: boolean;
  authenticate?: (
    security: SecurityDescriptor | undefined,
    params: SessionInitializeParams,
    transport: Transport,
  ) => Promise<SecurityDescriptor | null> | SecurityDescriptor | null;
  issueChallenge?: (
    security: SecurityDescriptor | undefined,
    params: SessionInitializeParams,
    transport: Transport,
  ) => Promise<ChallengeIssuerResult> | ChallengeIssuerResult;
  authenticateRefresh?: (
    params: SessionAuthenticateParams,
    session: ServerSessionContext,
  ) => Promise<SecurityDescriptor | null> | SecurityDescriptor | null;
  elevation?: ServerElevationOptions;
}

export interface AepServerOptions {
  serverInfo?: ServerInfo;
  protocolVersions?: string[];
  versionAdapters?: ProtocolVersionAdapter[];
  allowCompatibleMinorVersions?: boolean;
  capabilities?: "aep-core-static" | "aep-core-streaming" | Partial<CapabilitiesObject>;
  head?: MetaMap;
  body?: BodyChild[];
  security?: AepServerSecurityOptions;
  originId?: string;
}

export interface ServerSessionHandle {
  readonly sessionId: string;
  readonly initialized: boolean;
  readonly protocolVersion?: string;
  readonly role?: SessionRole;
  readonly capabilities?: CapabilitiesObject;
  close(reason?: string): Promise<void>;
}

interface PendingChallengeAuth {
  selectedVersion: string;
  requestedParams: SessionInitializeParams;
  negotiatedCaps: CapabilitiesObject;
  challenge: AuthChallenge;
  verify: ChallengeIssuerResult["verify"];
}

interface InternalElevationGrant {
  grantId: string;
  challengeId?: string;
  status: "granted" | "pending" | "denied" | "expired" | "revoked";
  level: ElevationLevel;
  targetPath: Path;
  scopes: string[];
  singleUse: boolean;
  expiresAtMs?: number;
  expiresAt?: string;
  factorType: AllowedFactor;
  reason: string;
  consumed?: boolean;
}

interface InternalLease {
  leaseId: string;
  path: Path;
  uid?: string;
  mode: LeaseMode;
  holderSessionId: string;
  holderName?: string;
  expiresAtMs: number;
  expiresAt: string;
}

interface InternalSession {
  sessionId: string;
  transport: Transport;
  initialized: boolean;
  closed: boolean;
  disconnected: boolean;
  disconnectedAt?: number;
  explicitlyClosed: boolean;
  protocolVersion: string;
  versionAdapter?: ProtocolVersionAdapter;
  role: SessionRole;
  policy: SessionPolicy;
  capabilities: CapabilitiesObject;
  security: SecurityDescriptor;
  resumeToken?: string;
  outboundSeq: number;
  notificationHistory: Array<{ seq: number; envelope: NotificationEnvelope }>;
  pendingAuth?: PendingChallengeAuth;
  activeGrants: Map<string, InternalElevationGrant>;
  pendingElevationChallenges: Map<string, ElevationChallengeData>;
  treeStore: TreeStore;
  dataPlane: DataPlaneManager;
  unsubscribers: Array<() => void>;
}

const DEFAULT_SERVER_INFO: ServerInfo = {
  name: "aep-node-server",
  version: "1.0.0-beta.0",
};

const ELEVATION_RANK: Record<ElevationLevel, number> = {
  none: 0,
  confirm: 1,
  elevated: 2,
  admin: 3,
};

const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_ELEVATION_MAX_DURATION_MS = 300_000;
const DEFAULT_REPLAY_WINDOW = 1000;

export class AepServer {
  readonly originId: string;
  private readonly serverInfo: ServerInfo;
  private readonly supportedVersions: string[];
  private readonly versionAdapters: ProtocolVersionAdapter[];
  private readonly allowCompatibleMinorVersions: boolean;
  private readonly serverCapabilities: CapabilitiesObject;
  private readonly securityOptions?: AepServerSecurityOptions;
  private readonly treeStore: TreeStore;
  private readonly dataPlane: DataPlaneManager;
  private readonly mountManager: ServerMountManager;
  private readonly sessions = new Map<string, InternalSession>();
  private readonly leases = new Map<string, InternalLease>();
  private readonly pendingResumes = new Map<string, () => Promise<void>>();
  private readonly methodHandlers = new Map<string, ServerMethodHandler>();
  private fallbackInvokeHandler?: ServerMethodHandler;
  private readonly childrenLoaders = new Map<Path, ServerChildrenLoader>();
  private fallbackChildrenLoader?: ServerChildrenLoader;
  private readonly renderHandlers = new Map<Path, ServerRenderHandler>();
  private fallbackRenderHandler?: ServerRenderHandler;
  private activeControllerSessionId: string | null = null;
  private closed = false;

  constructor(options: AepServerOptions = {}) {
    this.originId = options.originId ?? `srv-${randomUUID()}`;
    this.serverInfo = options.serverInfo ?? { ...DEFAULT_SERVER_INFO };
    this.versionAdapters = options.versionAdapters ? [...options.versionAdapters] : [];
    this.allowCompatibleMinorVersions = options.allowCompatibleMinorVersions ?? true;
    this.supportedVersions = buildSupportedVersionList(
      options.protocolVersions,
      this.versionAdapters,
    );
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

  get protocolVersions(): string[] {
    return [...this.supportedVersions];
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
      disconnected: false,
      explicitlyClosed: false,
      protocolVersion: this.supportedVersions[0] ?? AEP_PROTOCOL_VERSION,
      role: "observer",
      policy,
      capabilities: structuredClone(this.serverCapabilities),
      security: {
        mode: this.serverCapabilities.security.mode,
        ...(this.serverCapabilities.security.reserved !== undefined
          ? { reserved: this.serverCapabilities.security.reserved }
          : {}),
      },
      outboundSeq: 0,
      notificationHistory: [],
      activeGrants: new Map(),
      pendingElevationChallenges: new Map(),
      treeStore: this.treeStore,
      dataPlane: this.dataPlane,
      unsubscribers: [],
    };

    this.sessions.set(sessionId, session);
    this.attachSessionTransport(session, transport);

    return {
      sessionId,
      get initialized() {
        return session.initialized;
      },
      get protocolVersion() {
        return session.initialized || session.pendingAuth ? session.protocolVersion : undefined;
      },
      get role() {
        return session.initialized ? session.role : undefined;
      },
      get capabilities() {
        return session.initialized ? structuredClone(session.capabilities) : undefined;
      },
      close: async (reason?: string) => {
        session.explicitlyClosed = true;
        await this.cleanupSession(session, reason);
      },
    };
  }

  private attachSessionTransport(session: InternalSession, transport: Transport): void {
    for (const unsub of session.unsubscribers) {
      unsub();
    }
    session.unsubscribers.length = 0;
    session.transport = transport;

    session.unsubscribers.push(
      transport.onMessage((envelope) => {
        void this.handleIncomingEnvelope(session, envelope);
      }),
    );
    session.unsubscribers.push(
      transport.onClose(() => {
        void this.handleTransportDisconnect(session);
      }),
    );
  }

  private async handleTransportDisconnect(session: InternalSession): Promise<void> {
    if (session.closed) {
      return;
    }
    const resumptionEnabled =
      session.initialized &&
      !session.explicitlyClosed &&
      session.capabilities.resumption?.enabled === true &&
      typeof session.resumeToken === "string";

    if (!resumptionEnabled) {
      await this.cleanupSession(session);
      return;
    }

    session.disconnected = true;
    session.disconnectedAt = Date.now();
    for (const unsub of session.unsubscribers) {
      unsub();
    }
    session.unsubscribers.length = 0;
    session.dataPlane.detachSessionSubscriptions(session.sessionId);
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
    await Promise.all(
      active.map((session) => {
        session.explicitlyClosed = true;
        return this.cleanupSession(session, "Server closed");
      }),
    );
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

  registerRenderer(path: Path, handler: ServerRenderHandler): void {
    parsePath(path);
    this.renderHandlers.set(path, handler);
  }

  onRender(handler: ServerRenderHandler): void {
    this.fallbackRenderHandler = handler;
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

  async moveNode(
    fromPath: Path,
    toPath: Path,
    index?: number,
  ): Promise<{ node: AepNode; fromPath: Path; toPath: Path; uid?: string }> {
    const moved = this.treeStore.moveNode(fromPath, toPath, index, this.serverCapabilities);
    this.dataPlane.relocatePath(fromPath, toPath);
    for (const lease of this.leases.values()) {
      if (isPathWithin(lease.path, fromPath)) {
        const rebased = rebasePath(lease.path, fromPath, toPath);
        if (rebased) {
          lease.path = rebased;
        }
      }
    }

    const promises: Array<Promise<void>> = [];
    for (const session of this.sessions.values()) {
      if (!session.initialized || session.closed) {
        continue;
      }
      if (session.treeStore !== this.treeStore) {
        session.treeStore.moveNode(fromPath, toPath, index, session.capabilities);
        session.dataPlane.relocatePath(fromPath, toPath);
      }
      promises.push(
        this.sendNotification(session, "node.moved", {
          fromPath,
          toPath,
          ...(moved.uid !== undefined ? { uid: moved.uid } : {}),
          node: cloneNode(moved.node),
          ...(index !== undefined ? { index } : {}),
        }),
      );
    }
    await Promise.all(promises);
    return moved;
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

  async emitAuthExpiring(sessionId: string, expiresAt: string, remainingMs: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.initialized || session.closed) {
      return;
    }
    await this.sendNotification(session, "session.authExpiring", { expiresAt, remainingMs });
  }

  async resolveElevation(
    grantId: string,
    status: "granted" | "denied" | "expired" | "revoked",
    reason?: string,
  ): Promise<void> {
    for (const session of this.sessions.values()) {
      const grant = session.activeGrants.get(grantId);
      if (!grant) {
        continue;
      }
      grant.status = status;
      if (status !== "granted") {
        if (status === "revoked" || status === "expired" || status === "denied") {
          session.activeGrants.delete(grantId);
        }
      }
      this.syncSessionElevationSecurity(session);
      this.auditElevation(session, grant, "session.resolveElevation", status, reason ?? grant.reason);
      await this.sendNotification(session, "session.elevationUpdated", {
        grantId,
        ...(grant.challengeId !== undefined ? { challengeId: grant.challengeId } : {}),
        status,
        ...(grant.expiresAt !== undefined ? { expiresAt: grant.expiresAt } : {}),
        ...(reason !== undefined ? { reason } : {}),
      });
      return;
    }
    throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, `Elevation grant "${grantId}" not found`);
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

  private syncSessionElevationSecurity(session: InternalSession): void {
    const now = Date.now();
    const activeSummaries: ElevationGrantSummary[] = [];
    for (const [id, grant] of session.activeGrants.entries()) {
      if (grant.expiresAtMs !== undefined && grant.expiresAtMs <= now) {
        session.activeGrants.delete(id);
        continue;
      }
      if (grant.status === "granted" && !grant.consumed) {
        activeSummaries.push({
          grantId: grant.grantId,
          level: grant.level,
          targetPath: grant.targetPath,
          scopes: [...grant.scopes],
          singleUse: grant.singleUse,
          ...(grant.expiresAt !== undefined ? { expiresAt: grant.expiresAt } : {}),
        });
      }
    }
    session.security = {
      ...session.security,
      elevation: {
        activeGrants: activeSummaries,
      },
    };
  }

  private encodeOutboundEnvelope(
    session: InternalSession,
    envelope: ControlEnvelope,
  ): ControlEnvelope {
    return session.versionAdapter?.encodeEnvelope
      ? session.versionAdapter.encodeEnvelope(envelope)
      : envelope;
  }

  private buildSessionHead(session: InternalSession): MetaMap {
    const baseHead = session.treeStore.getHead();
    const rawHead: MetaMap = {
      ...baseHead,
      [HEAD_KEYS.PROTOCOL_VERSION]: session.protocolVersion,
      [HEAD_KEYS.SERVER_INFO]: this.serverInfo as unknown as AepValue,
      [HEAD_KEYS.CAPABILITIES]: session.capabilities as unknown as AepValue,
      [HEAD_KEYS.PROFILES]: session.capabilities.profile ? [session.capabilities.profile] : [],
      [HEAD_KEYS.SESSION]: {
        sessionId: session.sessionId,
        role: session.role,
        policy: session.policy,
        ...(session.resumeToken !== undefined ? { resumeToken: session.resumeToken } : {}),
      },
      [HEAD_KEYS.SECURITY]: session.security as MetaMap,
      [HEAD_KEYS.ORIGIN_ID]: this.originId,
      [HEAD_KEYS.MOUNT_ORIGINS]: [this.originId, ...this.mountManager.getMountedOriginIds()],
    };
    return session.versionAdapter?.adaptHead ? session.versionAdapter.adaptHead(rawHead) : rawHead;
  }

  private toSessionContext(session: InternalSession): ServerSessionContext {
    return {
      sessionId: session.sessionId,
      role: session.role,
      capabilities: session.capabilities,
      peerIdentity: session.transport.peerIdentity,
      principal: session.security.principal,
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
    if (session.closed) {
      return;
    }
    session.outboundSeq += 1;
    const envelope: NotificationEnvelope = {
      protocolVersion: session.protocolVersion,
      kind: "notification",
      method,
      params,
      seq: session.outboundSeq,
    };
    if (session.capabilities.resumption?.enabled) {
      const maxHistory = session.capabilities.resumption.replayWindowEvents ?? DEFAULT_REPLAY_WINDOW;
      session.notificationHistory.push({ seq: session.outboundSeq, envelope });
      if (session.notificationHistory.length > maxHistory) {
        session.notificationHistory.shift();
      }
    }
    if (session.disconnected || session.transport.isClosed) {
      return;
    }
    try {
      await session.transport.send(this.encodeOutboundEnvelope(session, envelope));
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

    const replyTransport = session.transport;
    try {
      if (
        (session.initialized || session.pendingAuth) &&
        envelope.method !== "session.initialize" &&
        envelope.method !== "session.resume" &&
        envelope.protocolVersion !== session.protocolVersion
      ) {
        throw new AepError(
          AEP_ERROR_CODES.UNSUPPORTED_VERSION,
          `Envelope protocolVersion "${envelope.protocolVersion}" does not match negotiated session protocolVersion "${session.protocolVersion}"`,
          {
            expectedVersion: session.protocolVersion,
            actualVersion: envelope.protocolVersion,
            supportedVersions: [...this.supportedVersions],
          },
        );
      }

      const decodedEnvelope =
        session.versionAdapter?.decodeEnvelope && envelope.method !== "session.initialize"
          ? session.versionAdapter.decodeEnvelope(envelope)
          : envelope;
      if (decodedEnvelope.kind !== "request") {
        throw new AepError(AEP_ERROR_CODES.INVALID_MESSAGE, "Decoded envelope is not a request");
      }

      const result = await this.dispatchRequest(
        session,
        decodedEnvelope.method,
        decodedEnvelope.params,
      );
      if ((!session.closed || decodedEnvelope.method === "session.resume") && !replyTransport.isClosed) {
        await replyTransport.send(
          this.encodeOutboundEnvelope(session, {
            protocolVersion: session.protocolVersion,
            kind: "response",
            id: decodedEnvelope.id,
            ok: true,
            result,
          }),
        );
      }
      if (
        decodedEnvelope.method === "session.resume" &&
        result &&
        typeof (result as { sessionId?: unknown }).sessionId === "string"
      ) {
        const resumedId = (result as { sessionId: string }).sessionId;
        const replay = this.pendingResumes.get(resumedId);
        if (replay) {
          this.pendingResumes.delete(resumedId);
          await replay();
        }
      }
      if (
        decodedEnvelope.method === "channel.open" &&
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
      if (decodedEnvelope.method === "session.close") {
        session.explicitlyClosed = true;
        await this.cleanupSession(session, "Session closed by client");
      }
    } catch (err) {
      const aepErr = AepError.from(err, AEP_ERROR_CODES.INTERNAL_ERROR);
      if (!session.closed && !replyTransport.isClosed) {
        try {
          await replyTransport.send(
            this.encodeOutboundEnvelope(session, {
              protocolVersion: session.protocolVersion,
              kind: "response",
              id: envelope.id,
              ok: false,
              error: aepErr.toJSON(),
            }),
          );
        } catch {
          // Ignore send errors on closed transport
        }
      }
    }
  }

  private checkCredentialNotExpired(session: InternalSession, method: string): void {
    if (method === "session.authenticate" || method === "session.close") {
      return;
    }
    if (typeof session.security.expiresAt === "string") {
      const expMs = Date.parse(session.security.expiresAt);
      if (Number.isFinite(expMs) && expMs <= Date.now()) {
        throw new AepError(
          AEP_ERROR_CODES.TOKEN_EXPIRED,
          "Session credential expired; refresh via session.authenticate",
        );
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
    if (method === "session.authenticate") {
      return await this.handleSessionAuthenticate(session, rawParams as SessionAuthenticateParams);
    }
    if (method === "session.resume") {
      return await this.handleSessionResume(session, rawParams as SessionResumeParams);
    }
    if (method === "session.close" && session.pendingAuth) {
      return { closed: true };
    }

    if (session.pendingAuth) {
      throw new AepError(
        AEP_ERROR_CODES.AUTHENTICATION_REQUIRED,
        `Method "${method}" requires completing session.authenticate`,
      );
    }
    if (!session.initialized) {
      throw new AepError(
        AEP_ERROR_CODES.NOT_INITIALIZED,
        `Method "${method}" invoked before session.initialize completed`,
      );
    }

    this.checkCredentialNotExpired(session, method);

    switch (method) {
      case "session.close": {
        const _params = rawParams as SessionCloseParams | undefined;
        return { closed: true };
      }
      case "session.acquireLease":
        return await this.handleSessionAcquireLease(session, rawParams as SessionAcquireLeaseParams);
      case "session.releaseLease":
        return await this.handleSessionReleaseLease(session, rawParams as SessionReleaseLeaseParams);
      case "session.elevate":
        return await this.handleSessionElevate(session, rawParams as SessionElevateParams);
      case "session.dropElevation":
        return await this.handleSessionDropElevation(session, rawParams as SessionDropElevationParams);
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
      case "data.render":
        return await this.handleDataRender(session, rawParams as DataRenderParams);
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

  private assertTransportSecurity(transport: Transport, security: SecurityDescriptor): void {
    const insecureFlag =
      transport.peerIdentity?.["insecure"] === true ||
      transport.peerIdentity?.["nonLoopbackPlaintext"] === true;
    if (insecureFlag && !this.securityOptions?.allowInsecureTransport) {
      if (
        security.mode === "bearer" ||
        security.mode === "api-key" ||
        transport.peerIdentity?.["nonLoopbackPlaintext"] === true
      ) {
        throw new AepError(
          AEP_ERROR_CODES.INSECURE_TRANSPORT,
          `Transport is insecure for auth mode "${security.mode}"`,
        );
      }
    }
  }

  private finalizeAuthenticatedSession(
    session: InternalSession,
    params: SessionInitializeParams,
    selectedVersion: string,
    negotiatedCaps: CapabilitiesObject,
    resolvedSecurity: SecurityDescriptor,
  ): { head: MetaMap; descriptor: SessionDescriptor; security: SecurityDescriptor } {
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
    session.security = {
      ...resolvedSecurity,
      sessionAuthenticated: resolvedSecurity.mode !== "unauthenticated",
    };
    if (negotiatedCaps.resumption?.enabled) {
      session.resumeToken = `res-${randomUUID()}`;
    }

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
      ...(session.resumeToken !== undefined ? { resumeToken: session.resumeToken } : {}),
    };

    return { head, descriptor, security: session.security };
  }

  private async handleSessionInitialize(
    session: InternalSession,
    params: SessionInitializeParams,
  ): Promise<SessionInitializeResult> {
    if (session.initialized || session.pendingAuth) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        "session.initialize already called on this session",
      );
    }
    if (
      !params ||
      typeof params !== "object" ||
      !params.clientInfo ||
      typeof params.clientInfo.name !== "string" ||
      typeof params.clientInfo.version !== "string" ||
      !Array.isArray(params.supportedVersions) ||
      params.supportedVersions.length === 0 ||
      params.supportedVersions.some((v) => typeof v !== "string" || v.length === 0)
    ) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PARAMS,
        "session.initialize requires clientInfo and a non-empty supportedVersions array",
      );
    }

    const negotiatedVersion = negotiateProtocolVersion(params.supportedVersions, {
      supportedVersions: this.supportedVersions,
      adapters: this.versionAdapters,
      allowCompatibleMinor: this.allowCompatibleMinorVersions,
    });
    if (!negotiatedVersion) {
      throw new AepError(
        AEP_ERROR_CODES.UNSUPPORTED_VERSION,
        `No mutually supported protocol version among [${params.supportedVersions.join(", ")}]`,
        {
          supportedVersions: [...this.supportedVersions],
          requestedVersions: [...params.supportedVersions],
        },
      );
    }
    const selectedVersion = negotiatedVersion.selectedVersion;
    session.versionAdapter = negotiatedVersion.adapter;

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

    this.assertTransportSecurity(session.transport, requestedSecurity);

    const allowedModes = this.securityOptions?.allowedModes ??
      this.serverCapabilities.security.supportedModes ?? [this.serverCapabilities.security.mode];

    if (!this.securityOptions?.authenticate && !allowedModes.includes(requestedSecurity.mode)) {
      throw new AepError(
        AEP_ERROR_CODES.UNSUPPORTED_AUTH_MODE,
        `Unsupported security.mode "${requestedSecurity.mode}"`,
      );
    }

    const rawNegotiatedCaps = negotiateCapabilities(this.serverCapabilities, params.capabilities);
    const negotiatedCaps = session.versionAdapter?.adaptCapabilities
      ? session.versionAdapter.adaptCapabilities(rawNegotiatedCaps)
      : rawNegotiatedCaps;

    if (requestedSecurity.mode === "challenge-response") {
      if (!allowedModes.includes("challenge-response") && !this.securityOptions?.issueChallenge) {
        throw new AepError(
          AEP_ERROR_CODES.UNSUPPORTED_AUTH_MODE,
          'Unsupported security.mode "challenge-response"',
        );
      }
      const issued: ChallengeIssuerResult = this.securityOptions?.issueChallenge
        ? await this.securityOptions.issueChallenge(params.security, params, session.transport)
        : {
            challenge: {
              challengeId: `chg-${randomUUID()}`,
              algorithm: "ed25519",
              nonce: randomUUID(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
            verify: (authParams) => {
              if (!authParams.signature || authParams.signature.length === 0) {
                return null;
              }
              return {
                mode: "challenge-response",
                keyId: requestedSecurity.keyId ?? "default-key",
                principal: {
                  id: requestedSecurity.keyId ?? "agent-key",
                  kind: "agent",
                },
                sessionAuthenticated: true,
              };
            },
          };

      session.protocolVersion = selectedVersion;
      session.pendingAuth = {
        selectedVersion,
        requestedParams: params,
        negotiatedCaps,
        challenge: issued.challenge,
        verify: issued.verify,
      };
      return {
        protocolVersion: selectedVersion,
        serverInfo: { ...this.serverInfo },
        authRequired: true,
        challenge: issued.challenge,
        security: {
          mode: "challenge-response",
          sessionAuthenticated: false,
        },
      };
    }

    let resolvedSecurity: SecurityDescriptor;
    if (this.securityOptions?.authenticate) {
      const authRes = await this.securityOptions.authenticate(
        params.security,
        params,
        session.transport,
      );
      if (!authRes) {
        const code =
          requestedSecurity.mode === "unauthenticated" &&
          !allowedModes.includes("unauthenticated")
            ? AEP_ERROR_CODES.AUTHENTICATION_REQUIRED
            : allowedModes.includes(requestedSecurity.mode)
              ? AEP_ERROR_CODES.AUTHENTICATION_FAILED
              : AEP_ERROR_CODES.UNSUPPORTED_AUTH_MODE;
        throw new AepError(
          code,
          `Authentication rejected for security.mode "${requestedSecurity.mode}"`,
        );
      }
      resolvedSecurity = authRes;
    } else {
      if (
        (requestedSecurity.mode === "bearer" && !requestedSecurity.token) ||
        (requestedSecurity.mode === "api-key" && !requestedSecurity.apiKey)
      ) {
        throw new AepError(
          AEP_ERROR_CODES.AUTHENTICATION_REQUIRED,
          `Missing credentials for security.mode "${requestedSecurity.mode}"`,
        );
      }
      resolvedSecurity = { ...requestedSecurity };
    }

    const { head, descriptor, security } = this.finalizeAuthenticatedSession(
      session,
      params,
      selectedVersion,
      negotiatedCaps,
      resolvedSecurity,
    );

    return {
      protocolVersion: selectedVersion,
      serverInfo: { ...this.serverInfo },
      head,
      session: descriptor,
      security,
    };
  }

  private async handleSessionAuthenticate(
    session: InternalSession,
    params: SessionAuthenticateParams,
  ): Promise<SessionAuthenticateResult> {
    if (!params || typeof params.mode !== "string") {
      throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, "session.authenticate requires mode");
    }

    if (session.pendingAuth) {
      const pending = session.pendingAuth;
      if (params.mode !== "challenge-response") {
        throw new AepError(
          AEP_ERROR_CODES.UNSUPPORTED_AUTH_MODE,
          `Expected challenge-response mode, got "${params.mode}"`,
        );
      }
      if (params.challengeId && params.challengeId !== pending.challenge.challengeId) {
        throw new AepError(
          AEP_ERROR_CODES.AUTHENTICATION_FAILED,
          "Mismatched challengeId in session.authenticate",
        );
      }
      const verified = await pending.verify(params, session.transport);
      if (!verified) {
        throw new AepError(
          AEP_ERROR_CODES.AUTHENTICATION_FAILED,
          "Challenge-response signature verification failed",
        );
      }
      session.pendingAuth = undefined;
      const { head, descriptor, security } = this.finalizeAuthenticatedSession(
        session,
        pending.requestedParams,
        pending.selectedVersion,
        pending.negotiatedCaps,
        verified,
      );
      return {
        authenticated: true,
        head,
        session: descriptor,
        security,
      };
    }

    if (!session.initialized) {
      throw new AepError(
        AEP_ERROR_CODES.NOT_INITIALIZED,
        "session.authenticate invoked before session.initialize",
      );
    }

    const allowedModes = this.securityOptions?.allowedModes ??
      this.serverCapabilities.security.supportedModes ?? [this.serverCapabilities.security.mode];
    if (!allowedModes.includes(params.mode)) {
      throw new AepError(
        AEP_ERROR_CODES.UNSUPPORTED_AUTH_MODE,
        `Unsupported security.mode "${params.mode}"`,
      );
    }

    let updatedSecurity: SecurityDescriptor;
    if (this.securityOptions?.authenticateRefresh) {
      const refreshed = await this.securityOptions.authenticateRefresh(
        params,
        this.toSessionContext(session),
      );
      if (!refreshed) {
        throw new AepError(AEP_ERROR_CODES.AUTHENTICATION_FAILED, "Credential refresh rejected");
      }
      updatedSecurity = refreshed;
    } else {
      if (params.mode === "bearer" && !params.token) {
        throw new AepError(AEP_ERROR_CODES.AUTHENTICATION_FAILED, "Missing bearer token");
      }
      if (params.mode === "api-key" && !params.apiKey) {
        throw new AepError(AEP_ERROR_CODES.AUTHENTICATION_FAILED, "Missing apiKey");
      }
      updatedSecurity = {
        ...session.security,
        mode: params.mode,
        ...(params.token !== undefined ? { token: params.token } : {}),
        ...(params.apiKey !== undefined ? { apiKey: params.apiKey } : {}),
        expiresAt: undefined,
        sessionAuthenticated: true,
      };
    }

    session.security = {
      ...updatedSecurity,
      sessionAuthenticated: true,
    };
    this.syncSessionElevationSecurity(session);
    const head = this.buildSessionHead(session);

    return {
      authenticated: true,
      head,
      session: {
        sessionId: session.sessionId,
        role: session.role,
        policy: session.policy,
        ...(session.resumeToken !== undefined ? { resumeToken: session.resumeToken } : {}),
      },
      security: session.security,
    };
  }

  private async handleSessionResume(
    tempSession: InternalSession,
    params: SessionResumeParams,
  ): Promise<SessionResumeResult> {
    if (
      !params ||
      typeof params.sessionId !== "string" ||
      typeof params.resumeToken !== "string"
    ) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PARAMS,
        "session.resume requires sessionId and resumeToken",
      );
    }

    const target = this.sessions.get(params.sessionId);
    if (!target || !target.initialized || target.closed || target.explicitlyClosed) {
      throw new AepError(
        AEP_ERROR_CODES.SESSION_EXPIRED,
        `Session "${params.sessionId}" not found or expired`,
      );
    }
    if (target.resumeToken !== params.resumeToken) {
      throw new AepError(
        AEP_ERROR_CODES.SESSION_EXPIRED,
        `Invalid resumeToken for session "${params.sessionId}"`,
      );
    }
    const ttlMs = target.capabilities.resumption?.sessionTtlMs ?? 300_000;
    if (target.disconnectedAt !== undefined && Date.now() - target.disconnectedAt > ttlMs) {
      target.explicitlyClosed = true;
      await this.cleanupSession(target, "Resumption TTL expired");
      throw new AepError(
        AEP_ERROR_CODES.SESSION_EXPIRED,
        `Session "${params.sessionId}" resumption TTL expired`,
      );
    }

    const newTransport = tempSession.transport;
    this.sessions.delete(tempSession.sessionId);
    for (const unsub of tempSession.unsubscribers) {
      unsub();
    }
    tempSession.unsubscribers.length = 0;
    tempSession.closed = true;

    target.disconnected = false;
    target.disconnectedAt = undefined;
    target.resumeToken = `res-${randomUUID()}`;
    this.attachSessionTransport(target, newTransport);

    let missedNotifications: NotificationEnvelope[] = [];
    let resyncRequired = false;
    if (params.lastControlSeq !== undefined) {
      const earliestSeq = target.notificationHistory[0]?.seq;
      if (earliestSeq !== undefined && params.lastControlSeq + 1 < earliestSeq) {
        resyncRequired = true;
      } else {
        missedNotifications = target.notificationHistory
          .filter((item) => item.seq > params.lastControlSeq!)
          .map((item) => item.envelope);
      }
    }

    const replayedSubChunks: Array<{ method: string; payload: unknown }> = [];
    const subStatuses = await target.dataPlane.rebindSessionSubscriptions(
      target.sessionId,
      async (method, payload) => {
        replayedSubChunks.push({ method, payload });
      },
      params.subscriptions,
    );

    this.pendingResumes.set(target.sessionId, async () => {
      for (const env of missedNotifications) {
        if (!newTransport.isClosed) {
          await newTransport.send(this.encodeOutboundEnvelope(target, env));
        }
      }
      await target.dataPlane.rebindSessionSubscriptions(
        target.sessionId,
        (method, payload) => this.sendNotification(target, method, payload),
        [],
      );
      for (const item of replayedSubChunks) {
        await this.sendNotification(target, item.method, item.payload);
      }
    });

    return {
      resumed: true,
      sessionId: target.sessionId,
      resumeToken: target.resumeToken,
      currentControlSeq: target.outboundSeq,
      replayedCount: missedNotifications.length,
      ...(resyncRequired ? { resyncRequired: true } : {}),
      head: this.buildSessionHead(target),
      subscriptions: subStatuses,
    };
  }

  private pruneExpiredLeases(): void {
    const now = Date.now();
    for (const [id, lease] of this.leases.entries()) {
      if (lease.expiresAtMs <= now) {
        this.leases.delete(id);
        void this.broadcastNotification("session.leaseUpdated", {
          leaseId: lease.leaseId,
          path: lease.path,
          ...(lease.uid !== undefined ? { uid: lease.uid } : {}),
          status: "expired",
          holderSessionId: lease.holderSessionId,
          ...(lease.holderName !== undefined ? { holderName: lease.holderName } : {}),
        });
      }
    }
  }

  private assertLeaseAllowsWrite(
    session: InternalSession,
    targetPath: Path,
    leaseId?: string,
  ): void {
    this.pruneExpiredLeases();
    for (const lease of this.leases.values()) {
      if (lease.mode !== "exclusive-write") {
        continue;
      }
      if (!isPathWithin(targetPath, lease.path) && !isPathWithin(lease.path, targetPath)) {
        continue;
      }
      if (lease.holderSessionId === session.sessionId) {
        if (leaseId !== undefined && leaseId !== lease.leaseId) {
          throw new AepError(AEP_ERROR_CODES.LEASE_CONFLICT, `Invalid leaseId "${leaseId}"`, {
            leasedPath: lease.path,
            holderSessionId: lease.holderSessionId,
            ...(lease.holderName !== undefined ? { holderName: lease.holderName } : {}),
            expiresAt: lease.expiresAt,
          });
        }
        continue;
      }
      throw new AepError(
        AEP_ERROR_CODES.LEASE_CONFLICT,
        `Operation on "${targetPath}" blocked by exclusive-write lease "${lease.leaseId}" at "${lease.path}"`,
        {
          leasedPath: lease.path,
          holderSessionId: lease.holderSessionId,
          ...(lease.holderName !== undefined ? { holderName: lease.holderName } : {}),
          expiresAt: lease.expiresAt,
        },
      );
    }
  }

  private async handleSessionAcquireLease(
    session: InternalSession,
    params: SessionAcquireLeaseParams,
  ): Promise<SessionAcquireLeaseResult> {
    if (!params || (typeof params.path !== "string" && typeof params.uid !== "string")) {
      throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, "session.acquireLease requires path or uid");
    }
    this.pruneExpiredLeases();

    const resolved = this.resolveTargetPath(session.treeStore, params.path, params.uid, true);
    const mode: LeaseMode = params.mode ?? "exclusive-write";
    const durationMs =
      params.durationMs !== undefined && params.durationMs > 0
        ? params.durationMs
        : DEFAULT_LEASE_DURATION_MS;
    const expiresAtMs = Date.now() + durationMs;
    const expiresAt = new Date(expiresAtMs).toISOString();

    if (params.leaseId) {
      const existing = this.leases.get(params.leaseId);
      if (!existing || existing.holderSessionId !== session.sessionId) {
        throw new AepError(
          AEP_ERROR_CODES.LEASE_CONFLICT,
          `Lease "${params.leaseId}" not held by this session`,
        );
      }
      existing.expiresAtMs = expiresAtMs;
      existing.expiresAt = expiresAt;
      return {
        leaseId: existing.leaseId,
        path: existing.path,
        ...(existing.uid !== undefined ? { uid: existing.uid } : {}),
        mode: existing.mode,
        expiresAt,
      };
    }

    for (const existing of this.leases.values()) {
      if (
        existing.holderSessionId !== session.sessionId &&
        (existing.mode === "exclusive-write" || mode === "exclusive-write") &&
        (isPathWithin(resolved.path, existing.path) || isPathWithin(existing.path, resolved.path))
      ) {
        throw new AepError(
          AEP_ERROR_CODES.LEASE_CONFLICT,
          `Subtree "${resolved.path}" conflicts with active lease "${existing.leaseId}"`,
          {
            leasedPath: existing.path,
            holderSessionId: existing.holderSessionId,
            ...(existing.holderName !== undefined ? { holderName: existing.holderName } : {}),
            expiresAt: existing.expiresAt,
          },
        );
      }
    }

    const leaseId = `lease-${randomUUID()}`;
    const lease: InternalLease = {
      leaseId,
      path: resolved.path,
      ...(resolved.node.uid !== undefined ? { uid: resolved.node.uid } : {}),
      mode,
      holderSessionId: session.sessionId,
      ...(params.holderName !== undefined ? { holderName: params.holderName } : {}),
      expiresAtMs,
      expiresAt,
    };
    this.leases.set(leaseId, lease);

    await this.broadcastNotification("session.leaseUpdated", {
      leaseId,
      path: lease.path,
      ...(lease.uid !== undefined ? { uid: lease.uid } : {}),
      status: "acquired",
      holderSessionId: session.sessionId,
      ...(lease.holderName !== undefined ? { holderName: lease.holderName } : {}),
      expiresAt,
    });

    return {
      leaseId,
      path: lease.path,
      ...(lease.uid !== undefined ? { uid: lease.uid } : {}),
      mode,
      expiresAt,
    };
  }

  private async handleSessionReleaseLease(
    session: InternalSession,
    params: SessionReleaseLeaseParams,
  ): Promise<SessionReleaseLeaseResult> {
    if (!params || typeof params.leaseId !== "string") {
      throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, "session.releaseLease requires leaseId");
    }
    const existing = this.leases.get(params.leaseId);
    if (!existing) {
      throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, `Lease "${params.leaseId}" not found`);
    }
    if (existing.holderSessionId !== session.sessionId) {
      throw new AepError(
        AEP_ERROR_CODES.LEASE_CONFLICT,
        `Lease "${params.leaseId}" is owned by another session`,
      );
    }
    this.leases.delete(params.leaseId);
    await this.broadcastNotification("session.leaseUpdated", {
      leaseId: existing.leaseId,
      path: existing.path,
      ...(existing.uid !== undefined ? { uid: existing.uid } : {}),
      status: "released",
      holderSessionId: session.sessionId,
      ...(existing.holderName !== undefined ? { holderName: existing.holderName } : {}),
    });
    return { released: true, leaseId: params.leaseId };
  }

  private auditElevation(
    session: InternalSession,
    grant: Pick<InternalElevationGrant, "grantId" | "challengeId" | "targetPath" | "level" | "scopes" | "factorType" | "reason">,
    operation: string,
    outcome: ElevationAuditRecord["outcome"],
    reasonOverride?: string,
  ): void {
    this.securityOptions?.elevation?.onAudit?.({
      timestamp: new Date().toISOString(),
      sessionId: session.sessionId,
      ...(session.security.principal?.id !== undefined
        ? { principalId: session.security.principal.id }
        : {}),
      grantId: grant.grantId,
      ...(grant.challengeId !== undefined ? { challengeId: grant.challengeId } : {}),
      targetPath: grant.targetPath,
      operation,
      level: grant.level,
      scopes: [...grant.scopes],
      factorType: grant.factorType,
      reason: reasonOverride ?? grant.reason,
      outcome,
    });
  }

  private computeRequiredElevation(
    treeStore: TreeStore,
    targetPath: Path,
    methodDeclElevation?: ElevationSpec,
  ): ElevationSpec | undefined {
    const segments = parsePath(targetPath);
    let maxLevel: ElevationLevel = "none";
    const scopes = new Set<string>();
    let allowedFactors: AllowedFactor[] | undefined;
    let requireReason = false;

    let current = "";
    for (const seg of segments) {
      current = `${current}/${seg}`;
      const node = treeStore.findNodeInternal(current);
      const spec = node?.properties?.["elevation"] as ElevationSpec | undefined;
      if (spec && typeof spec === "object") {
        if (ELEVATION_RANK[spec.level] > ELEVATION_RANK[maxLevel]) {
          maxLevel = spec.level;
          if (spec.allowedFactors) {
            allowedFactors = [...spec.allowedFactors];
          }
        }
        if (spec.scopes) {
          for (const s of spec.scopes) scopes.add(s);
        }
        if (spec.requireReason) requireReason = true;
      }
    }

    if (methodDeclElevation) {
      if (ELEVATION_RANK[methodDeclElevation.level] >= ELEVATION_RANK[maxLevel]) {
        maxLevel = methodDeclElevation.level;
        if (methodDeclElevation.allowedFactors) {
          allowedFactors = [...methodDeclElevation.allowedFactors];
        }
      }
      if (methodDeclElevation.scopes) {
        for (const s of methodDeclElevation.scopes) scopes.add(s);
      }
      if (methodDeclElevation.requireReason) requireReason = true;
    }

    if (maxLevel === "none") {
      return undefined;
    }
    return {
      level: maxLevel,
      ...(scopes.size > 0 ? { scopes: [...scopes] } : {}),
      ...(allowedFactors !== undefined ? { allowedFactors } : {}),
      ...(requireReason ? { requireReason } : {}),
    };
  }

  private assertElevationAuthorized(
    session: InternalSession,
    targetPath: Path,
    operation: string,
    spec: ElevationSpec | undefined,
    grantId?: string,
  ): void {
    if (!spec || spec.level === "none") {
      return;
    }

    const requiredScopes = spec.scopes ?? [operation];
    const allowedFactors: AllowedFactor[] =
      spec.allowedFactors ??
      this.securityOptions?.elevation?.defaultAllowedFactors ?? ["human-approval", "token"];

    const verifyGrant = (grant: InternalElevationGrant): void => {
      if (grant.status !== "granted") {
        throw new AepError(
          AEP_ERROR_CODES.ELEVATION_DENIED,
          `Elevation grant "${grant.grantId}" has status "${grant.status}"`,
        );
      }
      if (grant.consumed || (grant.expiresAtMs !== undefined && grant.expiresAtMs <= Date.now())) {
        session.activeGrants.delete(grant.grantId);
        this.syncSessionElevationSecurity(session);
        throw new AepError(
          AEP_ERROR_CODES.ELEVATION_EXPIRED,
          `Elevation grant "${grant.grantId}" has expired or been consumed`,
        );
      }
      if (!isPathWithin(targetPath, grant.targetPath)) {
        throw new AepError(
          AEP_ERROR_CODES.ELEVATION_DENIED,
          `Elevation grant "${grant.grantId}" scoped to "${grant.targetPath}" does not cover "${targetPath}"`,
        );
      }
      if (ELEVATION_RANK[grant.level] < ELEVATION_RANK[spec.level]) {
        throw new AepError(
          AEP_ERROR_CODES.ELEVATION_DENIED,
          `Elevation grant "${grant.grantId}" level "${grant.level}" is below required "${spec.level}"`,
        );
      }
      for (const reqScope of requiredScopes) {
        if (grant.scopes.length > 0 && !grant.scopes.includes(reqScope)) {
          throw new AepError(
            AEP_ERROR_CODES.ELEVATION_DENIED,
            `Elevation grant "${grant.grantId}" lacks required scope "${reqScope}"`,
          );
        }
      }
    };

    let matchedGrant: InternalElevationGrant | undefined;
    if (grantId !== undefined) {
      matchedGrant = session.activeGrants.get(grantId);
      if (!matchedGrant) {
        throw new AepError(
          AEP_ERROR_CODES.ELEVATION_EXPIRED,
          `Elevation grant "${grantId}" not found or expired`,
        );
      }
      verifyGrant(matchedGrant);
    } else if (spec.level === "confirm") {
      for (const candidate of session.activeGrants.values()) {
        try {
          verifyGrant(candidate);
          matchedGrant = candidate;
          break;
        } catch {
          // Try next grant
        }
      }
    }

    if (!matchedGrant) {
      const challengeId = `echg-${randomUUID()}`;
      const challenge: ElevationChallengeData = {
        challengeId,
        targetPath,
        operation,
        level: spec.level,
        requiredScopes,
        allowedFactors,
        instructions: `Step-up "${spec.level}" elevation required for ${operation} on ${targetPath}`,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      };
      session.pendingElevationChallenges.set(challengeId, challenge);
      throw new AepError(
        AEP_ERROR_CODES.ELEVATION_REQUIRED,
        challenge.instructions,
        challenge,
      );
    }

    this.auditElevation(session, matchedGrant, operation, "executed");
    if (matchedGrant.singleUse) {
      matchedGrant.consumed = true;
      session.activeGrants.delete(matchedGrant.grantId);
      this.syncSessionElevationSecurity(session);
    }
  }

  private async handleSessionElevate(
    session: InternalSession,
    params: SessionElevateParams,
  ): Promise<SessionElevateResult> {
    if (this.securityOptions?.elevation?.enabled === false || session.capabilities.security.elevation === false) {
      throw new AepError(AEP_ERROR_CODES.ELEVATION_DENIED, "Privilege elevation is disabled");
    }
    if (
      !params ||
      typeof params.level !== "string" ||
      typeof params.reason !== "string" ||
      params.reason.trim().length === 0 ||
      !params.factor ||
      typeof params.factor.type !== "string"
    ) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PARAMS,
        "session.elevate requires level, non-empty reason, and factor",
      );
    }

    const challenge = params.challengeId
      ? session.pendingElevationChallenges.get(params.challengeId)
      : undefined;
    if (params.challengeId && !challenge) {
      throw new AepError(
        AEP_ERROR_CODES.ELEVATION_EXPIRED,
        `Elevation challenge "${params.challengeId}" not found or expired`,
      );
    }
    if (challenge && Date.parse(challenge.expiresAt) <= Date.now()) {
      session.pendingElevationChallenges.delete(challenge.challengeId);
      throw new AepError(
        AEP_ERROR_CODES.ELEVATION_EXPIRED,
        `Elevation challenge "${challenge.challengeId}" expired`,
      );
    }
    if (challenge && !challenge.allowedFactors.includes(params.factor.type)) {
      throw new AepError(
        AEP_ERROR_CODES.ELEVATION_DENIED,
        `Factor "${params.factor.type}" is not permitted for challenge "${challenge.challengeId}"`,
      );
    }

    const targetPath = params.targetPath ?? challenge?.targetPath ?? "/";
    const scopes = params.scopes ?? challenge?.requiredScopes ?? [];
    const singleUse = params.singleUse ?? false;
    const maxDur =
      this.securityOptions?.elevation?.maxDurationMs ?? DEFAULT_ELEVATION_MAX_DURATION_MS;
    const durationMs =
      params.durationMs !== undefined && params.durationMs > 0
        ? Math.min(params.durationMs, maxDur)
        : maxDur;
    const expiresAtMs = Date.now() + durationMs;
    const expiresAt = new Date(expiresAtMs).toISOString();

    let status: "granted" | "pending" | "denied" = "granted";
    let customExpiresAt: string | undefined;
    if (this.securityOptions?.elevation?.evaluate) {
      const evaluated = await this.securityOptions.elevation.evaluate(params, {
        session: this.toSessionContext(session),
        challenge,
      });
      status = evaluated.status;
      customExpiresAt = evaluated.expiresAt;
    } else if (params.factor.type === "human-approval" && !params.factor.proof) {
      status = "pending";
    }

    if (status === "denied") {
      const deniedGrant: InternalElevationGrant = {
        grantId: `gr-${randomUUID()}`,
        ...(params.challengeId !== undefined ? { challengeId: params.challengeId } : {}),
        status: "denied",
        level: params.level,
        targetPath,
        scopes,
        singleUse,
        factorType: params.factor.type,
        reason: params.reason,
      };
      this.auditElevation(session, deniedGrant, "session.elevate", "denied");
      throw new AepError(AEP_ERROR_CODES.ELEVATION_DENIED, "Elevation request denied");
    }

    const grantId = `gr-${randomUUID()}`;
    const finalExpiresAt = customExpiresAt ?? expiresAt;
    const grant: InternalElevationGrant = {
      grantId,
      ...(params.challengeId !== undefined ? { challengeId: params.challengeId } : {}),
      status,
      level: params.level,
      targetPath,
      scopes: [...scopes],
      singleUse,
      expiresAtMs: Date.parse(finalExpiresAt),
      expiresAt: finalExpiresAt,
      factorType: params.factor.type,
      reason: params.reason,
    };
    session.activeGrants.set(grantId, grant);
    if (params.challengeId) {
      session.pendingElevationChallenges.delete(params.challengeId);
    }
    this.syncSessionElevationSecurity(session);
    this.auditElevation(session, grant, "session.elevate", status);

    return {
      grantId,
      status,
      level: grant.level,
      targetPath: grant.targetPath,
      scopes: [...grant.scopes],
      singleUse,
      expiresAt: finalExpiresAt,
    };
  }

  private async handleSessionDropElevation(
    session: InternalSession,
    params: SessionDropElevationParams | undefined,
  ): Promise<SessionDropElevationResult> {
    const dropped: string[] = [];
    if (params?.grantId) {
      const existing = session.activeGrants.get(params.grantId);
      if (existing) {
        session.activeGrants.delete(params.grantId);
        dropped.push(params.grantId);
        this.auditElevation(session, existing, "session.dropElevation", "dropped");
      }
    } else {
      for (const [id, grant] of session.activeGrants.entries()) {
        session.activeGrants.delete(id);
        dropped.push(id);
        this.auditElevation(session, grant, "session.dropElevation", "dropped");
      }
    }
    this.syncSessionElevationSecurity(session);
    return { dropped };
  }

  private resolveTargetPath(
    treeStore: TreeStore,
    path?: Path,
    uid?: string,
    followMoves?: boolean,
  ): { path: Path; node: AepNode } {
    const shouldFollowMoves = uid !== undefined ? (followMoves ?? true) : (followMoves ?? false);
    if (uid !== undefined) {
      if (typeof uid !== "string" || uid.length === 0) {
        throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, "uid must be a non-empty string");
      }
      const found = treeStore.findNodeByUidInternal(uid);
      if (!found) {
        throw new AepError(AEP_ERROR_CODES.NODE_NOT_FOUND, `Node with uid "${uid}" not found`);
      }
      if (path !== undefined && path !== found.path && !shouldFollowMoves) {
        throw new AepError(
          AEP_ERROR_CODES.NODE_MOVED,
          `Node "${path}" moved to "${found.path}"`,
          { fromPath: path, toPath: found.path, uid },
        );
      }
      return found;
    }

    if (typeof path !== "string" || path.length === 0) {
      throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, "Target path or uid is required");
    }
    if (path === "/") {
      throw new AepError(AEP_ERROR_CODES.INVALID_PATH, 'Target path cannot be root "/"');
    }
    parsePath(path);

    const direct = treeStore.findNodeInternal(path);
    if (direct) {
      return { path, node: direct };
    }

    const moved = treeStore.resolveMove(path);
    if (moved) {
      if (shouldFollowMoves) {
        const relocated = treeStore.findNodeInternal(moved.toPath);
        if (relocated) {
          return { path: moved.toPath, node: relocated };
        }
      }
      throw new AepError(
        AEP_ERROR_CODES.NODE_MOVED,
        `Node at "${path}" moved to "${moved.toPath}"`,
        moved,
      );
    }

    throw new AepError(AEP_ERROR_CODES.NODE_NOT_FOUND, `Node not found at path "${path}"`);
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
    if (!params || (typeof params.path !== "string" && typeof params.uid !== "string")) {
      throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, "node.get requires path or uid");
    }
    if (params.path === "/") {
      throw new AepError(AEP_ERROR_CODES.INVALID_PATH, 'node.get cannot target root "/"');
    }

    if (params.path && session.treeStore === this.treeStore) {
      const mount = this.mountManager.findMountForPath(params.path);
      if (mount) {
        const node = await this.mountManager.getNode(params.path, params.maxDepth);
        return { path: params.path, resolvedPath: params.path, node };
      }
    }

    const { path: resolvedPath } = this.resolveTargetPath(
      session.treeStore,
      params.path,
      params.uid,
      params.followMoves,
    );
    const elevSpec = this.computeRequiredElevation(session.treeStore, resolvedPath);
    this.assertElevationAuthorized(session, resolvedPath, "node.get", elevSpec, params.grantId);
    const node = session.treeStore.getNode(resolvedPath, params.maxDepth);
    return {
      path: params.path ?? resolvedPath,
      resolvedPath,
      node,
    };
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
    if (!params || (typeof params.path !== "string" && typeof params.uid !== "string")) {
      throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, "node.loadChildren requires path or uid");
    }
    if (params.path === "/") {
      throw new AepError(AEP_ERROR_CODES.INVALID_PATH, 'node.loadChildren cannot target root "/"');
    }

    if (params.path) {
      parsePath(params.path);
      if (session.treeStore === this.treeStore) {
        const mount = this.mountManager.findMountForPath(params.path);
        if (mount) {
          return await this.mountManager.loadChildren(mount, { ...params, path: params.path });
        }
      }
    }

    const { path: resolvedPath, node } = this.resolveTargetPath(
      session.treeStore,
      params.path,
      params.uid,
      params.followMoves,
    );
    if (node.kind === "channel") {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PARAMS,
        `Channel node "${resolvedPath}" is a leaf and cannot load children`,
      );
    }

    const elevSpec = this.computeRequiredElevation(session.treeStore, resolvedPath);
    this.assertElevationAuthorized(
      session,
      resolvedPath,
      "node.loadChildren",
      elevSpec,
      params.grantId,
    );

    const loader = this.childrenLoaders.get(resolvedPath) ?? this.fallbackChildrenLoader;
    if (loader) {
      const loaded = await loader(
        {
          path: resolvedPath,
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
        validateNode(cloned, node.kind, new Set([node]), resolvedPath, node.type);
        validateNodeCapabilities(
          cloned,
          session.capabilities,
          `${resolvedPath}/${cloned.id}`,
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
        path: params.path ?? resolvedPath,
        resolvedPath,
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
      path: params.path ?? resolvedPath,
      resolvedPath,
      children: page,
      hasMore,
      ...(hasMore ? { nextCursor: String(nextOffset) } : {}),
    };
  }

  private async handleNodeInvoke(session: InternalSession, params: NodeInvokeParams) {
    if (
      !params ||
      (typeof params.path !== "string" && typeof params.uid !== "string") ||
      typeof params.method !== "string"
    ) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PARAMS,
        "node.invoke requires (path or uid) and method",
      );
    }
    if (params.path === "/") {
      throw new AepError(AEP_ERROR_CODES.INVALID_PATH, 'node.invoke cannot target root "/"');
    }
    if (!isValidNamespacedIdent(params.method)) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PARAMS,
        `Invalid method name "${params.method}"`,
      );
    }

    const sessionCtx = this.toSessionContext(session);

    if (params.path && session.treeStore === this.treeStore) {
      parsePath(params.path);
      const mount = this.mountManager.findMountForPath(params.path);
      if (mount) {
        this.assertLeaseAllowsWrite(session, params.path, params.leaseId);
        const localKey = `${params.path}::${params.method}`;
        const isRootMountAnchor = params.path === mount.anchorPath && mount.sourcePath === "/";
        if (!(isRootMountAnchor && this.methodHandlers.has(localKey))) {
          return await this.mountManager.invokeMounted(
            mount,
            params.path,
            params.method,
            params.params,
            sessionCtx,
            {
              expectedRevision: params.expectedRevision,
              leaseId: params.leaseId,
              grantId: params.grantId,
            },
          );
        }
      }
    }

    const { path: resolvedPath, node } = this.resolveTargetPath(
      session.treeStore,
      params.path,
      params.uid,
      params.followMoves,
    );

    const decl = node.methods?.find((m) => m.name === params.method);
    const sideEffects = decl?.sideEffects ?? "write";
    const specificHandler = this.methodHandlers.get(`${resolvedPath}::${params.method}`);

    if (!decl && !specificHandler && !this.fallbackInvokeHandler) {
      throw new AepError(
        AEP_ERROR_CODES.METHOD_NOT_FOUND,
        `Method "${params.method}" not found on node "${resolvedPath}"`,
      );
    }

    if (session.role === "observer" && sideEffects === "write") {
      throw new AepError(
        AEP_ERROR_CODES.READ_ONLY_SESSION,
        `Observer session cannot invoke write method "${params.method}" on "${resolvedPath}"`,
      );
    }

    if (sideEffects === "write") {
      this.assertLeaseAllowsWrite(session, resolvedPath, params.leaseId);
    }

    if (
      params.expectedRevision !== undefined &&
      node.revision !== undefined &&
      params.expectedRevision !== node.revision
    ) {
      throw new AepError(
        AEP_ERROR_CODES.REVISION_CONFLICT,
        `Revision conflict on "${resolvedPath}": expected ${params.expectedRevision}, actual ${node.revision}`,
        {
          path: resolvedPath,
          expectedRevision: params.expectedRevision,
          actualRevision: node.revision,
        },
      );
    }

    const elevSpec = this.computeRequiredElevation(session.treeStore, resolvedPath, decl?.elevation);
    this.assertElevationAuthorized(
      session,
      resolvedPath,
      `node.invoke:${params.method}`,
      elevSpec,
      params.grantId,
    );

    const handler = specificHandler ?? this.fallbackInvokeHandler;
    if (!handler) {
      throw new AepError(
        AEP_ERROR_CODES.METHOD_NOT_FOUND,
        `No handler registered for method "${params.method}" on "${resolvedPath}"`,
      );
    }

    const isIsolated = session.treeStore !== this.treeStore;
    const ctx: MethodHandlerContext = {
      path: resolvedPath,
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
    const updatedNode = session.treeStore.findNodeInternal(resolvedPath);
    return {
      path: params.path ?? resolvedPath,
      ...(params.uid !== undefined || resolvedPath !== params.path ? { resolvedPath } : {}),
      method: params.method,
      ...(updatedNode?.revision !== undefined ? { revision: updatedNode.revision } : {}),
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

  private async handleDataRender(
    session: InternalSession,
    params: DataRenderParams,
  ): Promise<DataRenderResult> {
    if (!params || (typeof params.path !== "string" && typeof params.uid !== "string") || typeof params.mode !== "string") {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PARAMS,
        "data.render requires (path or uid) and mode",
      );
    }
    const serverModes = session.capabilities.rendering?.serverModes ?? [];
    if (!serverModes.includes(params.mode)) {
      throw new AepError(
        AEP_ERROR_CODES.UNSUPPORTED_CAPABILITY,
        `Render mode "${params.mode}" is outside negotiated rendering.serverModes`,
      );
    }
    if (params.path === "/") {
      throw new AepError(AEP_ERROR_CODES.INVALID_PATH, 'data.render cannot target root "/"');
    }

    if (params.path && session.treeStore === this.treeStore) {
      parsePath(params.path);
      const mount = this.mountManager.findMountForPath(params.path);
      if (mount) {
        return await this.mountManager.renderMounted(mount, params.path, params);
      }
    }

    const { path: resolvedPath, node } = this.resolveTargetPath(
      session.treeStore,
      params.path,
      params.uid,
      params.followMoves,
    );

    if (
      node.kind === "ou" ||
      node.kind === "api" ||
      node.kind === "endpoint" ||
      node.kind === "channel"
    ) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PARAMS,
        `data.render cannot target non-visual node kind "${node.kind}" at "${resolvedPath}"`,
      );
    }

    const elevSpec = this.computeRequiredElevation(session.treeStore, resolvedPath);
    this.assertElevationAuthorized(session, resolvedPath, "data.render", elevSpec, params.grantId);

    const handler = this.renderHandlers.get(resolvedPath) ?? this.fallbackRenderHandler;
    if (handler) {
      const rendered = await handler(
        {
          path: resolvedPath,
          node: cloneNode(node),
          mode: params.mode,
          params: params.params,
        },
        this.toSessionContext(session),
      );
      return {
        path: params.path ?? resolvedPath,
        resolvedPath,
        mode: params.mode,
        mediaType: rendered.mediaType,
        ...(rendered.reference !== undefined ? { reference: rendered.reference } : {}),
        data: rendered.data,
        ...(rendered.pathMap !== undefined ? { pathMap: rendered.pathMap } : {}),
      };
    }

    if (params.mode === "renderMinimal") {
      const synthesized = synthesizeRenderMinimal(node, resolvedPath, params.params);
      return {
        ...synthesized,
        path: params.path ?? resolvedPath,
        resolvedPath,
      };
    }

    throw new AepError(
      AEP_ERROR_CODES.UNSUPPORTED_CAPABILITY,
      `No server renderer registered for mode "${params.mode}" at "${resolvedPath}"`,
    );
  }

  private async handleChannelOpen(session: InternalSession, params: ChannelOpenParams) {
    if (!params || (params.path === undefined && params.refId === undefined && params.uid === undefined)) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PARAMS,
        "channel.open requires at least one of path, uid, or refId",
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
        if (mountTarget.downstreamPath && params.path) {
          this.assertLeaseAllowsWrite(session, params.path, params.leaseId);
        }
        return await this.mountManager.openChannel(
          mountTarget,
          params,
          this.toSessionContext(session),
          (method, payload) => this.sendNotification(session, method, payload),
        );
      }
    }

    const { path: resolvedPath, channel } = session.dataPlane.resolveChannelTarget(
      params.path,
      params.refId,
      params.uid,
      params.followMoves,
    );
    if (channel.direction === "act") {
      this.assertLeaseAllowsWrite(session, resolvedPath, params.leaseId);
    }
    const elevSpec = this.computeRequiredElevation(session.treeStore, resolvedPath);
    this.assertElevationAuthorized(session, resolvedPath, "channel.open", elevSpec, params.grantId);

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
      const proxyMeta = this.mountManager.getProxySubscription(params.subscriptionId);
      if (proxyMeta?.path) {
        this.assertLeaseAllowsWrite(session, proxyMeta.path, params.leaseId);
      }
      return await this.mountManager.sendChannel(params, this.toSessionContext(session));
    }
    if (params && typeof params.subscriptionId === "string") {
      const subMeta = session.dataPlane.getSubscription(params.subscriptionId);
      if (subMeta) {
        this.assertLeaseAllowsWrite(session, subMeta.path, params.leaseId);
      }
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
    if (!params || (params.path === undefined && params.refId === undefined && params.uid === undefined)) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PARAMS,
        "channel.sample requires at least one of path, uid, or refId",
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

    for (const [leaseId, lease] of this.leases.entries()) {
      if (lease.holderSessionId === session.sessionId) {
        this.leases.delete(leaseId);
        void this.broadcastNotification("session.leaseUpdated", {
          leaseId,
          path: lease.path,
          ...(lease.uid !== undefined ? { uid: lease.uid } : {}),
          status: "released",
          holderSessionId: session.sessionId,
          ...(lease.holderName !== undefined ? { holderName: lease.holderName } : {}),
        });
      }
    }
    session.activeGrants.clear();
    session.pendingElevationChallenges.clear();

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
