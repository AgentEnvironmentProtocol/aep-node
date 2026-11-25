import type {
  CapabilitiesObject,
  DeliveryMode,
  Direction,
  NodeKind,
  PayloadMode,
  RenderMode,
} from "./types.js";

export const AEP_CORE_STATIC_CAPABILITIES: CapabilitiesObject = {
  profile: "aep-core-static",
  nodeKinds: [
    "ou",
    "interface",
    "api",
    "endpoint",
    "structure",
    "component",
    "document",
    "view",
    "editable",
    "control",
  ],
  channelDirections: [],
  deliveryModes: [],
  channelPayloadModes: [],
  queries: {
    treeQuery: true,
    loadChildren: true,
  },
  passthrough: {
    enabled: true,
  },
  dataPlane: {
    binaryReferences: true,
    streamReferences: false,
    seek: false,
    sample: false,
  },
  rendering: {
    serverModes: ["renderMinimal", "renderFull"],
    formats: ["image/svg+xml", "image/png"],
    pathAnnotations: true,
  },
  security: {
    mode: "unauthenticated",
    supportedModes: ["unauthenticated"],
    elevation: false,
    reserved: true,
  },
};

export const AEP_CORE_STREAMING_CAPABILITIES: CapabilitiesObject = {
  profile: "aep-core-streaming",
  nodeKinds: [
    "ou",
    "interface",
    "api",
    "endpoint",
    "channel",
    "structure",
    "component",
    "document",
    "view",
    "editable",
    "control",
  ],
  channelDirections: ["sense", "act", "duplex"],
  deliveryModes: ["stream", "stream+seek"],
  channelPayloadModes: ["binary", "event"],
  queries: {
    treeQuery: true,
    loadChildren: true,
  },
  passthrough: {
    enabled: true,
  },
  sessions: {
    policy: "single-controller",
    allowObserverStreams: true,
    leases: true,
    optimisticConcurrency: true,
  },
  resumption: {
    enabled: true,
    replayWindowEvents: 1000,
    sessionTtlMs: 300_000,
  },
  dataPlane: {
    binaryReferences: true,
    streamReferences: true,
    seek: true,
    sample: true,
  },
  rendering: {
    serverModes: ["renderMinimal", "renderExpress", "renderFull"],
    formats: ["image/svg+xml", "image/png", "text/x-aep-layout"],
    pathAnnotations: true,
  },
  security: {
    mode: "unauthenticated",
    supportedModes: [
      "unauthenticated",
      "mtls",
      "os-peer",
      "bearer",
      "api-key",
      "challenge-response",
    ],
    elevation: true,
    reserved: true,
  },
};

function cloneCapabilities(caps: CapabilitiesObject): CapabilitiesObject {
  return structuredClone(caps);
}

