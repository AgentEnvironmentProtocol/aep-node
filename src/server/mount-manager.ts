import { randomUUID } from "node:crypto";
import type { AepClient } from "../client/client.js";
import type { ClientChannelSubscription } from "../client/subscription.js";
import { AEP_ERROR_CODES, AepError } from "../core/errors.js";
import {
  isPathWithin,
  isValidPath,
  parsePath,
  rebasePath,
  splitParentPath,
} from "../core/path.js";
import {
  rewriteNodeForUpstream,
  rewriteValueRefsForUpstream,
  toUpstreamRefId,
  parseUpstreamRefId,
} from "../core/rewriting.js";
import { cloneNode, paginateMatches, querySubtree } from "../core/tree-utils.js";
import {
  HEAD_KEYS,
  META_KEYS,
  type AepNode,
  type AepValue,
  type BodyRoot,
  type CapabilitiesObject,
  type ChannelCloseResult,
  type ChannelNode,
  type ChannelOpenParams,
  type ChannelOpenResult,
  type ChannelSampleParams,
  type ChannelSampleResult,
  type ChannelSeekParams,
  type ChannelSeekResult,
  type ChannelSendParams,
  type ChannelSendResult,
  type EventDecl,
  type GetBinaryParams,
  type GetBinaryResult,
  type MetaMap,
  type MethodDecl,
  type NodeKind,
  type NodeLoadChildrenParams,
  type NodeLoadChildrenResult,
  type NodeOrBodyRoot,
  type NodeState,
  type Path,
  type PropertyMap,
  type TreeQueryMatch,
  type TreeQueryParams,
  type TreeQueryResult,
} from "../core/types.js";
import {
  validateMountContainment,
  validateNodeCapabilities,
} from "../core/validation.js";
import type { ServerSessionContext } from "./data-plane.js";
import type { TreeStore } from "./tree-store.js";

export interface ServerMountOptions {
  anchorPath: Path;
  client: AepClient;
  sourcePath?: Path;
  anchorNode?: {
    kind: Exclude<NodeKind, "channel">;
    type?: string;
    properties?: PropertyMap;
    state?: NodeState;
    meta?: MetaMap;
    methods?: MethodDecl[];
    events?: EventDecl[];
  };
  lazy?: boolean;
  timeoutMs?: number;
  mountKey?: string;
  hopOrigins?: string[];
}

export interface ServerMountHostCallbacks {
  getCapabilities(): CapabilitiesObject;
  getOriginId(): string;
  broadcastNotification(method: string, params: unknown): Promise<void>;
  onMountHeadsChanged(): Promise<void>;
}

interface MountedProviderEntry {
  mountKey: string;
  anchorPath: Path;
  sourcePath: Path;
  client: AepClient;
  createdAnchor: boolean;
  lazy: boolean;
  hydrated: boolean;
  timeoutMs: number;
  downstreamOrigins: string[];
  vocabularies: string[];
  unsubscribers: Array<() => void>;
}

interface ProxySubscription {
  proxySubscriptionId: string;
  mount: MountedProviderEntry;
  downstreamSub: ClientChannelSubscription;
  upstreamSessionId: string;
  upstreamPath?: Path;
  emit: (method: string, params: unknown) => Promise<void>;
  sequence: number;
  ready: boolean;
  pendingNotifications: Array<{ method: string; payload: unknown }>;
  unsubscribers: Array<() => void>;
  closed: boolean;
}

const DEFAULT_MOUNT_TIMEOUT_MS = 10_000;

function isDisconnectError(err: unknown): boolean {
  if (err instanceof AepError) {
    return (
      err.code === AEP_ERROR_CODES.MOUNT_UNAVAILABLE ||
      err.code === AEP_ERROR_CODES.MOUNT_TIMEOUT
    );
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes("closed") ||
      msg.includes("not connected") ||
      msg.includes("not initialized") ||
      msg.includes("destroyed") ||
      msg.includes("disconnected")
    );
  }
  return false;
}

