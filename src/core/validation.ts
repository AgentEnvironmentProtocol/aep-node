import { AEP_ERROR_CODES, AepError } from "./errors.js";
import { isValidNamespacedIdent, isValidPath, isValidSegment, parsePath } from "./path.js";
import type {
  AepNode,
  BodyChild,
  BodyRoot,
  CapabilitiesObject,
  ChannelNode,
  ContentElementNode,
  EventDecl,
  InputElementNode,
  MethodDecl,
  NodeKind,
  Path,
} from "./types.js";

const VALID_NODE_KINDS = new Set<NodeKind>([
  "ou",
  "interface",
  "channel",
  "structure",
  "content",
  "input",
]);

const ALLOWED_CHILDREN: Record<NodeKind | "body", ReadonlySet<NodeKind>> = {
  body: new Set<NodeKind>(["ou", "interface", "channel"]),
  ou: new Set<NodeKind>(["ou", "interface", "channel"]),
  interface: new Set<NodeKind>(["structure", "content", "input", "interface", "channel"]),
  structure: new Set<NodeKind>(["structure", "content", "input", "interface"]),
  content: new Set<NodeKind>(["structure", "content", "input"]),
  input: new Set<NodeKind>(["structure", "content", "input"]),
  channel: new Set<NodeKind>(),
};

const VALID_DIRECTIONS = new Set(["sense", "act", "duplex"]);
const VALID_DELIVERY_MODES = new Set(["stream", "stream+seek"]);
const VALID_TEMPORAL_MODES = new Set(["static", "dynamic"]);
const VALID_SEEK_UNITS = new Set(["ms", "seconds", "frames", "bytes", "samples"]);
const VALID_INVOCATION_MODES = new Set(["request-response", "notification"]);
const VALID_SIDE_EFFECTS = new Set(["none", "read", "write"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateMetaMap(meta: unknown, context: string): void {
  if (meta === undefined) {
    return;
  }
  if (!isPlainObject(meta)) {
    throw new AepError(AEP_ERROR_CODES.INVALID_MESSAGE, `${context}.meta must be an object`);
  }
  for (const key of Object.keys(meta)) {
    if (!isValidNamespacedIdent(key)) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `Invalid meta key "${key}" in ${context}`,
      );
    }
  }
}

function validateMethodDecls(methods: unknown, context: string): void {
  if (methods === undefined) {
    return;
  }
  if (!Array.isArray(methods)) {
    throw new AepError(AEP_ERROR_CODES.INVALID_MESSAGE, `${context}.methods must be an array`);
  }
  for (let i = 0; i < methods.length; i += 1) {
    const method = methods[i] as MethodDecl | undefined;
    if (!isPlainObject(method) || typeof method.name !== "string" || !isValidNamespacedIdent(method.name)) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `Invalid method declaration at ${context}.methods[${i}]`,
      );
    }
    if (method.description !== undefined && typeof method.description !== "string") {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `Method description must be a string at ${context}.methods[${i}]`,
      );
    }
    if (method.inputSchema !== undefined && !isPlainObject(method.inputSchema)) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `Method inputSchema must be an object at ${context}.methods[${i}]`,
      );
    }
    if (method.outputSchema !== undefined && !isPlainObject(method.outputSchema)) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `Method outputSchema must be an object at ${context}.methods[${i}]`,
      );
    }
    if (method.mode !== undefined && !VALID_INVOCATION_MODES.has(method.mode)) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `Invalid method invocation mode "${String(method.mode)}" at ${context}.methods[${i}]`,
      );
    }
    if (method.sideEffects !== undefined && !VALID_SIDE_EFFECTS.has(method.sideEffects)) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `Invalid method sideEffects "${String(method.sideEffects)}" at ${context}.methods[${i}]`,
      );
    }
    validateMetaMap(method.meta, `${context}.methods[${i}]`);
  }
}

function validateEventDecls(events: unknown, context: string): void {
  if (events === undefined) {
    return;
  }
  if (!Array.isArray(events)) {
    throw new AepError(AEP_ERROR_CODES.INVALID_MESSAGE, `${context}.events must be an array`);
  }
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i] as EventDecl | undefined;
    if (!isPlainObject(event) || typeof event.name !== "string" || !isValidNamespacedIdent(event.name)) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `Invalid event declaration at ${context}.events[${i}]`,
      );
    }
    if (event.description !== undefined && typeof event.description !== "string") {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `Event description must be a string at ${context}.events[${i}]`,
      );
    }
    if (event.payloadSchema !== undefined && !isPlainObject(event.payloadSchema)) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `Event payloadSchema must be an object at ${context}.events[${i}]`,
      );
    }
    validateMetaMap(event.meta, `${context}.events[${i}]`);
  }
}

