import { AEP_ERROR_CODES, AepError } from "./errors.js";
import { isValidNamespacedIdent, isValidPath, isValidSegment, parsePath } from "./path.js";
import type {
  AepNode,
  BodyChild,
  BodyRoot,
  CapabilitiesObject,
  ChannelNode,
  ElevationSpec,
  EventDecl,
  MethodDecl,
  NodeKind,
  Path,
} from "./types.js";

const ELEMENT_KINDS: readonly NodeKind[] = [
  "structure",
  "component",
  "document",
  "view",
  "editable",
  "control",
];

const VALID_NODE_KINDS = new Set<NodeKind>([
  "ou",
  "interface",
  "api",
  "endpoint",
  "channel",
  ...ELEMENT_KINDS,
]);

const ALLOWED_CHILDREN: Record<NodeKind | "body", ReadonlySet<NodeKind>> = {
  body: new Set<NodeKind>(["ou", "interface", "api", "channel"]),
  ou: new Set<NodeKind>(["ou", "interface", "api", "channel"]),
  interface: new Set<NodeKind>([...ELEMENT_KINDS, "interface", "channel"]),
  api: new Set<NodeKind>(["endpoint", "api", "channel"]),
  endpoint: new Set<NodeKind>(["endpoint", "channel"]),
  structure: new Set<NodeKind>([...ELEMENT_KINDS, "interface"]),
  component: new Set<NodeKind>([...ELEMENT_KINDS, "interface", "channel"]),
  document: new Set<NodeKind>([...ELEMENT_KINDS, "interface"]),
  view: new Set<NodeKind>(ELEMENT_KINDS),
  editable: new Set<NodeKind>(ELEMENT_KINDS),
  control: new Set<NodeKind>(ELEMENT_KINDS),
  channel: new Set<NodeKind>(),
};

const VALID_DIRECTIONS = new Set(["sense", "act", "duplex"]);
const VALID_DELIVERY_MODES = new Set(["stream", "stream+seek"]);
const VALID_PAYLOAD_MODES = new Set(["binary", "event"]);
const VALID_TEMPORAL_MODES = new Set(["static", "dynamic"]);
const VALID_ORIENTATIONS = new Set(["horizontal", "vertical"]);
const VALID_SEEK_UNITS = new Set(["ms", "seconds", "frames", "bytes", "samples", "events"]);
const VALID_INVOCATION_MODES = new Set(["request-response", "notification"]);
const VALID_SIDE_EFFECTS = new Set(["none", "read", "write"]);
const VALID_ELEVATION_LEVELS = new Set(["none", "confirm", "elevated", "admin"]);
const VALID_ALLOWED_FACTORS = new Set([
  "human-approval",
  "totp",
  "passkey",
  "token",
  "policy-attestation",
]);
const BOOLEAN_PROPERTY_KEYS = ["disabled", "readonly", "required", "editable", "modal"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateKeyValueMapKeys(
  map: unknown,
  fieldName: string,
  context: string,
): asserts map is Record<string, unknown> {
  if (!isPlainObject(map)) {
    throw new AepError(AEP_ERROR_CODES.INVALID_MESSAGE, `${context}.${fieldName} must be an object`);
  }
  for (const key of Object.keys(map)) {
    if (!isValidNamespacedIdent(key)) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `Invalid ${fieldName} key "${key}" in ${context}`,
      );
    }
  }
}

function validateMetaMap(meta: unknown, context: string): void {
  if (meta === undefined) {
    return;
  }
  validateKeyValueMapKeys(meta, "meta", context);
}

export function validateElevationSpec(spec: unknown, context: string): asserts spec is ElevationSpec {
  if (!isPlainObject(spec)) {
    throw new AepError(AEP_ERROR_CODES.INVALID_MESSAGE, `${context}.elevation must be an object`);
  }
  if (typeof spec["level"] !== "string" || !VALID_ELEVATION_LEVELS.has(spec["level"])) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `${context}.elevation.level is invalid: "${String(spec["level"])}"`,
    );
  }
  if (spec["scopes"] !== undefined) {
    if (!Array.isArray(spec["scopes"]) || spec["scopes"].some((s) => typeof s !== "string" || s.length === 0)) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `${context}.elevation.scopes must be an array of non-empty strings`,
      );
    }
  }
  if (spec["allowedFactors"] !== undefined) {
    if (
      !Array.isArray(spec["allowedFactors"]) ||
      spec["allowedFactors"].some((f) => typeof f !== "string" || !VALID_ALLOWED_FACTORS.has(f))
    ) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `${context}.elevation.allowedFactors contains an invalid factor`,
      );
    }
  }
  if (spec["requireReason"] !== undefined && typeof spec["requireReason"] !== "boolean") {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `${context}.elevation.requireReason must be a boolean`,
    );
  }
}

