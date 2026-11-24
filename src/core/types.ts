import type { AepErrorObject } from "./errors.js";

export const AEP_PROTOCOL_VERSION = "1.0.0-draft";

export const HEAD_KEYS = {
  PROTOCOL_VERSION: "aep.protocolVersion",
  SERVER_INFO: "aep.serverInfo",
  CAPABILITIES: "aep.capabilities",
  PROFILES: "aep.profiles",
  VOCABULARIES: "aep.vocabularies",
  SESSION: "aep.session",
  SECURITY: "aep.security",
  CLOCK: "aep.clock",
  ORIGIN_ID: "aep.originId",
  MOUNT_ORIGINS: "aep.mountOrigins",
} as const;

export const META_KEYS = {
  DESCRIPTION: "aep.description",
  ALT_TEXT: "aep.altText",
  LABELS: "aep.labels",
  BOUNDS: "aep.bounds",
  CAPTURE: "aep.capture",
  READONLY: "aep.readonly",
  DISABLED: "aep.disabled",
  MOUNT: "aep.mount",
} as const;

export type AepPrimitive = null | boolean | number | string;
export type AepValue = AepPrimitive | AepValue[] | { [key: string]: AepValue };
export type MetaMap = Record<string, AepValue>;
export type SchemaObject = Record<string, AepValue>;
export type Path = string;

export type NodeKind = "ou" | "interface" | "channel" | "structure" | "content" | "input";
export type Direction = "sense" | "act" | "duplex";
export type DeliveryMode = "stream" | "stream+seek";
export type TemporalState = "static" | "dynamic";
export type InvocationMode = "request-response" | "notification";
export type SideEffect = "none" | "read" | "write";
export type SeekUnit = "ms" | "seconds" | "frames" | "bytes" | "samples";
export type SessionRole = "controller" | "observer";
export type SessionPolicy = "single-controller" | "multi-controller" | "isolated";

export interface SeekSpec {
  seekable: boolean;
  unit?: SeekUnit;
  durationMs?: number;
  startOffset?: number;
  endOffset?: number;
}

export interface BinaryRef {
  refId: string;
  mediaType: string;
  sizeBytes?: number;
  meta?: MetaMap;
}

export interface StreamRef {
  refId: string;
  mediaType: string;
  frameRate?: number;
  sampleRate?: number;
  channelCount?: number;
  seek?: SeekSpec;
  meta?: MetaMap;
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
  coordSpace?: "pixel" | "normalized" | string;
}

export interface MethodDecl {
  name: string;
  description?: string;
  inputSchema?: SchemaObject;
  outputSchema?: SchemaObject;
  mode?: InvocationMode;
  sideEffects?: SideEffect;
  meta?: MetaMap;
}

export interface EventDecl {
  name: string;
  description?: string;
  payloadSchema?: SchemaObject;
  meta?: MetaMap;
}

export interface NodeHeader {
  id: string;
  kind: NodeKind;
  type?: string;
  meta?: MetaMap;
  methods?: MethodDecl[];
  events?: EventDecl[];
  hasChildren?: boolean;
}

export type OUChild = OUNode | InterfaceNode | ChannelNode;

export interface OUNode extends NodeHeader {
  kind: "ou";
  children?: OUChild[];
}

export type InterfaceChild = ElementNode | InterfaceNode | ChannelNode;

export interface InterfaceNode extends NodeHeader {
  kind: "interface";
  children?: InterfaceChild[];
}

export type StructureChild = ElementNode | InterfaceNode;

export interface StructureElementNode extends NodeHeader {
  kind: "structure";
  children?: StructureChild[];
}

export interface ContentElementNode extends NodeHeader {
  kind: "content";
  mediaType: string;
  temporalMode: TemporalState;
  value?: AepValue;
  binaryRef?: BinaryRef;
  channelRef?: Path;
  children?: ElementNode[];
}

export interface InputElementNode extends NodeHeader {
  kind: "input";
  mediaType: string;
  inputSchema?: SchemaObject;
  value?: AepValue;
  channelRef?: Path;
  children?: ElementNode[];
}

export type ElementNode = StructureElementNode | ContentElementNode | InputElementNode;

export interface ChannelNode extends NodeHeader {
  kind: "channel";
  mediaType: string;
  direction: Direction;
  deliveryMode: DeliveryMode;
  streamRef?: StreamRef;
  streamMeta?: MetaMap;
}

export type BodyChild = OUNode | InterfaceNode | ChannelNode;

export type AepNode =
  | OUNode
  | InterfaceNode
  | ChannelNode
  | StructureElementNode
  | ContentElementNode
  | InputElementNode;

export interface BodyRoot {
  path: "/";
  kind: "body";
  children: BodyChild[];
}

export type NodeOrBodyRoot = BodyRoot | AepNode;

export interface Root {
  head: MetaMap;
  body: BodyChild[];
}

export interface CapabilitiesObject {
  profile?: string;
  nodeKinds: NodeKind[];
  channelDirections: Direction[];
  deliveryModes: DeliveryMode[];
  queries?: {
    treeQuery?: boolean;
    loadChildren?: boolean;
  };
  passthrough?: {
    enabled: boolean;
    maxDepth?: number;
  };
  sessions?: {
    policy?: SessionPolicy;
    allowObserverStreams?: boolean;
  };
  dataPlane: {
    binaryReferences: boolean;
    streamReferences: boolean;
    seek: boolean;
    sample: boolean;
  };
  security: {
    mode: string;
    reserved?: boolean;
  };
  vocabularies?: string[];
}

export interface ServerInfo {
  name: string;
  version: string;
  description?: string;
}

export interface ClientInfo {
  name: string;
  version: string;
}