function validateBinaryRef(ref: unknown, context: string): void {
  if (!isPlainObject(ref)) {
    throw new AepError(AEP_ERROR_CODES.INVALID_REFERENCE, `${context}.binaryRef must be an object`);
  }
  if (typeof ref["refId"] !== "string" || ref["refId"].length === 0) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_REFERENCE,
      `${context}.binaryRef.refId must be a non-empty string`,
    );
  }
  if (typeof ref["mediaType"] !== "string" || ref["mediaType"].length === 0) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_REFERENCE,
      `${context}.binaryRef.mediaType must be a non-empty string`,
    );
  }
  if (ref["sizeBytes"] !== undefined) {
    const size = ref["sizeBytes"];
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_REFERENCE,
        `${context}.binaryRef.sizeBytes must be a non-negative integer`,
      );
    }
  }
  validateMetaMap(ref["meta"], `${context}.binaryRef`);
}

function validateStreamRef(ref: unknown, context: string): void {
  if (!isPlainObject(ref)) {
    throw new AepError(AEP_ERROR_CODES.INVALID_REFERENCE, `${context}.streamRef must be an object`);
  }
  if (typeof ref["refId"] !== "string" || ref["refId"].length === 0) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_REFERENCE,
      `${context}.streamRef.refId must be a non-empty string`,
    );
  }
  if (typeof ref["mediaType"] !== "string" || ref["mediaType"].length === 0) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_REFERENCE,
      `${context}.streamRef.mediaType must be a non-empty string`,
    );
  }
  if (ref["seek"] !== undefined) {
    const seek = ref["seek"];
    if (!isPlainObject(seek) || typeof seek["seekable"] !== "boolean") {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_REFERENCE,
        `${context}.streamRef.seek.seekable must be a boolean`,
      );
    }
    if (seek["unit"] !== undefined && (typeof seek["unit"] !== "string" || !VALID_SEEK_UNITS.has(seek["unit"]))) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_REFERENCE,
        `${context}.streamRef.seek.unit is invalid: "${String(seek["unit"])}"`,
      );
    }
  }
  validateMetaMap(ref["meta"], `${context}.streamRef`);
}

function validateChannelNode(node: ChannelNode, context: string): void {
  if (node.hasChildren === true) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `Channel node "${context}" MUST NOT set hasChildren = true`,
    );
  }
  const rawChildren = (node as { children?: unknown }).children;
  if (rawChildren !== undefined) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `Channel node "${context}" is a strict leaf and MUST NOT carry children`,
    );
  }
  if (typeof node.mediaType !== "string" || node.mediaType.length === 0) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `Channel node "${context}" requires a non-empty mediaType`,
    );
  }
  if (!VALID_DIRECTIONS.has(node.direction)) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `Channel node "${context}" has invalid direction "${String(node.direction)}"`,
    );
  }
  if (!VALID_DELIVERY_MODES.has(node.deliveryMode)) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `Channel node "${context}" has invalid deliveryMode "${String(node.deliveryMode)}"`,
    );
  }
  if (node.streamRef !== undefined) {
    validateStreamRef(node.streamRef, context);
  }
  validateMetaMap(node.streamMeta, `${context}.streamMeta`);
}

function validateContentNode(node: ContentElementNode, context: string): void {
  if (typeof node.mediaType !== "string" || node.mediaType.length === 0) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `Content node "${context}" requires a non-empty mediaType`,
    );
  }
  if (!VALID_TEMPORAL_MODES.has(node.temporalMode)) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `Content node "${context}" has invalid temporalMode "${String(node.temporalMode)}"`,
    );
  }
  const bindingCount =
    (node.value !== undefined ? 1 : 0) +
    (node.binaryRef !== undefined ? 1 : 0) +
    (node.channelRef !== undefined ? 1 : 0);
  if (bindingCount > 1) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `Content node "${context}" MUST specify at most one of value, binaryRef, or channelRef`,
    );
  }
  if (node.binaryRef !== undefined) {
    validateBinaryRef(node.binaryRef, context);
  }
  if (node.channelRef !== undefined && (typeof node.channelRef !== "string" || !isValidPath(node.channelRef))) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_REFERENCE,
      `Content node "${context}" has malformed channelRef "${String(node.channelRef)}"`,
    );
  }
}