function validatePropertiesMap(properties: unknown, kind: NodeKind, context: string): void {
  if (properties === undefined) {
    return;
  }
  validateKeyValueMapKeys(properties, "properties", context);

  if (kind === "api" || kind === "endpoint") {
    if (properties["bounds"] !== undefined) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `${context} of kind "${kind}" MUST NOT set properties.bounds`,
      );
    }
    if (properties["capture"] !== undefined) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `${context} of kind "${kind}" MUST NOT set properties.capture`,
      );
    }
  }

  if (properties["elevation"] !== undefined) {
    validateElevationSpec(properties["elevation"], `${context}.properties`);
  }

  const temporalMode = properties["temporalMode"];
  if (
    temporalMode !== undefined &&
    (typeof temporalMode !== "string" || !VALID_TEMPORAL_MODES.has(temporalMode))
  ) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `${context}.properties.temporalMode is invalid: "${String(temporalMode)}"`,
    );
  }

  const mediaType = properties["mediaType"];
  if (mediaType !== undefined && (typeof mediaType !== "string" || mediaType.length === 0)) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `${context}.properties.mediaType must be a non-empty string`,
    );
  }

  const valueSchema = properties["valueSchema"];
  if (valueSchema !== undefined && !isPlainObject(valueSchema)) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `${context}.properties.valueSchema must be an object`,
    );
  }

  const orientation = properties["orientation"];
  if (
    orientation !== undefined &&
    (typeof orientation !== "string" || !VALID_ORIENTATIONS.has(orientation))
  ) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `${context}.properties.orientation is invalid: "${String(orientation)}"`,
    );
  }

  for (const key of BOOLEAN_PROPERTY_KEYS) {
    const val = properties[key];
    if (val !== undefined && typeof val !== "boolean") {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `${context}.properties.${key} must be a boolean`,
      );
    }
  }

  const bounds = properties["bounds"];
  if (bounds !== undefined) {
    if (
      !isPlainObject(bounds) ||
      typeof bounds["x"] !== "number" ||
      !Number.isFinite(bounds["x"]) ||
      typeof bounds["y"] !== "number" ||
      !Number.isFinite(bounds["y"]) ||
      typeof bounds["width"] !== "number" ||
      !Number.isFinite(bounds["width"]) ||
      bounds["width"] < 0 ||
      typeof bounds["height"] !== "number" ||
      !Number.isFinite(bounds["height"]) ||
      bounds["height"] < 0
    ) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `${context}.properties.bounds requires finite x, y, width >= 0, height >= 0`,
      );
    }
  }
}

function validateStateMap(state: unknown, kind: NodeKind, context: string): void {
  if (state === undefined) {
    return;
  }
  validateKeyValueMapKeys(state, "state", context);

  if (state["binaryRef"] !== undefined) {
    validateBinaryRef(state["binaryRef"], `${context}.state`);
  }

  const channelRef = state["channelRef"];
  if (channelRef !== undefined && (typeof channelRef !== "string" || !isValidPath(channelRef))) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_REFERENCE,
      `${context}.state has malformed channelRef "${String(channelRef)}"`,
    );
  }

  if (kind === "control" && state["value"] !== undefined) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `Control node "${context}" is strictly stateless and MUST NOT hold state.value`,
    );
  }

  if (kind === "view") {
    const bindingCount =
      (state["value"] !== undefined ? 1 : 0) +
      (state["binaryRef"] !== undefined ? 1 : 0) +
      (state["channelRef"] !== undefined ? 1 : 0);
    if (bindingCount > 1) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `View node "${context}" MUST specify at most one of state.value, state.binaryRef, or state.channelRef`,
      );
    }
  }
}

function validateTabularChild(
  parentKind: NodeKind | "body",
  parentType: string | undefined,
  childKind: NodeKind,
  childType: string | undefined,
  context: string,
): void {
  if (parentKind !== "structure") {
    return;
  }
  if (parentType === "table") {
    if (childKind !== "structure" || (childType !== "column" && childType !== "row")) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `Table node child "${context}" MUST have kind "structure" and type "column" or "row"`,
      );
    }
  } else if (parentType === "row") {
    if (childKind !== "structure" || childType !== "cell") {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `Table row child "${context}" MUST have kind "structure" and type "cell"`,
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
    if (method.elevation !== undefined) {
      validateElevationSpec(method.elevation, `${context}.methods[${i}]`);
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
  if (node.payloadMode !== undefined && !VALID_PAYLOAD_MODES.has(node.payloadMode)) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `Channel node "${context}" has invalid payloadMode "${String(node.payloadMode)}"`,
    );
  }
  if (node.eventSchema !== undefined && !isPlainObject(node.eventSchema)) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `Channel node "${context}" eventSchema must be an object`,
    );
  }
  if (node.streamRef !== undefined) {
    validateStreamRef(node.streamRef, context);
  }
}

