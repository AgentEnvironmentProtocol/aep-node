import { isValidPath, rebasePath } from "./path.js";
import type { AepNode, BinaryRef, NodeState, Path, PropertyMap, StreamRef } from "./types.js";

export interface ParsedMountRefId {
  mountKey: string;
  downstreamRefId: string;
}

const MOUNT_REF_PREFIX = "mount:";

export function toUpstreamRefId(mountKey: string, downstreamRefId: string): string {
  return `${MOUNT_REF_PREFIX}${encodeURIComponent(mountKey)}:${downstreamRefId}`;
}

export function parseUpstreamRefId(refId: string): ParsedMountRefId | null {
  if (!refId.startsWith(MOUNT_REF_PREFIX)) {
    return null;
  }
  const rest = refId.slice(MOUNT_REF_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) {
    return null;
  }
  const encodedKey = rest.slice(0, sep);
  const downstreamRefId = rest.slice(sep + 1);
  if (!downstreamRefId) {
    return null;
  }
  try {
    return {
      mountKey: decodeURIComponent(encodedKey),
      downstreamRefId,
    };
  } catch {
    return null;
  }
}

function rewriteCaptureProperty(
  properties: PropertyMap | undefined,
  mountKey: string,
): PropertyMap | undefined {
  if (!properties) {
    return undefined;
  }
  const cloned = structuredClone(properties);
  const capture = cloned["capture"];
  if (typeof capture === "object" && capture !== null && !Array.isArray(capture)) {
    const refId = (capture as Record<string, unknown>)["refId"];
    if (typeof refId === "string" && refId.length > 0) {
      (capture as Record<string, unknown>)["refId"] = toUpstreamRefId(mountKey, refId);
    }
  }
  return cloned;
}

function isDataPlaneRefObject(value: unknown): value is BinaryRef | StreamRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record["refId"] === "string" && record["refId"].length > 0 && typeof record["mediaType"] === "string";
}

export function rewriteValueRefsForUpstream(value: unknown, mountKey: string): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteValueRefsForUpstream(item, mountKey));
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(record)) {
    out[key] = rewriteValueRefsForUpstream(val, mountKey);
  }
  if (isDataPlaneRefObject(out)) {
    out["refId"] = toUpstreamRefId(mountKey, out["refId"]);
  }
  return out;
}

export function rewriteNodeForUpstream<T extends AepNode>(
  node: T,
  sourceRoot: Path,
  anchorPath: Path,
  mountKey: string,
  stripMetaPrefixes?: readonly string[],
): T {
  const cloned = structuredClone(node);

  if (cloned.meta && stripMetaPrefixes && stripMetaPrefixes.length > 0) {
    for (const key of Object.keys(cloned.meta)) {
      if (stripMetaPrefixes.some((prefix) => key.startsWith(prefix))) {
        delete cloned.meta[key];
      }
    }
    if (Object.keys(cloned.meta).length === 0) {
      delete cloned.meta;
    }
  }

  if (cloned.properties) {
    cloned.properties = rewriteCaptureProperty(cloned.properties, mountKey);
  }

  if (cloned.state) {
    const nextState: NodeState = structuredClone(cloned.state);
    if (nextState.binaryRef) {
      nextState.binaryRef = {
        ...nextState.binaryRef,
        refId: toUpstreamRefId(mountKey, nextState.binaryRef.refId),
      };
    }
    if (typeof nextState.channelRef === "string" && isValidPath(nextState.channelRef)) {
      const rebased = rebasePath(nextState.channelRef, sourceRoot, anchorPath);
      if (rebased) {
        nextState.channelRef = rebased;
      }
    }
    cloned.state = nextState;
  }

  if (cloned.kind === "channel") {
    if (cloned.streamRef) {
      cloned.streamRef = {
        ...cloned.streamRef,
        refId: toUpstreamRefId(mountKey, cloned.streamRef.refId),
      };
    }
    return cloned;
  }

  if (cloned.children) {
    cloned.children = cloned.children.map((child) =>
      rewriteNodeForUpstream(child, sourceRoot, anchorPath, mountKey, stripMetaPrefixes),
    ) as typeof cloned.children;
  }

  return cloned;
}
