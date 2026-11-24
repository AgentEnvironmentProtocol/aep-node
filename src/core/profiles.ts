import type { CapabilitiesObject, DeliveryMode, Direction, NodeKind } from "./types.js";

export const AEP_CORE_STATIC_CAPABILITIES: CapabilitiesObject = {
  profile: "aep-core-static",
  nodeKinds: ["ou", "interface", "structure", "content", "input"],
  channelDirections: [],
  deliveryModes: [],
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
  security: {
    mode: "unauthenticated",
    reserved: true,
  },
};

export const AEP_CORE_STREAMING_CAPABILITIES: CapabilitiesObject = {
  profile: "aep-core-streaming",
  nodeKinds: ["ou", "interface", "channel", "structure", "content", "input"],
  channelDirections: ["sense", "act", "duplex"],
  deliveryModes: ["stream", "stream+seek"],
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
  },
  dataPlane: {
    binaryReferences: true,
    streamReferences: true,
    seek: true,
    sample: true,
  },
  security: {
    mode: "unauthenticated",
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
    dataPlane: {
      ...base.dataPlane,
      ...profileOrPartial.dataPlane,
    },
    security: {
      ...base.security,
      ...profileOrPartial.security,
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
  const clientQueries = client?.queries ?? clientBase?.queries;
  const clientPassthrough = client?.passthrough ?? clientBase?.passthrough;
  const clientDataPlane = client?.dataPlane ?? clientBase?.dataPlane;
  const clientSessions = client?.sessions ?? clientBase?.sessions;
  const clientVocabularies = client?.vocabularies ?? clientBase?.vocabularies;

  const nodeKinds: NodeKind[] = intersectList(server.nodeKinds, clientNodeKinds);
  const channelDirections: Direction[] = intersectList(server.channelDirections, clientDirections);
  const deliveryModes: DeliveryMode[] = intersectList(server.deliveryModes, clientDeliveryModes);

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
    nodeKinds.includes("structure") &&
    nodeKinds.includes("content") &&
    nodeKinds.includes("input") &&
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
    queries,
    passthrough,
    ...(sessions !== undefined ? { sessions } : {}),
    dataPlane,
    security: { ...server.security },
    ...(vocabularies !== undefined ? { vocabularies } : {}),
  };
}