export function buildCapabilities(
  profileOrPartial?: "aep-core-static" | "aep-core-streaming" | Partial<CapabilitiesObject>,
): CapabilitiesObject {
  if (profileOrPartial === undefined || profileOrPartial === "aep-core-streaming") {
    return cloneCapabilities(AEP_CORE_STREAMING_CAPABILITIES);
  }
  if (profileOrPartial === "aep-core-static") {
    return cloneCapabilities(AEP_CORE_STATIC_CAPABILITIES);
  }
  const base =
    profileOrPartial.profile === "aep-core-static"
      ? cloneCapabilities(AEP_CORE_STATIC_CAPABILITIES)
      : cloneCapabilities(AEP_CORE_STREAMING_CAPABILITIES);

  return {
    ...base,
    ...profileOrPartial,
    nodeKinds: profileOrPartial.nodeKinds ? [...profileOrPartial.nodeKinds] : base.nodeKinds,
    channelDirections: profileOrPartial.channelDirections
      ? [...profileOrPartial.channelDirections]
      : base.channelDirections,
    deliveryModes: profileOrPartial.deliveryModes
      ? [...profileOrPartial.deliveryModes]
      : base.deliveryModes,
    channelPayloadModes: profileOrPartial.channelPayloadModes
      ? [...profileOrPartial.channelPayloadModes]
      : base.channelPayloadModes
        ? [...base.channelPayloadModes]
        : undefined,
    queries: {
      ...base.queries,
      ...profileOrPartial.queries,
    },
    passthrough: {
      enabled: profileOrPartial.passthrough?.enabled ?? base.passthrough?.enabled ?? true,
      ...(profileOrPartial.passthrough?.maxDepth !== undefined
        ? { maxDepth: profileOrPartial.passthrough.maxDepth }
        : base.passthrough?.maxDepth !== undefined
          ? { maxDepth: base.passthrough.maxDepth }
          : {}),
    },
    sessions:
      base.sessions || profileOrPartial.sessions
        ? {
            ...base.sessions,
            ...profileOrPartial.sessions,
          }
        : undefined,
    resumption:
      base.resumption || profileOrPartial.resumption
        ? {
            enabled:
              profileOrPartial.resumption?.enabled ?? base.resumption?.enabled ?? false,
            ...(profileOrPartial.resumption?.replayWindowEvents !== undefined
              ? { replayWindowEvents: profileOrPartial.resumption.replayWindowEvents }
              : base.resumption?.replayWindowEvents !== undefined
                ? { replayWindowEvents: base.resumption.replayWindowEvents }
                : {}),
            ...(profileOrPartial.resumption?.sessionTtlMs !== undefined
              ? { sessionTtlMs: profileOrPartial.resumption.sessionTtlMs }
              : base.resumption?.sessionTtlMs !== undefined
                ? { sessionTtlMs: base.resumption.sessionTtlMs }
                : {}),
          }
        : undefined,
    dataPlane: {
      ...base.dataPlane,
      ...profileOrPartial.dataPlane,
    },
    rendering:
      base.rendering || profileOrPartial.rendering
        ? {
            ...base.rendering,
            ...profileOrPartial.rendering,
            ...(profileOrPartial.rendering?.serverModes
              ? { serverModes: [...profileOrPartial.rendering.serverModes] }
              : base.rendering?.serverModes
                ? { serverModes: [...base.rendering.serverModes] }
                : {}),
            ...(profileOrPartial.rendering?.formats
              ? { formats: [...profileOrPartial.rendering.formats] }
              : base.rendering?.formats
                ? { formats: [...base.rendering.formats] }
                : {}),
          }
        : undefined,
    security: {
      ...base.security,
      ...profileOrPartial.security,
      ...(profileOrPartial.security?.supportedModes
        ? { supportedModes: [...profileOrPartial.security.supportedModes] }
        : base.security.supportedModes
          ? { supportedModes: [...base.security.supportedModes] }
          : {}),
    },
    ...(profileOrPartial.vocabularies !== undefined
      ? { vocabularies: [...profileOrPartial.vocabularies] }
      : base.vocabularies !== undefined
        ? { vocabularies: [...base.vocabularies] }
        : {}),
  };
}

function intersectList<T extends string>(serverList: readonly T[], clientList?: readonly T[]): T[] {
  if (!clientList) {
    return [...serverList];
  }
  const clientSet = new Set(clientList);
  return serverList.filter((item) => clientSet.has(item));
}