export function validateNode(
  node: AepNode,
  parentKind: NodeKind | "body",
  ancestors: Set<object> = new Set<object>(),
  parentPath: Path = "/",
  parentType?: string,
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
  if (node.uid !== undefined && (typeof node.uid !== "string" || node.uid.length === 0)) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `NodeUid must be a non-empty string at "${nodePath}"`,
    );
  }
  if (
    node.revision !== undefined &&
    (typeof node.revision !== "number" || !Number.isInteger(node.revision) || node.revision < 0)
  ) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `Revision must be a non-negative integer at "${nodePath}"`,
    );
  }
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
  validateTabularChild(parentKind, parentType, node.kind, node.type, nodePath);

  if (node.hasChildren !== undefined && typeof node.hasChildren !== "boolean") {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      `hasChildren must be a boolean at "${nodePath}"`,
    );
  }

  validatePropertiesMap(node.properties, node.kind, nodePath);
  validateStateMap(node.state, node.kind, nodePath);
  validateMetaMap(node.meta, nodePath);
  validateMethodDecls(node.methods, nodePath);
  validateEventDecls(node.events, nodePath);

  if (node.kind === "channel") {
    validateChannelNode(node, nodePath);
    return;
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
      validateNode(child, node.kind, ancestors, nodePath, node.type);
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
      const channelRef = node.state?.channelRef;
      if (channelRef !== undefined) {
        if (typeof channelRef !== "string" || !isValidPath(channelRef)) {
          throw new AepError(
            AEP_ERROR_CODES.INVALID_REFERENCE,
            `Invalid channelRef "${String(channelRef)}" on "${nodePath}"`,
          );
        }
        const resolved = lookupPathWithLazyHint(body, channelRef);
        if (resolved.node) {
          if (resolved.node.kind !== "channel") {
            throw new AepError(
              AEP_ERROR_CODES.INVALID_REFERENCE,
              `channelRef "${channelRef}" on "${nodePath}" resolves to kind "${resolved.node.kind}" instead of "channel"`,
            );
          }
        } else if (strict || !resolved.coveredByLazyAncestor) {
          throw new AepError(
            AEP_ERROR_CODES.INVALID_REFERENCE,
            `channelRef "${channelRef}" on "${nodePath}" does not resolve to an existing channel`,
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

function validateUniqueUids(body: readonly BodyChild[]): void {
  const seen = new Set<string>();
  const walk = (nodes: readonly AepNode[], parentPath: Path): void => {
    for (const node of nodes) {
      const nodePath = parentPath === "/" ? `/${node.id}` : `${parentPath}/${node.id}`;
      if (node.uid !== undefined) {
        if (seen.has(node.uid)) {
          throw new AepError(
            AEP_ERROR_CODES.INVALID_MESSAGE,
            `Duplicate NodeUid "${node.uid}" at "${nodePath}"`,
          );
        }
        seen.add(node.uid);
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
  validateUniqueUids(body);
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
  if (node.state?.binaryRef !== undefined && !capabilities.dataPlane.binaryReferences) {
    throw new AepError(
      AEP_ERROR_CODES.UNSUPPORTED_CAPABILITY,
      `Node "${path}" uses state.binaryRef while binaryReferences capability is disabled`,
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
    const payloadMode = node.payloadMode ?? "binary";
    const allowedPayloadModes = capabilities.channelPayloadModes ?? ["binary"];
    if (!allowedPayloadModes.includes(payloadMode)) {
      throw new AepError(
        AEP_ERROR_CODES.UNSUPPORTED_CAPABILITY,
        `Channel "${path}" uses unsupported payloadMode "${payloadMode}"`,
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
  anchorType?: string,
): void {
  if (target.kind === "body") {
    if (anchorKind === "body" || anchorKind === "ou") {
      return;
    }
    if (anchorKind === "interface" || anchorKind === "component") {
      const hasDisallowed = target.children.some(
        (child) => child.kind === "ou" || child.kind === "api",
      );
      if (!hasDisallowed) {
        return;
      }
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `Cannot mount a Body containing "ou" or "api" nodes under a "${anchorKind}" anchor`,
      );
    }
    if (anchorKind === "api") {
      const hasDisallowed = target.children.some((child) => {
        const k = child.kind as NodeKind;
        return k !== "endpoint" && k !== "api" && k !== "channel";
      });
      if (!hasDisallowed) {
        return;
      }
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `Cannot mount a Body containing non-API nodes under an "api" anchor`,
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
  validateTabularChild(anchorKind, anchorType, target.kind, target.type, target.id);
}