function validateInputNode(node: InputElementNode, context: string): void {
  if (typeof node.mediaType !== "string" || node.mediaType.length === 0) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `Input node "${context}" requires a non-empty mediaType`,
    );
  }
  if (node.inputSchema !== undefined && !isPlainObject(node.inputSchema)) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `Input node "${context}" inputSchema must be an object`,
    );
  }
  if (node.channelRef !== undefined && (typeof node.channelRef !== "string" || !isValidPath(node.channelRef))) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_REFERENCE,
      `Input node "${context}" has malformed channelRef "${String(node.channelRef)}"`,
    );
  }
}

export function validateNode(
  node: AepNode,
  parentKind: NodeKind | "body",
  ancestors: Set<object> = new Set<object>(),
  parentPath: Path = "/",
): void {
  if (!isPlainObject(node)) {
    throw new AepError(AEP_ERROR_CODES.INVALID_MESSAGE, `Node under "${parentPath}" must be an object`);
  }
  if (ancestors.has(node)) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `Cyclic node reference detected under "${parentPath}"`,
    );
  }
  if (typeof node.id !== "string" || !isValidSegment(node.id)) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `Invalid NodeId "${String(node.id)}" under "${parentPath}"`,
    );
  }
  const nodePath: Path = parentPath === "/" ? `/${node.id}` : `${parentPath}/${node.id}`;
  if (typeof node.kind !== "string" || !VALID_NODE_KINDS.has(node.kind)) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `Invalid NodeKind "${String(node.kind)}" at "${nodePath}"`,
    );
  }
  const allowed = ALLOWED_CHILDREN[parentKind];
  if (!allowed.has(node.kind)) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `Node "${nodePath}" of kind "${node.kind}" is not allowed inside parent kind "${parentKind}"`,
    );
  }
  if (node.type !== undefined && (typeof node.type !== "string" || !isValidNamespacedIdent(node.type))) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `Invalid TypeTag "${String(node.type)}" at "${nodePath}"`,
    );
  }
  if (node.hasChildren !== undefined && typeof node.hasChildren !== "boolean") {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `hasChildren must be a boolean at "${nodePath}"`,
    );
  }

  validateMetaMap(node.meta, nodePath);
  validateMethodDecls(node.methods, nodePath);
  validateEventDecls(node.events, nodePath);

  if (node.kind === "channel") {
    validateChannelNode(node, nodePath);
    return;
  }
  if (node.kind === "content") {
    validateContentNode(node, nodePath);
  } else if (node.kind === "input") {
    validateInputNode(node, nodePath);
  }

  const children = node.children as readonly AepNode[] | undefined;
  if (children === undefined) {
    return;
  }
  if (!Array.isArray(children)) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `Node "${nodePath}" children must be an array`,
    );
  }

  ancestors.add(node);
  try {
    const siblingIds = new Set<string>();
    for (const child of children) {
      validateNode(child, node.kind, ancestors, nodePath);
      if (siblingIds.has(child.id)) {
        throw new AepError(
          AEP_ERROR_CODES.INVALID_MESSAGE,
          `Duplicate sibling NodeId "${child.id}" under "${nodePath}"`,
        );
      }
      siblingIds.add(child.id);
    }
  } finally {
    ancestors.delete(node);
  }
}

function lookupPathWithLazyHint(
  children: readonly BodyChild[],
  targetPath: Path,
): { node?: AepNode; coveredByLazyAncestor: boolean } {
  const segments = parsePath(targetPath);
  if (segments.length === 0) {
    return { coveredByLazyAncestor: false };
  }
  let currentList: readonly AepNode[] = children;
  let currentNode: AepNode | undefined;
  let sawLazy = false;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!;
    const found = currentList.find((item) => item.id === seg);
    if (!found) {
      return { coveredByLazyAncestor: sawLazy };
    }
    currentNode = found;
    if (found.hasChildren === true && (!("children" in found) || !found.children || found.children.length === 0)) {
      sawLazy = true;
    }
    if (i < segments.length - 1) {
      if (found.kind === "channel" || !found.children) {
        return { coveredByLazyAncestor: found.hasChildren === true || sawLazy };
      }
      currentList = found.children;
    }
  }
  return { node: currentNode, coveredByLazyAncestor: sawLazy };
}

