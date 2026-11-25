import { randomUUID } from "node:crypto";
import { AEP_ERROR_CODES, AepError } from "../core/errors.js";
import {
  isPathWithin,
  isValidPath,
  parsePath,
  rebasePath,
} from "../core/path.js";
import {
  parseUpstreamRefId,
  rewriteNodeForUpstream,
  rewriteValueRefsForUpstream,
  toUpstreamRefId,
} from "../core/rewriting.js";
import { matchesQueryPredicates, paginateMatches } from "../core/tree-utils.js";
import {
  AEP_PROTOCOL_VERSION,
  HEAD_KEYS,
  META_KEYS,
  type AepNode,
  type AepValue,
  type BodyChild,
  type ChannelClosedParams,
  type ChannelCloseResult,
  type ChannelChunkParams,
  type ChannelOpenParams,
  type ChannelSampleParams,
  type ChannelSampleResult,
  type ChannelSeekParams,
  type ChannelSeekResult,
  type ChannelSendParams,
  type ChannelSendResult,
  type DataRenderParams,
  type DataRenderResult,
  type EventDecl,
  type GetBinaryOptions,
  type GetBinaryResult,
  type MetaMap,
  type MethodDecl,
  type NodeAddedParams,
  type NodeEventParams,
  type NodeGetResult,
  type NodeInvokeResult,
  type NodeLoadChildrenResult,
  type NodeMovedParams,
  type NodeRemovedParams,
  type NodeState,
  type NodeUpdatedParams,
  type OUChild,
  type OUNode,
  type Path,
  type PropertyMap,
  type TreeGetParams,
  type TreeGetResult,
  type TreeQueryMatch,
  type TreeQueryParams,
  type TreeQueryResult,
} from "../core/types.js";
import { validateMountContainment } from "../core/validation.js";
import type { AepClient } from "./client.js";
import { ClientChannelSubscription } from "./subscription.js";

export interface CompositeMountOptions {
  sourcePath?: Path;
  type?: string;
  properties?: PropertyMap;
  state?: NodeState;
  meta?: MetaMap;
  methods?: MethodDecl[];
  events?: EventDecl[];
  mountKey?: string;
  stripMetaPrefixes?: string[];
}

interface CompositeMountEntry {
  id: string;
  mountKey: string;
  anchorPath: Path;
  sourcePath: Path;
  client: AepClient;
  type?: string;
  properties?: PropertyMap;
  state?: NodeState;
  meta?: MetaMap;
  methods?: MethodDecl[];
  events?: EventDecl[];
  stripMetaPrefixes?: string[];
  unsubscribers: Array<() => void>;
}

interface CompositeSubEntry {
  compositeSubId: string;
  mount: CompositeMountEntry;
  downstreamSub: ClientChannelSubscription;
  compositeSub: ClientChannelSubscription;
  unsubscribers: Array<() => void>;
}

export class AepCompositeClient {
  private readonly mountsByAnchor = new Map<Path, CompositeMountEntry>();
  private readonly mountsByKey = new Map<string, CompositeMountEntry>();
  private readonly subscriptions = new Map<string, CompositeSubEntry>();
  private readonly anchorMethodHandlers = new Map<string, (params: unknown) => Promise<unknown> | unknown>();

  private readonly nodeAddedHandlers = new Set<(event: NodeAddedParams) => void>();
  private readonly nodeUpdatedHandlers = new Set<(event: NodeUpdatedParams) => void>();
  private readonly nodeMovedHandlers = new Set<(event: NodeMovedParams) => void>();
  private readonly nodeRemovedHandlers = new Set<(event: NodeRemovedParams) => void>();
  private readonly nodeEventHandlers = new Set<(event: NodeEventParams) => void>();
  private readonly channelChunkHandlers = new Set<(event: ChannelChunkParams) => void>();
  private readonly channelClosedHandlers = new Set<(event: ChannelClosedParams) => void>();