export function negotiateCapabilities(
  server: CapabilitiesObject,
  client?: Partial<CapabilitiesObject>,
): CapabilitiesObject {
  const clientBase =
    client?.profile === "aep-core-static"
      ? AEP_CORE_STATIC_CAPABILITIES
      : client?.profile === "aep-core-streaming"
        ? AEP_CORE_STREAMING_CAPABILITIES
        : undefined;

  const clientNodeKinds = client?.nodeKinds ?? clientBase?.nodeKinds;
  const clientDirections = client?.channelDirections ?? clientBase?.channelDirections;
  const clientDeliveryModes = client?.deliveryModes ?? clientBase?.deliveryModes;
  const clientPayloadModes = client?.channelPayloadModes ?? clientBase?.channelPayloadModes;
  const clientQueries = client?.queries ?? clientBase?.queries;
  const clientPassthrough = client?.passthrough ?? clientBase?.passthrough;
  const clientDataPlane = client?.dataPlane ?? clientBase?.dataPlane;
  const clientSessions = client?.sessions ?? clientBase?.sessions;
  const clientResumption = client?.resumption ?? clientBase?.resumption;
  const clientRendering = client?.rendering ?? clientBase?.rendering;
  const clientVocabularies = client?.vocabularies ?? clientBase?.vocabularies;

  const nodeKinds: NodeKind[] = intersectList(server.nodeKinds, clientNodeKinds);
  const channelDirections: Direction[] = intersectList(server.channelDirections, clientDirections);
  const deliveryModes: DeliveryMode[] = intersectList(server.deliveryModes, clientDeliveryModes);
  const serverPayloadModes: PayloadMode[] =
    server.channelPayloadModes ?? (nodeKinds.includes("channel") ? ["binary"] : []);
  const channelPayloadModes: PayloadMode[] = intersectList(
    serverPayloadModes,
    clientPayloadModes,
  );

  const queries = {
    treeQuery: (server.queries?.treeQuery ?? true) && (clientQueries?.treeQuery ?? true),
    loadChildren: (server.queries?.loadChildren ?? true) && (clientQueries?.loadChildren ?? true),
  };

  let maxDepth: number | undefined;
  if (server.passthrough?.maxDepth !== undefined && clientPassthrough?.maxDepth !== undefined) {
    maxDepth = Math.min(server.passthrough.maxDepth, clientPassthrough.maxDepth);
  } else {
    maxDepth = server.passthrough?.maxDepth ?? clientPassthrough?.maxDepth;
  }

  const passthrough = {
    enabled: (server.passthrough?.enabled ?? false) && (clientPassthrough?.enabled ?? true),
    ...(maxDepth !== undefined ? { maxDepth } : {}),
  };

  const dataPlane = {
    binaryReferences: server.dataPlane.binaryReferences && (clientDataPlane?.binaryReferences ?? true),
    streamReferences: server.dataPlane.streamReferences && (clientDataPlane?.streamReferences ?? true),
    seek: server.dataPlane.seek && (clientDataPlane?.seek ?? true),
    sample: server.dataPlane.sample && (clientDataPlane?.sample ?? true),
  };

  const sessions =
    server.sessions || clientSessions
      ? {
          policy: server.sessions?.policy ?? "single-controller",
          allowObserverStreams:
            (server.sessions?.allowObserverStreams ?? true) &&
            (clientSessions?.allowObserverStreams ?? true),
          ...(server.sessions?.leases !== undefined || clientSessions?.leases !== undefined
            ? {
                leases:
                  (server.sessions?.leases ?? false) &&
                  (clientSessions?.leases ?? true),
              }
            : {}),
          ...(server.sessions?.optimisticConcurrency !== undefined ||
          clientSessions?.optimisticConcurrency !== undefined
            ? {
                optimisticConcurrency:
                  (server.sessions?.optimisticConcurrency ?? false) &&
                  (clientSessions?.optimisticConcurrency ?? true),
              }
            : {}),
        }
      : undefined;

  const resumption = server.resumption
    ? {
        enabled: server.resumption.enabled && (clientResumption?.enabled ?? true),
        ...(server.resumption.replayWindowEvents !== undefined
          ? { replayWindowEvents: server.resumption.replayWindowEvents }
          : {}),
        ...(server.resumption.sessionTtlMs !== undefined
          ? { sessionTtlMs: server.resumption.sessionTtlMs }
          : {}),
      }
    : undefined;

  const rendering = server.rendering
    ? {
        ...(server.rendering.serverModes
          ? {
              serverModes: intersectList<RenderMode>(
                server.rendering.serverModes,
                clientRendering?.serverModes,
              ),
            }
          : {}),
        ...(server.rendering.formats
          ? { formats: intersectList(server.rendering.formats, clientRendering?.formats) }
          : {}),
        ...(server.rendering.pathAnnotations !== undefined
          ? {
              pathAnnotations:
                server.rendering.pathAnnotations &&
                (clientRendering?.pathAnnotations ?? true),
            }
          : {}),
      }
    : undefined;

  let vocabularies: string[] | undefined;
  if (server.vocabularies && clientVocabularies) {
    vocabularies = intersectList(server.vocabularies, clientVocabularies);
  } else if (server.vocabularies) {
    vocabularies = [...server.vocabularies];
  }

  const isStatic =
    !nodeKinds.includes("channel") &&
    channelDirections.length === 0 &&
    deliveryModes.length === 0 &&
    !dataPlane.streamReferences &&
    !dataPlane.seek &&
    !dataPlane.sample;

  const isFullStreaming =
    nodeKinds.includes("channel") &&
    nodeKinds.includes("ou") &&
    nodeKinds.includes("interface") &&
    nodeKinds.includes("api") &&
    nodeKinds.includes("endpoint") &&
    nodeKinds.includes("structure") &&
    nodeKinds.includes("component") &&
    nodeKinds.includes("document") &&
    nodeKinds.includes("view") &&
    nodeKinds.includes("editable") &&
    nodeKinds.includes("control") &&
    channelDirections.length === 3 &&
    deliveryModes.length === 2 &&
    dataPlane.binaryReferences &&
    dataPlane.streamReferences &&
    dataPlane.seek &&
    dataPlane.sample;

  let profile: string | undefined;
  if (isStatic && (server.profile === "aep-core-static" || client?.profile === "aep-core-static")) {
    profile = "aep-core-static";
  } else if (
    isFullStreaming &&
    server.profile === "aep-core-streaming" &&
    (!client?.profile || client.profile === "aep-core-streaming")
  ) {
    profile = "aep-core-streaming";
  }

  return {
    ...(profile !== undefined ? { profile } : {}),
    nodeKinds,
    channelDirections,
    deliveryModes,
    channelPayloadModes,
    queries,
    passthrough,
    ...(sessions !== undefined ? { sessions } : {}),
    ...(resumption !== undefined ? { resumption } : {}),
    dataPlane,
    ...(rendering !== undefined ? { rendering } : {}),
    security: {
      ...server.security,
      ...(server.security.supportedModes
        ? { supportedModes: [...server.security.supportedModes] }
        : {}),
    },
    ...(vocabularies !== undefined ? { vocabularies } : {}),
  };
}