export function validateChannelRefs(body: readonly BodyChild[], strict = false): void {
  const walk = (nodes: readonly AepNode[], parentPath: Path): void => {
    for (const node of nodes) {
      const nodePath = parentPath === "/" ? `/${node.id}` : `${parentPath}/${node.id}`;
      if ((node.kind === "content" || node.kind === "input") && node.channelRef !== undefined) {
        if (!isValidPath(node.channelRef)) {
          throw new AepError(
            AEP_ERROR_CODES.INVALID_REFERENCE,
            `Invalid channelRef "${node.channelRef}" on "${nodePath}"`,
          );
        }
        const resolved = lookupPathWithLazyHint(body, node.channelRef);
        if (resolved.node) {
          if (resolved.node.kind !== "channel") {
            throw new AepError(
              AEP_ERROR_CODES.INVALID_REFERENCE,
              `channelRef "${node.channelRef}" on "${nodePath}" resolves to kind "${resolved.node.kind}" instead of "channel"`,
            );
          }
        } else if (strict || !resolved.coveredByLazyAncestor) {
          throw new AepError(
            AEP_ERROR_CODES.INVALID_REFERENCE,
            `channelRef "${node.channelRef}" on "${nodePath}" does not resolve to an existing channel`,
          );
        }
      }
      if (node.kind !== "channel" && node.children) {
        walk(node.children, nodePath);
      }
    }
  };
  walk(body, "/");
}

export function validateBody(
  body: readonly BodyChild[],
  options: { checkChannelRefs?: boolean; strictChannelRefs?: boolean } = {},
): void {
  if (!Array.isArray(body)) {
    throw new AepError(AEP_ERROR_CODES.INVALID_MESSAGE, "Body must be an array");
  }
  const ancestors = new Set<object>();
  const topIds = new Set<string>();
  for (const child of body) {
    validateNode(child, "body", ancestors, "/");
    if (topIds.has(child.id)) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `Duplicate top-level NodeId "${child.id}" in Body`,
      );
    }
    topIds.add(child.id);
  }
  if (options.checkChannelRefs !== false) {
    validateChannelRefs(body, options.strictChannelRefs ?? false);
  }
}

export function validateNodeCapabilities(
  node: AepNode,
  capabilities: CapabilitiesObject,
  nodePath?: Path,
): void {
  const path = nodePath ?? `/${node.id}`;
  if (!capabilities.nodeKinds.includes(node.kind)) {
    throw new AepError(
      AEP_ERROR_CODES.UNSUPPORTED_CAPABILITY,
      `Node "${path}" uses unsupported NodeKind "${node.kind}"`,
    );
  }
  if (node.kind === "channel") {
    if (!capabilities.channelDirections.includes(node.direction)) {
      throw new AepError(
        AEP_ERROR_CODES.UNSUPPORTED_CAPABILITY,
        `Channel "${path}" uses unsupported direction "${node.direction}"`,
      );
    }
    if (!capabilities.deliveryModes.includes(node.deliveryMode)) {
      throw new AepError(
        AEP_ERROR_CODES.UNSUPPORTED_CAPABILITY,
        `Channel "${path}" uses unsupported deliveryMode "${node.deliveryMode}"`,
      );
    }
    if (node.streamRef !== undefined && !capabilities.dataPlane.streamReferences) {
      throw new AepError(
        AEP_ERROR_CODES.UNSUPPORTED_CAPABILITY,
        `Channel "${path}" uses streamRef while streamReferences capability is disabled`,
      );
    }
    return;
  }
  if (node.kind === "content" && node.binaryRef !== undefined && !capabilities.dataPlane.binaryReferences) {
    throw new AepError(
      AEP_ERROR_CODES.UNSUPPORTED_CAPABILITY,
      `Content node "${path}" uses binaryRef while binaryReferences capability is disabled`,
    );
  }
  if (node.children) {
    for (const child of node.children) {
      validateNodeCapabilities(child, capabilities, `${path}/${child.id}`);
    }
  }
}

export function validateBodyCapabilities(
  body: readonly BodyChild[],
  capabilities: CapabilitiesObject,
): void {
  for (const child of body) {
    validateNodeCapabilities(child, capabilities, `/${child.id}`);
  }
}

export function validateMountContainment(
  anchorKind: NodeKind | "body",
  target: BodyRoot | AepNode,
): void {
  if (target.kind === "body") {
    if (anchorKind === "body" || anchorKind === "ou") {
      return;
    }
    if (anchorKind === "interface") {
      const hasOu = target.children.some((child) => child.kind === "ou");
      if (!hasOu) {
        return;
      }
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        'Cannot mount a Body containing "ou" nodes under an "interface" anchor',
      );
    }
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `Cannot mount a downstream Body under anchor kind "${anchorKind}"`,
    );
  }

  if (!ALLOWED_CHILDREN[anchorKind].has(target.kind)) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `Cannot mount downstream node kind "${target.kind}" under anchor kind "${anchorKind}"`,
    );
  }
}