  private normalizeAnchor(idOrAnchorPath: string): { anchorPath: Path; id: string } {
    const candidate = idOrAnchorPath.startsWith("/") ? idOrAnchorPath : `/${idOrAnchorPath}`;
    const segments = parsePath(candidate);
    if (segments.length !== 1) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PATH,
        `Composite mount anchor must be a top-level segment path "/<id>", got "${idOrAnchorPath}"`,
      );
    }
    return { anchorPath: candidate, id: segments[0]! };
  }

  async mountServer(
    idOrAnchorPath: string,
    client: AepClient,
    options: CompositeMountOptions = {},
  ): Promise<{ anchorPath: Path; mountKey: string }> {
    const { anchorPath, id } = this.normalizeAnchor(idOrAnchorPath);
    if (this.mountsByAnchor.has(anchorPath)) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `Composite mount already exists at "${anchorPath}"`,
      );
    }

    const sourcePath: Path = options.sourcePath ?? "/";
    if (!isValidPath(sourcePath)) {
      throw new AepError(AEP_ERROR_CODES.INVALID_PATH, `Invalid sourcePath "${sourcePath}"`);
    }

    const mountKey = options.mountKey ?? id;
    if (this.mountsByKey.has(mountKey)) {
      throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, `Duplicate mountKey "${mountKey}"`);
    }

    if (!client.isInitialized) {
      await client.initialize();
    }

    const initial = await client.getTree({ path: sourcePath, includeHead: true });
    if (sourcePath === "/") {
      validateMountContainment("ou", initial.node);
    } else {
      validateMountContainment("body", initial.node);
    }

    const entry: CompositeMountEntry = {
      id,
      mountKey,
      anchorPath,
      sourcePath,
      client,
      ...(options.type !== undefined ? { type: options.type } : {}),
      ...(options.properties !== undefined ? { properties: structuredClone(options.properties) } : {}),
      ...(options.state !== undefined ? { state: structuredClone(options.state) } : {}),
      ...(options.meta !== undefined ? { meta: structuredClone(options.meta) } : {}),
      ...(options.methods !== undefined ? { methods: structuredClone(options.methods) } : {}),
      ...(options.events !== undefined ? { events: structuredClone(options.events) } : {}),
      ...(options.stripMetaPrefixes ? { stripMetaPrefixes: [...options.stripMetaPrefixes] } : {}),
      unsubscribers: [],
    };

    this.attachMountListeners(entry);
    this.mountsByAnchor.set(anchorPath, entry);
    this.mountsByKey.set(mountKey, entry);

    const anchorNode = this.buildAnchorNodeFromResult(entry, initial.node);
    for (const handler of this.nodeAddedHandlers) {
      handler({ parentPath: "/", node: anchorNode });
    }

    return { anchorPath, mountKey };
  }

  async unmountServer(idOrAnchorPath: string): Promise<void> {
    const { anchorPath } = this.normalizeAnchor(idOrAnchorPath);
    const entry = this.mountsByAnchor.get(anchorPath);
    if (!entry) {
      throw new AepError(
        AEP_ERROR_CODES.NODE_NOT_FOUND,
        `No composite mount found at "${anchorPath}"`,
      );
    }

    this.mountsByAnchor.delete(anchorPath);
    this.mountsByKey.delete(entry.mountKey);

    for (const unsub of entry.unsubscribers) {
      unsub();
    }
    entry.unsubscribers.length = 0;

    for (const sub of [...this.subscriptions.values()]) {
      if (sub.mount === entry) {
        await this.cleanupSubscription(sub, "Composite mount unmounted", true);
      }
    }

    for (const handler of this.nodeRemovedHandlers) {
      handler({ path: anchorPath });
    }
  }

  registerAnchorMethod(
    idOrAnchorPath: string,
    methodName: string,
    handler: (params: unknown) => Promise<unknown> | unknown,
  ): void {
    const { anchorPath } = this.normalizeAnchor(idOrAnchorPath);
    this.anchorMethodHandlers.set(`${anchorPath}::${methodName}`, handler);
  }

  getHead(): MetaMap {
    const profiles = new Set<string>();
    const vocabularies = new Set<string>();
    const versions = new Set<string>();
    const mountsInfo: Record<string, unknown> = {};

    for (const entry of this.mountsByAnchor.values()) {
      versions.add(entry.client.protocolVersion);
      const head = entry.client.head;
      const pList = head[HEAD_KEYS.PROFILES];
      if (Array.isArray(pList)) {
        for (const p of pList) {
          if (typeof p === "string") {
            profiles.add(p);
          }
        }
      }
      const vList = head[HEAD_KEYS.VOCABULARIES];
      if (Array.isArray(vList)) {
        for (const v of vList) {
          if (typeof v === "string") {
            vocabularies.add(v);
          }
        }
      }
      mountsInfo[entry.mountKey] = {
        anchorPath: entry.anchorPath,
        protocolVersion: entry.client.protocolVersion,
        ...(entry.client.serverInfo ? { serverInfo: entry.client.serverInfo } : {}),
        connected: !entry.client.isClosed,
      };
    }

    const negotiatedVersion = versions.size === 1 ? [...versions][0]! : AEP_PROTOCOL_VERSION;

    return {
      [HEAD_KEYS.PROTOCOL_VERSION]: negotiatedVersion,
      [HEAD_KEYS.PROFILES]: [...profiles],
      ...(vocabularies.size > 0 ? { [HEAD_KEYS.VOCABULARIES]: [...vocabularies] } : {}),
      "aep.compositeMounts": mountsInfo as MetaMap[string],
    };
  }

  async getTree(params: TreeGetParams = {}): Promise<TreeGetResult> {
    const path = params.path ?? "/";
    parsePath(path);
    const includeHead = params.includeHead ?? true;

    if (path === "/") {
      if (params.maxDepth !== undefined && params.maxDepth <= 0) {
        return {
          ...(includeHead ? { head: this.getHead() } : {}),
          node: { path: "/", kind: "body", children: [] },
        };
      }
      const childDepth = params.maxDepth !== undefined ? params.maxDepth - 1 : undefined;
      const children: BodyChild[] = [];
      for (const entry of this.mountsByAnchor.values()) {
        if (childDepth !== undefined && childDepth <= 0 && entry.sourcePath === "/") {
          children.push(this.buildSyntheticAnchorOu(entry, { hasChildren: true }));
        } else {
          const res = await entry.client.getTree({
            path: entry.sourcePath,
            ...(childDepth !== undefined
              ? { maxDepth: entry.sourcePath === "/" ? childDepth : childDepth }
              : {}),
            includeHead: false,
          });
          children.push(this.buildAnchorNodeFromResult(entry, res.node) as BodyChild);
        }
      }
      return {
        ...(includeHead ? { head: this.getHead() } : {}),
        node: { path: "/", kind: "body", children },
      };
    }

    const mount = this.findMountForPath(path);
    if (!mount) {
      throw new AepError(AEP_ERROR_CODES.NODE_NOT_FOUND, `Node not found at "${path}"`);
    }

    if (path === mount.anchorPath && mount.sourcePath === "/") {
      if (params.maxDepth !== undefined && params.maxDepth <= 0) {
        return {
          ...(includeHead ? { head: this.getHead() } : {}),
          node: this.buildSyntheticAnchorOu(mount, { hasChildren: true }),
        };
      }
      const res = await mount.client.getTree({
        path: "/",
        ...(params.maxDepth !== undefined ? { maxDepth: params.maxDepth } : {}),
        includeHead: false,
      });
      return {
        ...(includeHead ? { head: this.getHead() } : {}),
        node: this.buildAnchorNodeFromResult(mount, res.node),
      };
    }

    const downstreamPath = rebasePath(path, mount.anchorPath, mount.sourcePath)!;
    const res = await mount.client.getTree({
      path: downstreamPath,
      ...(params.maxDepth !== undefined ? { maxDepth: params.maxDepth } : {}),
      includeHead: false,
    });
    if (res.node.kind === "body") {
      throw new AepError(AEP_ERROR_CODES.INVALID_MESSAGE, "Unexpected BodyRoot");
    }
    const rewritten = rewriteNodeForUpstream(
      res.node,
      mount.sourcePath,
      mount.anchorPath,
      mount.mountKey,
    );
    if (path === mount.anchorPath && mount.sourcePath !== "/") {
      rewritten.id = mount.id;
    }
    return {
      ...(includeHead ? { head: this.getHead() } : {}),
      node: rewritten,
    };
  }

  async queryTree(params: TreeQueryParams = {}): Promise<TreeQueryResult> {
    const rootPath = params.rootPath ?? "/";
    parsePath(rootPath);

    if (rootPath !== "/") {
      const mount = this.findMountForPath(rootPath);
      if (!mount) {
        throw new AepError(AEP_ERROR_CODES.NODE_NOT_FOUND, `Root path "${rootPath}" not found`);
      }
      const downstreamRoot = rebasePath(rootPath, mount.anchorPath, mount.sourcePath)!;
      const res = await mount.client.queryTree({
        ...params,
        rootPath: downstreamRoot,
      });
      return {
        matches: res.matches.map((m) => ({
          path: rebasePath(m.path, mount.sourcePath, mount.anchorPath)!,
          node: rewriteNodeForUpstream(
            m.node,
            mount.sourcePath,
            mount.anchorPath,
            mount.mountKey,
          ),
          depth: m.depth,
        })),
        totalCount: res.totalCount,
        ...(res.nextCursor !== undefined ? { nextCursor: res.nextCursor } : {}),
      };
    }

    const allMatches: TreeQueryMatch[] = [];
    for (const mount of this.mountsByAnchor.values()) {
      if (mount.sourcePath === "/") {
        if (params.maxDepth === undefined || params.maxDepth >= 1) {
          const anchorNode = this.buildSyntheticAnchorOu(mount, { hasChildren: true });
          if (matchesQueryPredicates(anchorNode, params)) {
            allMatches.push({ path: mount.anchorPath, node: anchorNode, depth: 1 });
          }
        }
        if (params.maxDepth !== undefined && params.maxDepth < 2) {
          continue;
        }
        const remainingDepth = params.maxDepth !== undefined ? params.maxDepth - 1 : undefined;
        const res = await mount.client.queryTree({
          ...params,
          rootPath: "/",
          ...(remainingDepth !== undefined ? { maxDepth: remainingDepth } : {}),
          cursor: undefined,
          limit: undefined,
        });
        for (const m of res.matches) {
          const upstreamPath = rebasePath(m.path, "/", mount.anchorPath)!;
          allMatches.push({
            path: upstreamPath,
            node: rewriteNodeForUpstream(m.node, "/", mount.anchorPath, mount.mountKey),
            depth: 1 + m.depth,
          });
        }
      } else {
        if (params.maxDepth !== undefined && params.maxDepth < 1) {
          continue;
        }
        const remainingDepth = params.maxDepth !== undefined ? params.maxDepth - 1 : undefined;
        const res = await mount.client.queryTree({
          ...params,
          rootPath: mount.sourcePath,
          ...(remainingDepth !== undefined ? { maxDepth: remainingDepth } : {}),
          cursor: undefined,
          limit: undefined,
        });
        for (const m of res.matches) {
          const upstreamPath = rebasePath(m.path, mount.sourcePath, mount.anchorPath)!;
          const rewritten = rewriteNodeForUpstream(
            m.node,
            mount.sourcePath,
            mount.anchorPath,
            mount.mountKey,
          );
          if (m.path === mount.sourcePath) {
            rewritten.id = mount.id;
          }
          allMatches.push({
            path: upstreamPath,
            node: rewritten,
            depth: 1 + m.depth,
          });
        }
      }
    }

    return paginateMatches(allMatches, params.cursor, params.limit);
  }

  async getNode(path: Path, options?: { maxDepth?: number }): Promise<NodeGetResult> {
    if (path === "/") {
      throw new AepError(AEP_ERROR_CODES.INVALID_PATH, 'node.get cannot target root "/"');
    }
    const res = await this.getTree({ path, maxDepth: options?.maxDepth, includeHead: false });
    if (res.node.kind === "body") {
      throw new AepError(AEP_ERROR_CODES.INVALID_PATH, 'node.get cannot target root "/"');
    }
    return { path, node: res.node };
  }

  async loadChildren(
    path: Path,
    options?: { cursor?: string; limit?: number },
  ): Promise<NodeLoadChildrenResult> {
    if (path === "/") {
      throw new AepError(AEP_ERROR_CODES.INVALID_PATH, 'node.loadChildren cannot target root "/"');
    }
    const mount = this.findMountForPath(path);
    if (!mount) {
      throw new AepError(AEP_ERROR_CODES.NODE_NOT_FOUND, `Node not found at "${path}"`);
    }
    if (path === mount.anchorPath && mount.sourcePath === "/") {
      const res = await mount.client.getTree({ path: "/", maxDepth: 1, includeHead: false });
      if (res.node.kind !== "body") {
        throw new AepError(AEP_ERROR_CODES.INVALID_MESSAGE, "Expected BodyRoot");
      }
      return {
        path,
        children: res.node.children.map((child) =>
          rewriteNodeForUpstream(child, "/", mount.anchorPath, mount.mountKey),
        ),
        hasMore: false,
      };
    }

    const downstreamPath = rebasePath(path, mount.anchorPath, mount.sourcePath)!;
    const res = await mount.client.loadChildren(downstreamPath, options);
    return {
      path,
      children: res.children.map((child) =>
        rewriteNodeForUpstream(child, mount.sourcePath, mount.anchorPath, mount.mountKey),
      ),
      ...(res.hasMore !== undefined ? { hasMore: res.hasMore } : {}),
      ...(res.nextCursor !== undefined ? { nextCursor: res.nextCursor } : {}),
    };
  }

  async invoke<T = unknown>(
    path: Path,
    method: string,
    params?: unknown,
    options?: {
      expectedRevision?: number;
      leaseId?: string;
      grantId?: string;
    },
  ): Promise<NodeInvokeResult<T>> {
    if (path === "/") {
      throw new AepError(AEP_ERROR_CODES.INVALID_PATH, 'node.invoke cannot target root "/"');
    }
    const mount = this.findMountForPath(path);
    if (!mount) {
      throw new AepError(AEP_ERROR_CODES.NODE_NOT_FOUND, `Node not found at "${path}"`);
    }
    if (path === mount.anchorPath && mount.sourcePath === "/") {
      const localHandler = this.anchorMethodHandlers.get(`${path}::${method}`);
      if (!localHandler) {
        throw new AepError(
          AEP_ERROR_CODES.METHOD_NOT_FOUND,
          `Method "${method}" not found on composite anchor "${path}"`,
        );
      }
      const result = (await localHandler(params)) as T;
      return { path, method, result };
    }

    const downstreamPath = rebasePath(path, mount.anchorPath, mount.sourcePath)!;
    const res = await mount.client.invoke<T>(downstreamPath, method, params, options);
    return {
      path,
      method,
      ...(res.revision !== undefined ? { revision: res.revision } : {}),
      result: rewriteValueRefsForUpstream(res.result, mount.mountKey) as T,
    };
  }

  async render(params: DataRenderParams): Promise<DataRenderResult> {
    if (!params.path || params.path === "/") {
      throw new AepError(AEP_ERROR_CODES.INVALID_PATH, "data.render requires non-root path");
    }
    const mount = this.findMountForPath(params.path);
    if (!mount) {
      throw new AepError(AEP_ERROR_CODES.NODE_NOT_FOUND, `Node not found at "${params.path}"`);
    }
    const downstreamPath = rebasePath(params.path, mount.anchorPath, mount.sourcePath)!;
    const res = await mount.client.render({
      ...params,
      path: downstreamPath,
    });
    let rebasedMap: Record<string, Path> | undefined;
    if (res.pathMap) {
      rebasedMap = {};
      for (const [k, v] of Object.entries(res.pathMap)) {
        rebasedMap[k] = rebasePath(v, mount.sourcePath, mount.anchorPath) ?? v;
      }
    }
    return {
      ...res,
      path: params.path,
      ...(res.resolvedPath !== undefined
        ? {
            resolvedPath:
              rebasePath(res.resolvedPath, mount.sourcePath, mount.anchorPath) ?? params.path,
          }
        : {}),
      ...(res.reference !== undefined
        ? {
            reference: {
              ...res.reference,
              refId: toUpstreamRefId(mount.mountKey, res.reference.refId),
            },
          }
        : {}),
      ...(rebasedMap !== undefined ? { pathMap: rebasedMap } : {}),
    };
  }

  async getBinary(refId: string, params?: GetBinaryOptions): Promise<GetBinaryResult> {
    const parsed = parseUpstreamRefId(refId);
    if (!parsed) {
      throw new AepError(AEP_ERROR_CODES.BINARY_NOT_FOUND, `BinaryRef "${refId}" not found`);
    }
    const mount = this.mountsByKey.get(parsed.mountKey);
    if (!mount) {
      throw new AepError(AEP_ERROR_CODES.BINARY_NOT_FOUND, `BinaryRef "${refId}" not found`);
    }
    const res = await mount.client.getBinary(parsed.downstreamRefId, params);
    return {
      reference: {
        ...res.reference,
        refId: toUpstreamRefId(mount.mountKey, res.reference.refId),
      },
      data: res.data,
    };
  }

  async openChannel(params: ChannelOpenParams): Promise<ClientChannelSubscription> {
    const resolved = this.resolveChannelTarget(params.path, params.refId);
    const downSub = await resolved.mount.client.openChannel({
      ...(resolved.downstreamPath !== undefined ? { path: resolved.downstreamPath } : {}),
      ...(resolved.downstreamRefId !== undefined ? { refId: resolved.downstreamRefId } : {}),
      ...(params.params !== undefined ? { params: params.params } : {}),
    });

    const compositeSubId = `csub-${randomUUID()}`;
    const upstreamPath =
      downSub.path !== undefined
        ? rebasePath(downSub.path, resolved.mount.sourcePath, resolved.mount.anchorPath) ??
          params.path
        : params.path;
    const upstreamRefId = toUpstreamRefId(resolved.mount.mountKey, downSub.reference.refId);

    const compositeSub = new ClientChannelSubscription(
      {
        subscriptionId: compositeSubId,
        ...(upstreamPath !== undefined ? { path: upstreamPath, resolvedPath: upstreamPath } : {}),
        reference: {
          ...downSub.reference,
          refId: upstreamRefId,
        },
        direction: downSub.direction,
        payloadMode: downSub.payloadMode,
      },
      {
        send: (sendParams) => this.sendChannel(sendParams),
        seek: (seekParams) => this.seekChannel(seekParams),
        close: (subscriptionId) => this.closeChannel(subscriptionId),
      },
    );

    const entry: CompositeSubEntry = {
      compositeSubId,
      mount: resolved.mount,
      downstreamSub: downSub,
      compositeSub,
      unsubscribers: [],
    };

    entry.unsubscribers.push(
      downSub.onChunk((chunk) => {
        const rewritten: ChannelChunkParams = {
          ...chunk,
          subscriptionId: compositeSubId,
          refId: toUpstreamRefId(resolved.mount.mountKey, chunk.refId),
        };
        compositeSub._pushChunk(rewritten);
        for (const handler of this.channelChunkHandlers) {
          handler(rewritten);
        }
      }),
    );

    entry.unsubscribers.push(
      downSub.onClosed((ev) => {
        void this.cleanupSubscription(entry, ev.reason, true);
      }),
    );

    this.subscriptions.set(compositeSubId, entry);
    return compositeSub;
  }

  async sendChannel(params: ChannelSendParams): Promise<ChannelSendResult> {
    const sub = this.subscriptions.get(params.subscriptionId);
    if (!sub) {
      throw new AepError(
        AEP_ERROR_CODES.CHANNEL_NOT_FOUND,
        `Active composite subscription "${params.subscriptionId}" not found`,
      );
    }
    if (sub.downstreamSub.payloadMode === "event") {
      if (!params.event || params.data !== undefined) {
        throw new AepError(
          AEP_ERROR_CODES.PAYLOAD_MODE_MISMATCH,
          "Event channel requires event without data",
        );
      }
      return await sub.downstreamSub.sendEvent(params.event, {
        ...(params.leaseId !== undefined ? { leaseId: params.leaseId } : {}),
        ...(params.sequence !== undefined ? { sequence: params.sequence } : {}),
        ...(params.timestamp !== undefined ? { timestamp: params.timestamp } : {}),
        ...(params.mediaType !== undefined ? { mediaType: params.mediaType } : {}),
        ...(params.isFinal !== undefined ? { isFinal: params.isFinal } : {}),
      });
    }
    if (!(params.data instanceof Uint8Array) || params.event !== undefined) {
      throw new AepError(
        AEP_ERROR_CODES.PAYLOAD_MODE_MISMATCH,
        "Binary channel requires data without event",
      );
    }
    return await sub.downstreamSub.send(params.data, {
      ...(params.leaseId !== undefined ? { leaseId: params.leaseId } : {}),
      ...(params.sequence !== undefined ? { sequence: params.sequence } : {}),
      ...(params.timestamp !== undefined ? { timestamp: params.timestamp } : {}),
      ...(params.mediaType !== undefined ? { mediaType: params.mediaType } : {}),
      ...(params.isFinal !== undefined ? { isFinal: params.isFinal } : {}),
    });
  }

  async seekChannel(params: ChannelSeekParams): Promise<ChannelSeekResult> {
    const sub = this.subscriptions.get(params.subscriptionId);
    if (!sub) {
      throw new AepError(
        AEP_ERROR_CODES.CHANNEL_NOT_FOUND,
        `Active composite subscription "${params.subscriptionId}" not found`,
      );
    }
    const res = await sub.downstreamSub.seek(params.offset, params.unit);
    return {
      ...res,
      subscriptionId: sub.compositeSubId,
    };
  }

  async sampleChannel(params: ChannelSampleParams): Promise<ChannelSampleResult> {
    const resolved = this.resolveChannelTarget(params.path, params.refId);
    const res = await resolved.mount.client.sampleChannel({
      ...(resolved.downstreamPath !== undefined ? { path: resolved.downstreamPath } : {}),
      ...(resolved.downstreamRefId !== undefined ? { refId: resolved.downstreamRefId } : {}),
      offset: params.offset,
      ...(params.unit !== undefined ? { unit: params.unit } : {}),
      ...(params.params !== undefined ? { params: params.params } : {}),
    });
    return {
      ...res,
      reference: {
        ...res.reference,
        refId: toUpstreamRefId(resolved.mount.mountKey, res.reference.refId),
      },
    };
  }

  async closeChannel(subscriptionId: string): Promise<ChannelCloseResult> {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) {
      throw new AepError(
        AEP_ERROR_CODES.CHANNEL_NOT_FOUND,
        `Active composite subscription "${subscriptionId}" not found`,
      );
    }
    await this.cleanupSubscription(sub, "Closed by client", false);
    return { closed: true, subscriptionId };
  }

  async closeAll(reason?: string): Promise<void> {
    const subs = [...this.subscriptions.values()];
    for (const sub of subs) {
      await this.cleanupSubscription(sub, reason, false);
    }
    const clients = [...this.mountsByAnchor.values()].map((m) => m.client);
    for (const mount of this.mountsByAnchor.values()) {
      for (const unsub of mount.unsubscribers) {
        unsub();
      }
      mount.unsubscribers.length = 0;
    }
    this.mountsByAnchor.clear();
    this.mountsByKey.clear();
    await Promise.all(clients.map((c) => c.close(reason)));
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

  onNodeMoved(handler: (event: NodeMovedParams) => void): () => void {
    this.nodeMovedHandlers.add(handler);
    return () => {
      this.nodeMovedHandlers.delete(handler);
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

  private findMountForPath(path: Path): CompositeMountEntry | undefined {
    for (const mount of this.mountsByAnchor.values()) {
      if (isPathWithin(path, mount.anchorPath)) {
        return mount;
      }
    }
    return undefined;
  }

  private resolveChannelTarget(
    path?: Path,
    refId?: string,
  ): { mount: CompositeMountEntry; downstreamPath?: Path; downstreamRefId?: string } {
    if ((path === undefined || path === "") && (refId === undefined || refId === "")) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PARAMS,
        "Channel operation requires at least one of path or refId",
      );
    }

    const mountByPath = path !== undefined ? this.findMountForPath(path) : undefined;
    let mountByRef: CompositeMountEntry | undefined;
    let downstreamRefId: string | undefined;

    if (refId !== undefined) {
      const parsed = parseUpstreamRefId(refId);
      if (parsed) {
        mountByRef = this.mountsByKey.get(parsed.mountKey);
        downstreamRefId = parsed.downstreamRefId;
      }
    }

    if (path !== undefined && !mountByPath) {
      throw new AepError(AEP_ERROR_CODES.CHANNEL_NOT_FOUND, `Channel "${path}" not found`);
    }
    if (refId !== undefined && !mountByRef) {
      throw new AepError(AEP_ERROR_CODES.CHANNEL_NOT_FOUND, `StreamRef "${refId}" not found`);
    }
    if (mountByPath && mountByRef && mountByPath !== mountByRef) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PARAMS,
        `Channel path "${path}" and refId "${refId}" belong to different mounted servers`,
      );
    }

    const mount = (mountByPath ?? mountByRef)!;
    const downstreamPath =
      path !== undefined ? rebasePath(path, mount.anchorPath, mount.sourcePath) ?? undefined : undefined;

    return {
      mount,
      ...(downstreamPath !== undefined ? { downstreamPath } : {}),
      ...(downstreamRefId !== undefined ? { downstreamRefId } : {}),
    };
  }

  private buildSyntheticAnchorOu(
    entry: CompositeMountEntry,
    options: { hasChildren?: true; children?: OUChild[]; includeServerInfo?: boolean } = {},
  ): OUNode {
    const mountMeta: Record<string, AepValue> = {
      providerId: entry.mountKey,
      status: "connected",
    };
    if (options.includeServerInfo && entry.client.serverInfo) {
      mountMeta["serverInfo"] = entry.client.serverInfo as unknown as AepValue;
    }
    return {
      id: entry.id,
      kind: "ou",
      ...(entry.type ? { type: entry.type } : {}),
      ...(entry.properties ? { properties: structuredClone(entry.properties) } : {}),
      ...(entry.state ? { state: structuredClone(entry.state) } : {}),
      meta: {
        ...(entry.meta ?? {}),
        [META_KEYS.MOUNT]: mountMeta,
      },
      ...(entry.methods ? { methods: structuredClone(entry.methods) } : {}),
      ...(entry.events ? { events: structuredClone(entry.events) } : {}),
      ...(options.hasChildren ? { hasChildren: true } : {}),
      ...(options.children !== undefined ? { children: options.children } : {}),
    };
  }

  private buildAnchorNodeFromResult(entry: CompositeMountEntry, node: TreeGetResult["node"]): AepNode {
    if (node.kind === "body") {
      return this.buildSyntheticAnchorOu(entry, {
        includeServerInfo: true,
        children: node.children.map((child) =>
          rewriteNodeForUpstream(child, "/", entry.anchorPath, entry.mountKey),
        ) as OUChild[],
      });
    }

    const rewritten = rewriteNodeForUpstream(
      node,
      entry.sourcePath,
      entry.anchorPath,
      entry.mountKey,
    );
    rewritten.id = entry.id;
    return rewritten;
  }

  private attachMountListeners(entry: CompositeMountEntry): void {
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
        for (const handler of this.nodeAddedHandlers) {
          handler({ parentPath, node, ...(ev.index !== undefined ? { index: ev.index } : {}) });
        }
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
          node.id = entry.id;
        }
        for (const handler of this.nodeUpdatedHandlers) {
          handler({ path, node });
        }
      }),
    );

    entry.unsubscribers.push(
      entry.client.onNodeMoved((ev) => {
        if (!isPathWithin(ev.fromPath, entry.sourcePath) || !isPathWithin(ev.toPath, entry.sourcePath)) {
          return;
        }
        const fromPath = rebasePath(ev.fromPath, entry.sourcePath, entry.anchorPath);
        const toPath = rebasePath(ev.toPath, entry.sourcePath, entry.anchorPath);
        if (!fromPath || !toPath) {
          return;
        }
        const node = ev.node
          ? rewriteNodeForUpstream(
              ev.node,
              entry.sourcePath,
              entry.anchorPath,
              entry.mountKey,
              entry.stripMetaPrefixes,
            )
          : undefined;
        for (const handler of this.nodeMovedHandlers) {
          handler({
            fromPath,
            toPath,
            ...(ev.uid !== undefined ? { uid: ev.uid } : {}),
            ...(node !== undefined ? { node } : {}),
            ...(ev.index !== undefined ? { index: ev.index } : {}),
          });
        }
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
        for (const handler of this.nodeRemovedHandlers) {
          handler({ path });
        }
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
        const rewritten: NodeEventParams = {
          ...ev,
          path,
          ...(ev.data !== undefined
            ? { data: rewriteValueRefsForUpstream(ev.data, entry.mountKey) }
            : {}),
        };
        for (const handler of this.nodeEventHandlers) {
          handler(rewritten);
        }
      }),
    );
  }

  private async cleanupSubscription(
    sub: CompositeSubEntry,
    reason: string | undefined,
    fromDownstream: boolean,
  ): Promise<void> {
    if (!this.subscriptions.delete(sub.compositeSubId)) {
      return;
    }
    for (const unsub of sub.unsubscribers) {
      unsub();
    }
    sub.unsubscribers.length = 0;

    if (!fromDownstream && !sub.downstreamSub.isClosed) {
      await sub.downstreamSub.close().catch(() => {});
    }

    const closedEv: ChannelClosedParams = {
      subscriptionId: sub.compositeSubId,
      refId: sub.compositeSub.reference.refId,
      ...(reason !== undefined ? { reason } : {}),
    };
    sub.compositeSub._markClosed(closedEv);
    for (const handler of this.channelClosedHandlers) {
      handler(closedEv);
    }
  }
}