async function withMountTimeout<T>(
  mount: MountedProviderEntry | { timeoutMs: number; anchorPath: Path },
  fn: () => Promise<T>,
): Promise<T> {
  const timeoutMs = mount.timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new AepError(
              AEP_ERROR_CODES.MOUNT_TIMEOUT,
              `Mounted provider at "${mount.anchorPath}" timed out after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    if (err instanceof AepError) {
      throw err;
    }
    if (isDisconnectError(err)) {
      throw new AepError(
        AEP_ERROR_CODES.MOUNT_UNAVAILABLE,
        `Mounted provider at "${mount.anchorPath}" is unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    throw AepError.from(err, AEP_ERROR_CODES.MOUNT_UNAVAILABLE);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export class ServerMountManager {
  private readonly treeStore: TreeStore;
  private readonly host: ServerMountHostCallbacks;
  private readonly mountsByAnchor = new Map<Path, MountedProviderEntry>();
  private readonly mountsByKey = new Map<string, MountedProviderEntry>();
  private readonly proxySubscriptions = new Map<string, ProxySubscription>();

  constructor(treeStore: TreeStore, host: ServerMountHostCallbacks) {
    this.treeStore = treeStore;
    this.host = host;
  }

  hasMounts(): boolean {
    return this.mountsByAnchor.size > 0;
  }

  getMountedOriginIds(): string[] {
    const set = new Set<string>();
    for (const mount of this.mountsByAnchor.values()) {
      for (const origin of mount.downstreamOrigins) {
        set.add(origin);
      }
    }
    return [...set];
  }

  getMountedVocabularies(): string[] {
    const set = new Set<string>();
    for (const mount of this.mountsByAnchor.values()) {
      for (const vocab of mount.vocabularies) {
        set.add(vocab);
      }
    }
    return [...set];
  }

  findMountForPath(path: Path): MountedProviderEntry | undefined {
    for (const mount of this.mountsByAnchor.values()) {
      if (isPathWithin(path, mount.anchorPath)) {
        return mount;
      }
    }
    return undefined;
  }

  isMountedRoot(path: Path): boolean {
    return this.mountsByAnchor.has(path);
  }

  async mount(options: ServerMountOptions): Promise<{ anchorPath: Path; mountKey: string }> {
    const capabilities = this.host.getCapabilities();
    if (!capabilities.passthrough?.enabled) {
      throw new AepError(
        AEP_ERROR_CODES.UNSUPPORTED_CAPABILITY,
        "Passthrough mounting is disabled on this server",
      );
    }
    if (!isValidPath(options.anchorPath) || options.anchorPath === "/") {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PATH,
        `Mount anchorPath must be a valid non-root path: "${options.anchorPath}"`,
      );
    }

    const sourcePath: Path = options.sourcePath ?? "/";
    if (!isValidPath(sourcePath)) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PATH,
        `Mount sourcePath is invalid: "${sourcePath}"`,
      );
    }

    for (const existingAnchor of this.mountsByAnchor.keys()) {
      if (
        isPathWithin(options.anchorPath, existingAnchor) ||
        isPathWithin(existingAnchor, options.anchorPath)
      ) {
        throw new AepError(
          AEP_ERROR_CODES.INVALID_MESSAGE,
          `Mount anchor "${options.anchorPath}" conflicts with existing mount "${existingAnchor}"`,
        );
      }
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_MOUNT_TIMEOUT_MS;
    const mountKey = options.mountKey ?? `m-${this.mountsByKey.size + 1}-${randomUUID().slice(0, 8)}`;
    if (this.mountsByKey.has(mountKey)) {
      throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, `Duplicate mountKey "${mountKey}"`);
    }

    const client = options.client;
    if (!client.isInitialized) {
      await withMountTimeout({ timeoutMs, anchorPath: options.anchorPath }, () =>
        client.initialize(),
      );
    }

    const downstreamHead = client.head;
    const hostOriginId = this.host.getOriginId();
    const rawOriginId = downstreamHead[HEAD_KEYS.ORIGIN_ID];
    const downstreamOrigin = typeof rawOriginId === "string" ? rawOriginId : undefined;
    const downstreamMountOriginsRaw = downstreamHead[HEAD_KEYS.MOUNT_ORIGINS];
    const downstreamMountOrigins: string[] = Array.isArray(downstreamMountOriginsRaw)
      ? downstreamMountOriginsRaw.filter((v): v is string => typeof v === "string")
      : [];

    const combinedOrigins = new Set<string>(options.hopOrigins ?? []);
    for (const origin of downstreamMountOrigins) {
      combinedOrigins.add(origin);
    }
    if (downstreamOrigin) {
      combinedOrigins.add(downstreamOrigin);
    }

    if (combinedOrigins.has(hostOriginId)) {
      throw new AepError(
        AEP_ERROR_CODES.MOUNT_CYCLE,
        `Cyclic passthrough mount detected for origin "${hostOriginId}" at "${options.anchorPath}"`,
      );
    }

    const existingAnchor = this.treeStore.findNodeInternal(options.anchorPath);
    let anchorKind: NodeKind;
    let anchorType: string | undefined;
    let anchorParentKind: NodeKind | "body";
    let anchorParentType: string | undefined;
    const { parentPath, id: anchorId } = splitParentPath(options.anchorPath);

    if (parentPath === "/") {
      anchorParentKind = "body";
    } else {
      const parentNode = this.treeStore.findNodeInternal(parentPath);
      if (!parentNode) {
        throw new AepError(
          AEP_ERROR_CODES.NODE_NOT_FOUND,
          `Mount parent path "${parentPath}" not found`,
        );
      }
      anchorParentKind = parentNode.kind;
      anchorParentType = parentNode.type;
    }

    if (existingAnchor) {
      anchorKind = existingAnchor.kind;
      anchorType = existingAnchor.type;
    } else {
      anchorKind = options.anchorNode?.kind ?? "ou";
      anchorType = options.anchorNode?.type;
    }

    if (
      options.lazy &&
      (anchorKind === "channel" || (options.anchorNode?.kind as string | undefined) === "channel")
    ) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `Channel mount anchor "${options.anchorPath}" cannot be lazy`,
      );
    }

    if (
      sourcePath === "/" &&
      anchorKind !== "ou" &&
      anchorKind !== "interface" &&
      anchorKind !== "component"
    ) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `Unsupported anchor node kind "${String(anchorKind)}" at "${options.anchorPath}"`,
      );
    }

    let initialSubtree: NodeOrBodyRoot | undefined;
    if (!options.lazy) {
      const treeRes = await withMountTimeout({ timeoutMs, anchorPath: options.anchorPath }, () =>
        client.getTree({ path: sourcePath, includeHead: false }),
      );
      initialSubtree = treeRes.node;

      if (sourcePath === "/") {
        validateMountContainment(anchorKind, initialSubtree, anchorType);
        if (initialSubtree.kind === "body") {
          for (const child of initialSubtree.children) {
            validateNodeCapabilities(child, capabilities, `${options.anchorPath}/${child.id}`);
          }
        }
      } else {
        validateMountContainment(anchorParentKind, initialSubtree, anchorParentType);
        if (initialSubtree.kind !== "body") {
          validateNodeCapabilities(initialSubtree, capabilities, options.anchorPath);
        }
      }
    }

    const vocabRaw = downstreamHead[HEAD_KEYS.VOCABULARIES];
    const vocabularies: string[] = Array.isArray(vocabRaw)
      ? vocabRaw.filter((v): v is string => typeof v === "string")
      : [];

    const mountMetaValue: AepValue = {
      providerId: mountKey,
      status: "connected",
      ...(client.serverInfo ? { serverInfo: client.serverInfo as unknown as AepValue } : {}),
    };

    let createdAnchor = false;
    if (!existingAnchor) {
      if (sourcePath === "/") {
        const baseKind = options.anchorNode?.kind ?? "ou";
        if (baseKind !== "ou" && baseKind !== "interface" && baseKind !== "component") {
          throw new AepError(
            AEP_ERROR_CODES.INVALID_MESSAGE,
            `Unsupported anchor node kind "${String(baseKind)}" at "${options.anchorPath}"`,
          );
        }
        const newAnchor = {
          id: anchorId,
          kind: baseKind,
          ...(options.anchorNode?.type !== undefined ? { type: options.anchorNode.type } : {}),
          ...(options.anchorNode?.properties !== undefined
            ? { properties: structuredClone(options.anchorNode.properties) }
            : {}),
          ...(options.anchorNode?.state !== undefined
            ? { state: structuredClone(options.anchorNode.state) }
            : {}),
          meta: {
            ...(options.anchorNode?.meta ?? {}),
            [META_KEYS.MOUNT]: mountMetaValue,
          },
          ...(options.anchorNode?.methods !== undefined
            ? { methods: structuredClone(options.anchorNode.methods) }
            : {}),
          ...(options.anchorNode?.events !== undefined
            ? { events: structuredClone(options.anchorNode.events) }
            : {}),
          ...(options.lazy ? { hasChildren: true } : {}),
        } as AepNode;
        this.treeStore.addNode(parentPath, newAnchor, undefined, capabilities);
        createdAnchor = true;
      } else if (!options.lazy && initialSubtree && initialSubtree.kind !== "body") {
        const mergedType = options.anchorNode?.type ?? initialSubtree.type;
        const mergedProperties =
          initialSubtree.properties || options.anchorNode?.properties
            ? {
                ...(initialSubtree.properties ? structuredClone(initialSubtree.properties) : {}),
                ...(options.anchorNode?.properties
                  ? structuredClone(options.anchorNode.properties)
                  : {}),
              }
            : undefined;
        const mergedState =
          initialSubtree.state || options.anchorNode?.state
            ? {
                ...(initialSubtree.state ? structuredClone(initialSubtree.state) : {}),
                ...(options.anchorNode?.state ? structuredClone(options.anchorNode.state) : {}),
              }
            : undefined;
        const mergedMethods = options.anchorNode?.methods ?? initialSubtree.methods;
        const mergedEvents = options.anchorNode?.events ?? initialSubtree.events;
        const mergedMeta: MetaMap = {
          ...(initialSubtree.meta ? structuredClone(initialSubtree.meta) : {}),
          ...(options.anchorNode?.meta ? structuredClone(options.anchorNode.meta) : {}),
          [META_KEYS.MOUNT]: mountMetaValue,
        };

        const newAnchor: AepNode =
          initialSubtree.kind === "channel"
            ? {
                id: anchorId,
                kind: "channel",
                ...(mergedType !== undefined ? { type: mergedType } : {}),
                ...(mergedProperties !== undefined ? { properties: mergedProperties } : {}),
                ...(mergedState !== undefined ? { state: mergedState } : {}),
                ...(mergedMethods !== undefined ? { methods: structuredClone(mergedMethods) } : {}),
                ...(mergedEvents !== undefined ? { events: structuredClone(mergedEvents) } : {}),
                meta: mergedMeta,
                mediaType: initialSubtree.mediaType,
                direction: initialSubtree.direction,
                deliveryMode: initialSubtree.deliveryMode,
                ...(initialSubtree.streamRef !== undefined
                  ? { streamRef: structuredClone(initialSubtree.streamRef) }
                  : {}),
              }
            : ({
                id: anchorId,
                kind: initialSubtree.kind,
                ...(mergedType !== undefined ? { type: mergedType } : {}),
                ...(mergedProperties !== undefined ? { properties: mergedProperties } : {}),
                ...(mergedState !== undefined ? { state: mergedState } : {}),
                ...(mergedMethods !== undefined ? { methods: structuredClone(mergedMethods) } : {}),
                ...(mergedEvents !== undefined ? { events: structuredClone(mergedEvents) } : {}),
                meta: mergedMeta,
              } as AepNode);
        this.treeStore.addNode(parentPath, newAnchor, undefined, capabilities);
        createdAnchor = true;
      } else {
        const baseKind = options.anchorNode?.kind ?? "ou";
        if ((baseKind as string) === "channel") {
          throw new AepError(
            AEP_ERROR_CODES.INVALID_MESSAGE,
            `Channel anchor "${options.anchorPath}" cannot be mounted lazily`,
          );
        }
        const newAnchor = {
          id: anchorId,
          kind: baseKind,
          ...(options.anchorNode?.type !== undefined ? { type: options.anchorNode.type } : {}),
          ...(options.anchorNode?.properties !== undefined
            ? { properties: structuredClone(options.anchorNode.properties) }
            : {}),
          ...(options.anchorNode?.state !== undefined
            ? { state: structuredClone(options.anchorNode.state) }
            : {}),
          meta: {
            ...(options.anchorNode?.meta ?? {}),
            [META_KEYS.MOUNT]: mountMetaValue,
          },
          ...(options.anchorNode?.methods !== undefined
            ? { methods: structuredClone(options.anchorNode.methods) }
            : {}),
          ...(options.anchorNode?.events !== undefined
            ? { events: structuredClone(options.anchorNode.events) }
            : {}),
          ...(options.lazy ? { hasChildren: true } : {}),
        } as AepNode;
        this.treeStore.addNode(parentPath, newAnchor, undefined, capabilities);
        createdAnchor = true;
      }
    } else {
      this.treeStore.updateNode(
        options.anchorPath,
        (prev) => ({
          ...prev,
          meta: {
            ...(prev.meta ?? {}),
            [META_KEYS.MOUNT]: mountMetaValue,
          },
          ...(options.lazy && prev.kind !== "channel" ? { hasChildren: true } : {}),
        }),
        capabilities,
      );
    }

    const entry: MountedProviderEntry = {
      mountKey,
      anchorPath: options.anchorPath,
      sourcePath,
      client,
      createdAnchor,
      lazy: Boolean(options.lazy),
      hydrated: !options.lazy,
      timeoutMs,
      downstreamOrigins: [...combinedOrigins],
      vocabularies,
      unsubscribers: [],
    };

    this.attachDownstreamListeners(entry);
    this.mountsByAnchor.set(options.anchorPath, entry);
    this.mountsByKey.set(mountKey, entry);

    await this.host.onMountHeadsChanged();

    if (createdAnchor) {
      const hydratedAnchor = await this.getNodeOrTreeFromMount(entry, options.anchorPath);
      await this.host.broadcastNotification("node.added", {
        parentPath,
        node: hydratedAnchor,
      });
    } else if (initialSubtree && initialSubtree.kind === "body") {
      for (const child of initialSubtree.children) {
        const rewritten = rewriteNodeForUpstream(child, "/", options.anchorPath, entry.mountKey);
        await this.host.broadcastNotification("node.added", {
          parentPath: options.anchorPath,
          node: rewritten,
        });
      }
    }

    return { anchorPath: options.anchorPath, mountKey };
  }

  async unmount(anchorPath: Path): Promise<void> {
    const entry = this.mountsByAnchor.get(anchorPath);
    if (!entry) {
      throw new AepError(AEP_ERROR_CODES.NODE_NOT_FOUND, `No mount found at "${anchorPath}"`);
    }

    this.mountsByAnchor.delete(anchorPath);
    this.mountsByKey.delete(entry.mountKey);

    for (const unsub of entry.unsubscribers) {
      unsub();
    }
    entry.unsubscribers.length = 0;

    for (const sub of [...this.proxySubscriptions.values()]) {
      if (sub.mount === entry) {
        await this.closeProxySubscription(sub, "Mount unmounted", true);
      }
    }

    if (entry.createdAnchor) {
      if (this.treeStore.findNodeInternal(anchorPath)) {
        this.treeStore.removeNode(anchorPath);
        await this.host.broadcastNotification("node.removed", { path: anchorPath });
      }
    } else if (this.treeStore.findNodeInternal(anchorPath)) {
      const updated = this.treeStore.updateNode(anchorPath, (prev) => {
        const nextMeta = prev.meta ? { ...prev.meta } : undefined;
        if (nextMeta) {
          delete nextMeta[META_KEYS.MOUNT];
        }
        return {
          ...prev,
          ...(nextMeta && Object.keys(nextMeta).length > 0 ? { meta: nextMeta } : { meta: undefined }),
        };
      });
      await this.host.broadcastNotification("node.updated", { path: anchorPath, node: updated });
    }

    await this.host.onMountHeadsChanged();
  }

  async closeAll(): Promise<void> {
    for (const entry of this.mountsByAnchor.values()) {
      for (const unsub of entry.unsubscribers) {
        unsub();
      }
      entry.unsubscribers.length = 0;
    }
    this.mountsByAnchor.clear();
    this.mountsByKey.clear();
    for (const sub of [...this.proxySubscriptions.values()]) {
      await this.closeProxySubscription(sub, "Server closing", false);
    }
  }

  async closeSessionSubscriptions(sessionId: string): Promise<void> {
    for (const sub of [...this.proxySubscriptions.values()]) {
      if (sub.upstreamSessionId === sessionId) {
        await this.closeProxySubscription(sub, "Session closed", false);
      }
    }
  }

  private attachDownstreamListeners(entry: MountedProviderEntry): void {
    entry.unsubscribers.push(
      entry.client.onNodeAdded((ev) => {
        if (!isPathWithin(ev.parentPath, entry.sourcePath)) {
          return;
        }
        const parentPath = rebasePath(ev.parentPath, entry.sourcePath, entry.anchorPath);
        if (!parentPath) {
          return;
        }
        const node = rewriteNodeForUpstream(
          ev.node,
          entry.sourcePath,
          entry.anchorPath,
          entry.mountKey,
        );
        void this.host.broadcastNotification("node.added", {
          parentPath,
          node,
          ...(ev.index !== undefined ? { index: ev.index } : {}),
        });
      }),
    );

    entry.unsubscribers.push(
      entry.client.onNodeUpdated((ev) => {
        if (!isPathWithin(ev.path, entry.sourcePath)) {
          return;
        }
        const path = rebasePath(ev.path, entry.sourcePath, entry.anchorPath);
        if (!path) {
          return;
        }
        const node = rewriteNodeForUpstream(
          ev.node,
          entry.sourcePath,
          entry.anchorPath,
          entry.mountKey,
        );
        if (ev.path === entry.sourcePath && entry.sourcePath !== "/") {
          node.id = splitParentPath(entry.anchorPath).id;
        }
        void this.host.broadcastNotification("node.updated", { path, node });
      }),
    );

    entry.unsubscribers.push(
      entry.client.onNodeRemoved((ev) => {
        if (!isPathWithin(ev.path, entry.sourcePath)) {
          return;
        }
        const path = rebasePath(ev.path, entry.sourcePath, entry.anchorPath);
        if (!path) {
          return;
        }
        void this.host.broadcastNotification("node.removed", { path });
      }),
    );

    entry.unsubscribers.push(
      entry.client.onNodeEvent((ev) => {
        if (!isPathWithin(ev.path, entry.sourcePath)) {
          return;
        }
        const path = rebasePath(ev.path, entry.sourcePath, entry.anchorPath);
        if (!path) {
          return;
        }
        void this.host.broadcastNotification("node.event", {
          ...ev,
          path,
          ...(ev.data !== undefined
            ? { data: rewriteValueRefsForUpstream(ev.data, entry.mountKey) }
            : {}),
        });
      }),
    );

    entry.unsubscribers.push(
      entry.client.onClose(() => {
        if (this.treeStore.findNodeInternal(entry.anchorPath)) {
          try {
            this.treeStore.updateNode(entry.anchorPath, (prev) => ({
              ...prev,
              meta: {
                ...(prev.meta ?? {}),
                [META_KEYS.MOUNT]: {
                  providerId: entry.mountKey,
                  status: "unavailable",
                },
              },
            }));
          } catch {
            // Ignore metadata update errors on teardown
          }
        }
        for (const sub of [...this.proxySubscriptions.values()]) {
          if (sub.mount === entry) {
            void this.closeProxySubscription(sub, "Mounted provider disconnected", true);
          }
        }
      }),
    );
  }

  private async getNodeOrTreeFromMount(
    mount: MountedProviderEntry,
    upstreamPath: Path,
    maxDepth?: number,
  ): Promise<AepNode> {
    const downstreamPath = rebasePath(upstreamPath, mount.anchorPath, mount.sourcePath);
    if (!downstreamPath) {
      throw new AepError(AEP_ERROR_CODES.INVALID_PATH, `Path "${upstreamPath}" outside mount`);
    }

    if (upstreamPath === mount.anchorPath && mount.sourcePath === "/") {
      const localAnchor = this.treeStore.getNode(mount.anchorPath, 0);
      if (maxDepth !== undefined && maxDepth <= 0) {
        return localAnchor.kind === "channel" ? localAnchor : { ...localAnchor, hasChildren: true };
      }
      const childDepth = maxDepth !== undefined ? maxDepth - 1 : undefined;
      const res = await withMountTimeout(mount, () =>
        mount.client.getTree({
          path: "/",
          ...(childDepth !== undefined ? { maxDepth: childDepth + 1 } : {}),
          includeHead: false,
        }),
      );
      mount.hydrated = true;
      if (res.node.kind !== "body") {
        throw new AepError(
          AEP_ERROR_CODES.INVALID_MESSAGE,
          "Expected BodyRoot when mounting downstream root '/'",
        );
      }
      const rewrittenChildren = res.node.children.map((child) =>
        rewriteNodeForUpstream(child, "/", mount.anchorPath, mount.mountKey),
      );
      return {
        ...(localAnchor as Exclude<AepNode, ChannelNode>),
        children: rewrittenChildren as never,
      };
    }

    const res = await withMountTimeout(mount, () =>
      mount.client.getTree({
        path: downstreamPath,
        ...(maxDepth !== undefined ? { maxDepth } : {}),
        includeHead: false,
      }),
    );
    mount.hydrated = true;
    if (res.node.kind === "body") {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `Expected node at "${downstreamPath}" but received BodyRoot`,
      );
    }
    const rewritten = rewriteNodeForUpstream(
      res.node,
      mount.sourcePath,
      mount.anchorPath,
      mount.mountKey,
    );
    if (upstreamPath === mount.anchorPath && mount.sourcePath !== "/") {
      rewritten.id = splitParentPath(mount.anchorPath).id;
    }
    return rewritten;
  }

  async getTree(path: Path = "/", maxDepth?: number): Promise<NodeOrBodyRoot> {
    const directMount = this.findMountForPath(path);
    if (directMount) {
      return await this.getNodeOrTreeFromMount(directMount, path, maxDepth);
    }

    const localTree = this.treeStore.getTree(path, maxDepth);
    if (!this.hasMounts()) {
      return localTree;
    }

    const hydrateNode = async (
      node: AepNode,
      nodePath: Path,
      remainingDepth: number | undefined,
    ): Promise<AepNode> => {
      const mount = this.mountsByAnchor.get(nodePath);
      if (mount) {
        if (remainingDepth !== undefined && remainingDepth <= 0) {
          return node.kind === "channel" ? node : { ...node, hasChildren: true };
        }
        if (mount.lazy && !mount.hydrated) {
          return node.kind === "channel" ? node : { ...node, hasChildren: true };
        }
        try {
          return await this.getNodeOrTreeFromMount(mount, nodePath, remainingDepth);
        } catch {
          return {
            ...node,
            meta: {
              ...(node.meta ?? {}),
              [META_KEYS.MOUNT]: {
                providerId: mount.mountKey,
                status: "unavailable",
              },
            },
          };
        }
      }
      if (node.kind === "channel" || !node.children) {
        return node;
      }
      if (remainingDepth !== undefined && remainingDepth <= 0) {
        return node;
      }
      const nextDepth = remainingDepth !== undefined ? remainingDepth - 1 : undefined;
      const nextChildren = await Promise.all(
        node.children.map((child) =>
          hydrateNode(child, `${nodePath}/${child.id}`, nextDepth),
        ),
      );
      return {
        ...node,
        children: nextChildren as never,
      };
    };

    if (localTree.kind === "body") {
      if (maxDepth !== undefined && maxDepth <= 0) {
        return localTree;
      }
      const childDepth = maxDepth !== undefined ? maxDepth - 1 : undefined;
      const hydratedChildren = await Promise.all(
        localTree.children.map((child) => hydrateNode(child, `/${child.id}`, childDepth)),
      );
      return {
        ...localTree,
        children: hydratedChildren as BodyRoot["children"],
      };
    }

    return await hydrateNode(localTree, path, maxDepth);
  }

  async getNode(path: Path, maxDepth?: number): Promise<AepNode> {
    if (path === "/") {
      throw new AepError(AEP_ERROR_CODES.INVALID_PATH, 'node.get cannot target root "/"');
    }
    const directMount = this.findMountForPath(path);
    if (directMount) {
      return await this.getNodeOrTreeFromMount(directMount, path, maxDepth);
    }
    const result = await this.getTree(path, maxDepth);
    if (result.kind === "body") {
      throw new AepError(AEP_ERROR_CODES.INVALID_PATH, 'node.get cannot target root "/"');
    }
    return result;
  }

  async queryTree(params: TreeQueryParams): Promise<TreeQueryResult> {
    const rootPath = params.rootPath ?? "/";
    parsePath(rootPath);

    const directMount = this.findMountForPath(rootPath);
    if (directMount) {
      const downstreamRoot = rebasePath(rootPath, directMount.anchorPath, directMount.sourcePath)!;
      const res = await withMountTimeout(directMount, () =>
        directMount.client.queryTree({
          ...params,
          rootPath: downstreamRoot,
        }),
      );
      const rewrittenMatches: TreeQueryMatch[] = res.matches.map((m) => ({
        path: rebasePath(m.path, directMount.sourcePath, directMount.anchorPath)!,
        node: rewriteNodeForUpstream(
          m.node,
          directMount.sourcePath,
          directMount.anchorPath,
          directMount.mountKey,
        ),
        depth: m.depth,
      }));
      return {
        matches: rewrittenMatches,
        totalCount: res.totalCount,
        ...(res.nextCursor !== undefined ? { nextCursor: res.nextCursor } : {}),
      };
    }

    const localTarget = this.treeStore.getTree(rootPath);
    let localMatches = querySubtree(localTarget, rootPath, params);

    const nonRootMountsWithSourceNode = new Set<Path>();
    for (const mount of this.mountsByAnchor.values()) {
      if (mount.sourcePath !== "/") {
        nonRootMountsWithSourceNode.add(mount.anchorPath);
      }
    }
    if (nonRootMountsWithSourceNode.size > 0) {
      localMatches = localMatches.filter((m) => !nonRootMountsWithSourceNode.has(m.path));
    }

    const rootSegLen = parsePath(rootPath).length;
    const mountedMatches: TreeQueryMatch[] = [];

    for (const mount of this.mountsByAnchor.values()) {
      if (!isPathWithin(mount.anchorPath, rootPath)) {
        continue;
      }
      const anchorDepth = parsePath(mount.anchorPath).length - rootSegLen;
      if (params.maxDepth !== undefined && anchorDepth > params.maxDepth) {
        continue;
      }
      const remainingDepth =
        params.maxDepth !== undefined ? params.maxDepth - anchorDepth : undefined;
      if (mount.sourcePath === "/" && remainingDepth === 0) {
        continue;
      }
      try {
        const res = await withMountTimeout(mount, () =>
          mount.client.queryTree({
            ...params,
            rootPath: mount.sourcePath,
            ...(remainingDepth !== undefined ? { maxDepth: remainingDepth } : {}),
            cursor: undefined,
            limit: undefined,
          }),
        );
        for (const m of res.matches) {
          const upstreamPath = rebasePath(m.path, mount.sourcePath, mount.anchorPath);
          if (!upstreamPath) {
            continue;
          }
          const rewritten = rewriteNodeForUpstream(
            m.node,
            mount.sourcePath,
            mount.anchorPath,
            mount.mountKey,
          );
          if (m.path === mount.sourcePath && mount.sourcePath !== "/") {
            rewritten.id = splitParentPath(mount.anchorPath).id;
          }
          mountedMatches.push({
            path: upstreamPath,
            node: rewritten,
            depth: anchorDepth + m.depth,
          });
        }
      } catch {
        // Fault isolation when spanning sibling mounts from an ancestor query
      }
    }

    const combined = [...localMatches, ...mountedMatches];
    return paginateMatches(combined, params.cursor, params.limit);
  }

  async loadChildren(
    mount: MountedProviderEntry,
    params: NodeLoadChildrenParams,
  ): Promise<NodeLoadChildrenResult> {
    const downstreamPath = rebasePath(params.path, mount.anchorPath, mount.sourcePath);
    if (!downstreamPath) {
      throw new AepError(AEP_ERROR_CODES.INVALID_PATH, `Path "${params.path}" outside mount`);
    }

    if (params.path === mount.anchorPath && mount.sourcePath === "/") {
      const treeRes = await withMountTimeout(mount, () =>
        mount.client.getTree({ path: "/", maxDepth: 1, includeHead: false }),
      );
      mount.hydrated = true;
      if (treeRes.node.kind !== "body") {
        throw new AepError(AEP_ERROR_CODES.INVALID_MESSAGE, "Expected BodyRoot from mounted '/'");
      }
      const rewritten = treeRes.node.children.map((child) =>
        rewriteNodeForUpstream(child, "/", mount.anchorPath, mount.mountKey),
      );
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
      const page = rewritten.slice(offset, end);
      const nextOffset = offset + page.length;
      const hasMore = params.limit !== undefined && nextOffset < rewritten.length;
      return {
        path: params.path,
        children: page,
        hasMore,
        ...(hasMore ? { nextCursor: String(nextOffset) } : {}),
      };
    }

    const res = await withMountTimeout(mount, () =>
      mount.client.loadChildren(downstreamPath, {
        ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      }),
    );
    mount.hydrated = true;
    return {
      path: params.path,
      children: res.children.map((child) =>
        rewriteNodeForUpstream(child, mount.sourcePath, mount.anchorPath, mount.mountKey),
      ),
      ...(res.hasMore !== undefined ? { hasMore: res.hasMore } : {}),
      ...(res.nextCursor !== undefined ? { nextCursor: res.nextCursor } : {}),
    };
  }

  async invokeMounted(
    mount: MountedProviderEntry,
    path: Path,
    method: string,
    params: unknown,
    session: ServerSessionContext,
  ): Promise<unknown> {
    const downstreamPath = rebasePath(path, mount.anchorPath, mount.sourcePath);
    if (!downstreamPath) {
      throw new AepError(AEP_ERROR_CODES.INVALID_PATH, `Path "${path}" outside mount`);
    }

    if (session.role === "observer") {
      const nodeRes = await withMountTimeout(mount, () =>
        mount.client.getNode(downstreamPath, { maxDepth: 0 }),
      );
      const decl = nodeRes.node.methods?.find((m) => m.name === method);
      if (decl) {
        const sideEffects = decl.sideEffects ?? "write";
        if (sideEffects === "write") {
          throw new AepError(
            AEP_ERROR_CODES.READ_ONLY_SESSION,
            `Observer session cannot invoke write method "${method}" on mounted path "${path}"`,
          );
        }
      } else {
        throw new AepError(
          AEP_ERROR_CODES.READ_ONLY_SESSION,
          `Observer session cannot invoke unannotated method "${method}" on mounted path "${path}"`,
        );
      }
    }

    const res = await withMountTimeout(mount, () =>
      mount.client.invoke(downstreamPath, method, params),
    );
    return rewriteValueRefsForUpstream(res.result, mount.mountKey);
  }

  canHandleBinaryRef(refId: string): boolean {
    const parsed = parseUpstreamRefId(refId);
    return parsed !== null && this.mountsByKey.has(parsed.mountKey);
  }

  async getBinary(params: GetBinaryParams): Promise<GetBinaryResult> {
    const parsed = parseUpstreamRefId(params.refId);
    if (!parsed) {
      throw new AepError(AEP_ERROR_CODES.BINARY_NOT_FOUND, `BinaryRef "${params.refId}" not found`);
    }
    const mount = this.mountsByKey.get(parsed.mountKey);
    if (!mount) {
      throw new AepError(AEP_ERROR_CODES.BINARY_NOT_FOUND, `BinaryRef "${params.refId}" not found`);
    }
    const res = await withMountTimeout(mount, () =>
      mount.client.getBinary(parsed.downstreamRefId, params.params),
    );
    return {
      reference: {
        ...res.reference,
        refId: toUpstreamRefId(mount.mountKey, res.reference.refId),
      },
      data: res.data,
    };
  }

  resolveMountedChannelTarget(
    path?: Path,
    refId?: string,
  ): { mount: MountedProviderEntry; downstreamPath?: Path; downstreamRefId?: string } | null {
    const mountByPath = path !== undefined ? this.findMountForPath(path) : undefined;
    let mountByRef: MountedProviderEntry | undefined;
    let downstreamRefId: string | undefined;

    if (refId !== undefined) {
      const parsed = parseUpstreamRefId(refId);
      if (parsed) {
        mountByRef = this.mountsByKey.get(parsed.mountKey);
        downstreamRefId = parsed.downstreamRefId;
      }
    }

    if (mountByPath && refId !== undefined && (!mountByRef || mountByPath !== mountByRef)) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PARAMS,
        `Channel path "${path}" and refId "${refId}" do not belong to the same mounted provider`,
      );
    }
    if (!mountByPath && mountByRef && path !== undefined) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PARAMS,
        `Channel path "${path}" and refId "${refId}" do not belong to the same mounted provider`,
      );
    }

    const mount = mountByPath ?? mountByRef;
    if (!mount) {
      return null;
    }

    const downstreamPath =
      path !== undefined ? rebasePath(path, mount.anchorPath, mount.sourcePath) ?? undefined : undefined;
    return {
      mount,
      ...(downstreamPath !== undefined ? { downstreamPath } : {}),
      ...(downstreamRefId !== undefined ? { downstreamRefId } : {}),
    };
  }

  async openChannel(
    target: { mount: MountedProviderEntry; downstreamPath?: Path; downstreamRefId?: string },
    params: ChannelOpenParams,
    session: ServerSessionContext,
    emit: (method: string, payload: unknown) => Promise<void>,
  ): Promise<ChannelOpenResult> {
    const { mount, downstreamPath, downstreamRefId } = target;

    if (session.role === "observer" && downstreamPath) {
      const nodeRes = await withMountTimeout(mount, () =>
        mount.client.getNode(downstreamPath, { maxDepth: 0 }),
      );
      if (nodeRes.node.kind === "channel") {
        if (nodeRes.node.direction === "act") {
          throw new AepError(
            AEP_ERROR_CODES.READ_ONLY_SESSION,
            `Observer session cannot open mounted "act" channel "${params.path}"`,
          );
        }
        if (
          nodeRes.node.direction === "duplex" &&
          session.capabilities.sessions?.allowObserverStreams === false
        ) {
          throw new AepError(
            AEP_ERROR_CODES.READ_ONLY_SESSION,
            `Observer session cannot subscribe to mounted "duplex" channel "${params.path}"`,
          );
        }
      }
    }

    const downstreamSub = await withMountTimeout(mount, () =>
      mount.client.openChannel({
        ...(downstreamPath !== undefined ? { path: downstreamPath } : {}),
        ...(downstreamRefId !== undefined ? { refId: downstreamRefId } : {}),
        ...(params.params !== undefined ? { params: params.params } : {}),
      }),
    );

    if (
      session.role === "observer" &&
      (downstreamSub.direction === "act" ||
        (downstreamSub.direction === "duplex" &&
          session.capabilities.sessions?.allowObserverStreams === false))
    ) {
      await downstreamSub.close().catch(() => {});
      throw new AepError(
        AEP_ERROR_CODES.READ_ONLY_SESSION,
        `Observer session cannot open mounted "${downstreamSub.direction}" channel`,
      );
    }

    const proxySubscriptionId = `sub-${randomUUID()}`;
    const upstreamPath =
      downstreamSub.path !== undefined
        ? rebasePath(downstreamSub.path, mount.sourcePath, mount.anchorPath) ?? params.path
        : params.path;

    const proxy: ProxySubscription = {
      proxySubscriptionId,
      mount,
      downstreamSub,
      upstreamSessionId: session.sessionId,
      ...(upstreamPath !== undefined ? { upstreamPath } : {}),
      emit,
      sequence: 0,
      ready: false,
      pendingNotifications: [],
      unsubscribers: [],
      closed: false,
    };

    proxy.unsubscribers.push(
      downstreamSub.onChunk((chunk) => {
        if (proxy.closed) {
          return;
        }
        proxy.sequence += 1;
        const payload = {
          subscriptionId: proxySubscriptionId,
          refId: toUpstreamRefId(mount.mountKey, chunk.refId),
          sequence: proxy.sequence,
          timestamp: chunk.timestamp,
          mediaType: chunk.mediaType,
          ...(chunk.offset !== undefined ? { offset: chunk.offset } : {}),
          data: chunk.data,
          ...(chunk.isFinal !== undefined ? { isFinal: chunk.isFinal } : {}),
        };
        if (!proxy.ready) {
          proxy.pendingNotifications.push({ method: "channel.chunk", payload });
          return;
        }
        void emit("channel.chunk", payload);
      }),
    );

    proxy.unsubscribers.push(
      downstreamSub.onClosed((ev) => {
        void this.closeProxySubscription(proxy, ev.reason, true);
      }),
    );

    this.proxySubscriptions.set(proxySubscriptionId, proxy);

    return {
      subscriptionId: proxySubscriptionId,
      ...(upstreamPath !== undefined ? { path: upstreamPath } : {}),
      reference: {
        ...downstreamSub.reference,
        refId: toUpstreamRefId(mount.mountKey, downstreamSub.reference.refId),
      },
      direction: downstreamSub.direction,
    };
  }

  hasProxySubscription(subscriptionId: string): boolean {
    return this.proxySubscriptions.has(subscriptionId);
  }

  async sendChannel(
    params: ChannelSendParams,
    session: ServerSessionContext,
  ): Promise<ChannelSendResult> {
    const proxy = this.proxySubscriptions.get(params.subscriptionId);
    if (!proxy || proxy.closed || proxy.upstreamSessionId !== session.sessionId) {
      throw new AepError(
        AEP_ERROR_CODES.CHANNEL_NOT_FOUND,
        `Active subscription "${params.subscriptionId}" not found`,
      );
    }
    if (session.role === "observer") {
      throw new AepError(
        AEP_ERROR_CODES.READ_ONLY_SESSION,
        "Observer session cannot send frames on mounted channel",
      );
    }
    if (proxy.downstreamSub.direction === "sense") {
      throw new AepError(
        AEP_ERROR_CODES.DIRECTION_MISMATCH,
        "Cannot call channel.send on sense-only mounted channel",
      );
    }
    return await withMountTimeout(proxy.mount, () =>
      proxy.downstreamSub.send(params.data, {
        ...(params.sequence !== undefined ? { sequence: params.sequence } : {}),
        ...(params.timestamp !== undefined ? { timestamp: params.timestamp } : {}),
        ...(params.mediaType !== undefined ? { mediaType: params.mediaType } : {}),
        ...(params.isFinal !== undefined ? { isFinal: params.isFinal } : {}),
      }),
    );
  }

  async seekChannel(
    params: ChannelSeekParams,
    session: ServerSessionContext,
  ): Promise<ChannelSeekResult> {
    const proxy = this.proxySubscriptions.get(params.subscriptionId);
    if (!proxy || proxy.closed || proxy.upstreamSessionId !== session.sessionId) {
      throw new AepError(
        AEP_ERROR_CODES.CHANNEL_NOT_FOUND,
        `Active subscription "${params.subscriptionId}" not found`,
      );
    }
    const res = await withMountTimeout(proxy.mount, () =>
      proxy.downstreamSub.seek(params.offset, params.unit),
    );
    return {
      ...res,
      subscriptionId: proxy.proxySubscriptionId,
    };
  }

  async sampleChannel(
    target: { mount: MountedProviderEntry; downstreamPath?: Path; downstreamRefId?: string },
    params: ChannelSampleParams,
  ): Promise<ChannelSampleResult> {
    const res = await withMountTimeout(target.mount, () =>
      target.mount.client.sampleChannel({
        ...(target.downstreamPath !== undefined ? { path: target.downstreamPath } : {}),
        ...(target.downstreamRefId !== undefined ? { refId: target.downstreamRefId } : {}),
        offset: params.offset,
        ...(params.unit !== undefined ? { unit: params.unit } : {}),
        ...(params.params !== undefined ? { params: params.params } : {}),
      }),
    );
    return {
      ...res,
      reference: {
        ...res.reference,
        refId: toUpstreamRefId(target.mount.mountKey, res.reference.refId),
      },
    };
  }

  async closeChannel(subscriptionId: string, sessionId: string): Promise<ChannelCloseResult> {
    const proxy = this.proxySubscriptions.get(subscriptionId);
    if (!proxy || proxy.upstreamSessionId !== sessionId) {
      throw new AepError(
        AEP_ERROR_CODES.CHANNEL_NOT_FOUND,
        `Active subscription "${subscriptionId}" not found`,
      );
    }
    await this.closeProxySubscription(proxy, undefined, false);
    return { closed: true, subscriptionId };
  }

  async activateSubscription(subscriptionId: string): Promise<void> {
    const proxy = this.proxySubscriptions.get(subscriptionId);
    if (!proxy || proxy.ready) {
      return;
    }
    proxy.ready = true;
    const queued = proxy.pendingNotifications.splice(0, proxy.pendingNotifications.length);
    for (const item of queued) {
      try {
        await proxy.emit(item.method, item.payload);
      } catch {
        // Ignore upstream emit errors
      }
    }
    if (proxy.closed) {
      this.proxySubscriptions.delete(subscriptionId);
    }
  }

  private async closeProxySubscription(
    proxy: ProxySubscription,
    reason: string | undefined,
    notifyUpstream: boolean,
  ): Promise<void> {
    if (proxy.closed) {
      return;
    }
    proxy.closed = true;
    if (proxy.ready || !notifyUpstream) {
      this.proxySubscriptions.delete(proxy.proxySubscriptionId);
    }
    for (const unsub of proxy.unsubscribers) {
      unsub();
    }
    proxy.unsubscribers.length = 0;

    try {
      if (!proxy.downstreamSub.isClosed) {
        await proxy.downstreamSub.close();
      }
    } catch {
      // Ignore downstream close errors
    }

    if (notifyUpstream) {
      const payload = {
        subscriptionId: proxy.proxySubscriptionId,
        refId: toUpstreamRefId(proxy.mount.mountKey, proxy.downstreamSub.reference.refId),
        ...(reason !== undefined ? { reason } : {}),
      };
      if (!proxy.ready) {
        proxy.pendingNotifications.push({ method: "channel.closed", payload });
        return;
      }
      try {
        await proxy.emit("channel.closed", payload);
      } catch {
        // Ignore upstream emit errors
      }
    }
  }
}