export interface SessionDescriptor {
  sessionId: string;
  role: SessionRole;
  policy: SessionPolicy;
}

export interface SecurityDescriptor {
  mode: string;
  reserved?: boolean;
  [key: string]: AepValue | undefined;
}

export interface RequestEnvelope {
  protocolVersion: string;
  kind: "request";
  id: string;
  method: string;
  params?: unknown;
}

export interface SuccessResponseEnvelope {
  protocolVersion: string;
  kind: "response";
  id: string;
  ok: true;
  result: unknown;
}

export interface ErrorResponseEnvelope {
  protocolVersion: string;
  kind: "response";
  id: string;
  ok: false;
  error: AepErrorObject;
}

export interface NotificationEnvelope {
  protocolVersion: string;
  kind: "notification";
  method: string;
  params?: unknown;
}

export type ControlEnvelope =
  | RequestEnvelope
  | SuccessResponseEnvelope
  | ErrorResponseEnvelope
  | NotificationEnvelope;

export interface SessionInitializeParams {
  clientInfo: ClientInfo;
  supportedVersions: string[];
  capabilities: Partial<CapabilitiesObject>;
  security?: SecurityDescriptor;
  session?: {
    role?: SessionRole;
    allowDowngradeToObserver?: boolean;
  };
}

export interface SessionInitializeResult {
  protocolVersion: string;
  serverInfo: ServerInfo;
  head: MetaMap;
  session: SessionDescriptor;
  security: SecurityDescriptor;
}

export interface SessionCloseParams {
  reason?: string;
}

export interface SessionCloseResult {
  closed: true;
}

export interface TreeGetParams {
  path?: Path;
  maxDepth?: number;
  includeHead?: boolean;
}

export interface TreeGetResult {
  head?: MetaMap;
  node: NodeOrBodyRoot;
}

export interface TreeQueryMetaFilter {
  key: string;
  value?: AepValue;
}

export interface TreeQueryParams {
  rootPath?: Path;
  kinds?: NodeKind[];
  types?: string[];
  meta?: TreeQueryMetaFilter[];
  hasMethod?: string;
  direction?: Direction;
  mediaTypePrefix?: string;
  textContains?: string;
  maxDepth?: number;
  cursor?: string;
  limit?: number;
}

export interface TreeQueryMatch {
  path: Path;
  node: AepNode;
  depth: number;
}

export interface TreeQueryResult {
  matches: TreeQueryMatch[];
  totalCount: number;
  nextCursor?: string;
}

export interface NodeGetParams {
  path: Path;
  maxDepth?: number;
}

export interface NodeGetResult {
  path: Path;
  node: AepNode;
}

export interface NodeLoadChildrenParams {
  path: Path;
  cursor?: string;
  limit?: number;
}

export interface NodeLoadChildrenResult {
  path: Path;
  children: AepNode[];
  hasMore?: boolean;
  nextCursor?: string;
}

export interface NodeInvokeParams {
  path: Path;
  method: string;
  params?: unknown;
}

export interface NodeInvokeResult<T = unknown> {
  path: Path;
  method: string;
  result: T;
}

export interface HeadUpdatedParams {
  head: MetaMap;
}

export interface NodeAddedParams {
  parentPath: Path;
  node: AepNode;
  index?: number;
}

export interface NodeUpdatedParams {
  path: Path;
  node: AepNode;
}

export interface NodeRemovedParams {
  path: Path;
}

export interface NodeEventParams {
  path: Path;
  event: string;
  timestamp: string;
  data?: unknown;
}

export interface GetBinaryOptions {
  region?: Region;
  format?: string;
  maxWidth?: number;
  maxHeight?: number;
  [key: string]: unknown;
}

export interface GetBinaryParams {
  refId: string;
  params?: GetBinaryOptions;
}

export interface GetBinaryResult {
  reference: BinaryRef;
  data: Uint8Array;
}

export interface ChannelOpenOptions {
  maxFps?: number;
  sampleRate?: number;
  startOffset?: number;
  unit?: SeekUnit;
  region?: Region;
  encoding?: string;
  [key: string]: unknown;
}

export interface ChannelOpenParams {
  path?: Path;
  refId?: string;
  params?: ChannelOpenOptions;
}

export interface ChannelOpenResult {
  subscriptionId: string;
  path?: Path;
  reference: StreamRef;
  direction: Direction;
}

export interface ChannelSendParams {
  subscriptionId: string;
  sequence?: number;
  timestamp?: string;
  mediaType?: string;
  data: Uint8Array;
  isFinal?: boolean;
}

export interface ChannelSendResult {
  accepted: boolean;
  sequence?: number;
}

export interface ChannelSeekParams {
  subscriptionId: string;
  offset: number;
  unit?: SeekUnit;
}

export interface ChannelSeekResult {
  subscriptionId: string;
  offset: number;
  unit?: SeekUnit;
}

export interface ChannelSampleParams {
  path?: Path;
  refId?: string;
  offset: number;
  unit?: SeekUnit;
  params?: Record<string, unknown>;
}

export interface ChannelSampleResult {
  reference: StreamRef;
  offset: number;
  unit?: SeekUnit;
  mediaType: string;
  timestamp?: string;
  data: Uint8Array;
}

export interface ChannelCloseParams {
  subscriptionId: string;
}

export interface ChannelCloseResult {
  closed: boolean;
  subscriptionId: string;
}

export interface ChannelChunkParams {
  subscriptionId: string;
  refId: string;
  sequence: number;
  timestamp: string;
  mediaType: string;
  offset?: number;
  data: Uint8Array;
  isFinal?: boolean;
}

export interface ChannelClosedParams {
  subscriptionId: string;
  refId: string;
  reason?: string;
}
