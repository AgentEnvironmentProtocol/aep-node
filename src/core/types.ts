import type { AepErrorObject } from "./errors.js";

export const AEP_PROTOCOL_VERSION = "1.0.0-beta.0";
export const AEP_SUPPORTED_PROTOCOL_VERSIONS = [AEP_PROTOCOL_VERSION] as const;
export const AEP_WEBSOCKET_SUBPROTOCOL = "aep.v1";

export interface UnsupportedVersionErrorData {
  supportedVersions: string[];
  requestedVersions?: string[];
  expectedVersion?: string;
  actualVersion?: string;
  [key: string]: AepValue | string[] | undefined;
}

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
  MOUNT: "aep.mount",
} as const;

export const PROPERTY_KEYS = {
  TITLE: "title",
  LABEL: "label",
  DESCRIPTION: "description",
  ALT_TEXT: "altText",
  BOUNDS: "bounds",
  CAPTURE: "capture",
  VERSION: "version",
  RATE_LIMIT: "rateLimit",
  ELEVATION: "elevation",
  DISABLED: "disabled",
  READONLY: "readonly",
  REQUIRED: "required",
  PLACEHOLDER: "placeholder",
  MEDIA_TYPE: "mediaType",
  TEMPORAL_MODE: "temporalMode",
  VALUE_SCHEMA: "valueSchema",
  EDITABLE: "editable",
  MODAL: "modal",
  ORIENTATION: "orientation",
  ROWS: "rows",
  COLUMNS: "columns",
  LABELS: "labels",
  LEVEL: "level",
} as const;

export const STATE_KEYS = {
  VALUE: "value",
  BINARY_REF: "binaryRef",
  CHANNEL_REF: "channelRef",
  FOCUSED: "focused",
  PRESSED: "pressed",
  VALID: "valid",
  VALIDATION_MESSAGE: "validationMessage",
  DIRTY: "dirty",
  EXPANDED: "expanded",
  SELECTED: "selected",
  WINDOW_STATE: "windowState",
  OPEN: "open",
  PLAYBACK_STATE: "playbackState",
  POSITION_MS: "positionMs",
  SELECTION: "selection",
  STATUS: "status",
} as const;

export const CORE_INTERFACE_TYPES = ["display", "window", "dialog", "page"] as const;
export type CoreInterfaceType = (typeof CORE_INTERFACE_TYPES)[number];

export const CORE_API_TYPES = [
  "service",
  "rest",
  "rpc",
  "graphql",
  "webhook",
  "toolset",
] as const;
export type CoreApiType = (typeof CORE_API_TYPES)[number];

export const CORE_ENDPOINT_TYPES = [
  "resource",
  "collection",
  "operation",
  "streamEndpoint",
  "webhookEndpoint",
] as const;
export type CoreEndpointType = (typeof CORE_ENDPOINT_TYPES)[number];

export const CORE_STRUCTURE_TYPES = [
  "form",
  "section",
  "stack",
  "grid",
  "table",
  "column",
  "row",
  "cell",
  "paragraph",
  "heading",
  "list",
  "listItem",
  "blockquote",
  "codeBlock",
] as const;
export type CoreStructureType = (typeof CORE_STRUCTURE_TYPES)[number];

export const CORE_VIEW_TYPES = [
  "text",
  "span",
  "label",
  "badge",
  "code",
  "image",
  "icon",
  "videoSurface",
  "audioOutput",
  "canvas",
  "progress",
] as const;
export type CoreViewType = (typeof CORE_VIEW_TYPES)[number];

export const CORE_EDITABLE_TYPES = [
  "textField",
  "textArea",
  "numberField",
  "passwordField",
  "searchField",
  "checkbox",
  "switch",
  "toggleButton",
  "radioGroup",
  "radio",
  "select",
  "comboBox",
  "slider",
  "rangeSlider",
  "dateField",
  "colorField",
  "voiceInput",
] as const;
export type CoreEditableType = (typeof CORE_EDITABLE_TYPES)[number];

export const CORE_CONTROL_TYPES = [
  "button",
  "iconButton",
  "menuItem",
  "link",
  "command",
  "toolbarButton",
] as const;
export type CoreControlType = (typeof CORE_CONTROL_TYPES)[number];

export const CORE_BUILTIN_TYPES = {
  interface: CORE_INTERFACE_TYPES,
  api: CORE_API_TYPES,
  endpoint: CORE_ENDPOINT_TYPES,
  structure: CORE_STRUCTURE_TYPES,
  view: CORE_VIEW_TYPES,
  editable: CORE_EDITABLE_TYPES,
  control: CORE_CONTROL_TYPES,
} as const;

export type AepPrimitive = null | boolean | number | string;
export type AepValue = AepPrimitive | AepValue[] | { [key: string]: AepValue };
export type MetaMap = Record<string, AepValue>;
export type PropertyMap = Record<string, AepValue>;
export type SchemaObject = Record<string, AepValue>;
export type Path = string;

export type NodeKind =
  | "ou"
  | "interface"
  | "api"
  | "endpoint"
  | "channel"
  | "structure"
  | "component"
  | "document"
  | "view"
  | "editable"
  | "control";
export type Direction = "sense" | "act" | "duplex";
export type DeliveryMode = "stream" | "stream+seek";
export type PayloadMode = "binary" | "event";
export type RenderMode = "renderMinimal" | "renderExpress" | "renderFull";
export type AuthMode =
  | "unauthenticated"
  | "mtls"
  | "os-peer"
  | "bearer"
  | "api-key"
  | "challenge-response";
export type ElevationLevel = "none" | "confirm" | "elevated" | "admin";
export type AllowedFactor =
  | "human-approval"
  | "totp"
  | "passkey"
  | "token"
  | "policy-attestation";
export type LeaseMode = "exclusive-write" | "shared-read";
export type ServiceStatus = "healthy" | "degraded" | "unavailable" | "rate-limited";
export type TemporalState = "static" | "dynamic";
export type Orientation = "horizontal" | "vertical";
export type WindowState = "normal" | "minimized" | "maximized" | "fullscreen";
export type PlaybackState = "idle" | "playing" | "paused" | "buffering" | "ended" | "error";
export type InvocationMode = "request-response" | "notification";
export type SideEffect = "none" | "read" | "write";
export type SeekUnit = "ms" | "seconds" | "frames" | "bytes" | "samples" | "events";
export type SessionRole = "controller" | "observer";
export type SessionPolicy = "single-controller" | "multi-controller" | "isolated";

export interface ElevationSpec {
  level: ElevationLevel;
  scopes?: string[];
  allowedFactors?: AllowedFactor[];
  requireReason?: boolean;
  [key: string]: AepValue | undefined;
}

export interface PrincipalDescriptor {
  id: string;
  kind: string;
  displayName?: string;
  scopes?: string[];
  [key: string]: AepValue | undefined;
}

export interface AuthChallenge {
  challengeId: string;
  algorithm: string;
  nonce: string;
  channelBinding?: string;
  expiresAt: string;
  [key: string]: AepValue | undefined;
}

export interface ElevationChallengeData {
  challengeId: string;
  targetPath: Path;
  operation: string;
  level: ElevationLevel;
  requiredScopes: string[];
  allowedFactors: AllowedFactor[];
  instructions: string;
  expiresAt: string;
  approvalEndpointPath?: Path;
  [key: string]: AepValue | undefined;
}

export interface ElevationGrantSummary {
  grantId: string;
  level: ElevationLevel;
  targetPath?: Path;
  scopes: string[];
  singleUse: boolean;
  expiresAt?: string;
}

export interface ElevationAuditRecord {
  timestamp: string;
  sessionId: string;
  principalId?: string;
  grantId?: string;
  challengeId?: string;
  targetPath?: Path;
  operation: string;
  level: ElevationLevel;
  scopes: string[];
  factorType?: AllowedFactor;
  reason?: string;
  outcome: "granted" | "pending" | "denied" | "executed" | "expired" | "revoked" | "dropped";
}

export interface ChannelEvent {
  name?: string;
  id?: string;
  payload: AepValue;
  headers?: Record<string, AepValue>;
}

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
  elevation?: ElevationSpec;
  meta?: MetaMap;
}

export interface EventDecl {
  name: string;
  description?: string;
  payloadSchema?: SchemaObject;
  meta?: MetaMap;
}

export interface CaptureDescriptor {
  binary: boolean;
  mediaType?: string;
  refId?: string;
  regionSupported?: boolean;
  modes?: RenderMode[];
  [key: string]: AepValue | undefined;
}

export interface SelectionState {
  start: number;
  end: number;
  anchorPath?: Path;
  focusPath?: Path;
  [key: string]: AepValue | undefined;
}

export interface NodeState {
  value?: AepValue;
  binaryRef?: BinaryRef;
  channelRef?: Path;
  focused?: boolean;
  pressed?: boolean;
  valid?: boolean;
  validationMessage?: string;
  dirty?: boolean;
  expanded?: boolean;
  selected?: boolean;
  windowState?: WindowState;
  open?: boolean;
  playbackState?: PlaybackState;
  positionMs?: number;
  selection?: SelectionState;
  status?: ServiceStatus;
  [key: string]: AepValue | BinaryRef | SelectionState | undefined;
}

export interface NodeHeader {
  id: string;
  uid?: string;
  kind: NodeKind;
  type?: string;
  revision?: number;
  properties?: PropertyMap;
  state?: NodeState;
  methods?: MethodDecl[];
  events?: EventDecl[];
  meta?: MetaMap;
  hasChildren?: boolean;
}

export type OUChild = OUNode | InterfaceNode | ApiNode | ChannelNode;

export interface OUNode extends NodeHeader {
  kind: "ou";
  children?: OUChild[];
}

export type InterfaceChild = ElementNode | InterfaceNode | ChannelNode;

export interface InterfaceNode extends NodeHeader {
  kind: "interface";
  children?: InterfaceChild[];
}

export type ApiChild = EndpointNode | ApiNode | ChannelNode;

export interface ApiNode extends NodeHeader {
  kind: "api";
  children?: ApiChild[];
}

export type EndpointChild = EndpointNode | ChannelNode;

export interface EndpointNode extends NodeHeader {
  kind: "endpoint";
  children?: EndpointChild[];
}

export type StructureChild = ElementNode | InterfaceNode;

export interface StructureElementNode extends NodeHeader {
  kind: "structure";
  children?: StructureChild[];
}

export type ComponentChild = ElementNode | InterfaceNode | ChannelNode;

export interface ComponentElementNode extends NodeHeader {
  kind: "component";
  children?: ComponentChild[];
}

export type DocumentChild = ElementNode | InterfaceNode;

export interface DocumentElementNode extends NodeHeader {
  kind: "document";
  children?: DocumentChild[];
}

export interface ViewElementNode extends NodeHeader {
  kind: "view";
  children?: ElementNode[];
}

export interface EditableElementNode extends NodeHeader {
  kind: "editable";
  children?: ElementNode[];
}

export interface ControlElementNode extends NodeHeader {
  kind: "control";
  children?: ElementNode[];
}

export type ElementNode =
  | StructureElementNode
  | ComponentElementNode
  | DocumentElementNode
  | ViewElementNode
  | EditableElementNode
  | ControlElementNode;

export interface ChannelNode extends NodeHeader {
  kind: "channel";
  mediaType: string;
  direction: Direction;
  deliveryMode: DeliveryMode;
  payloadMode?: PayloadMode;
  eventSchema?: SchemaObject;
  streamRef?: StreamRef;
}

export type BodyChild = OUNode | InterfaceNode | ApiNode | ChannelNode;

export type AepNode =
  | OUNode
  | InterfaceNode
  | ApiNode
  | EndpointNode
  | ChannelNode
  | StructureElementNode
  | ComponentElementNode
  | DocumentElementNode
  | ViewElementNode
  | EditableElementNode
  | ControlElementNode;

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
  channelPayloadModes?: PayloadMode[];
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
    leases?: boolean;
    optimisticConcurrency?: boolean;
  };
  resumption?: {
    enabled: boolean;
    replayWindowEvents?: number;
    sessionTtlMs?: number;
  };
  dataPlane: {
    binaryReferences: boolean;
    streamReferences: boolean;
    seek: boolean;
    sample: boolean;
  };
  rendering?: {
    serverModes?: RenderMode[];
    formats?: string[];
    pathAnnotations?: boolean;
  };
  security: {
    mode: string;
    supportedModes?: string[];
    elevation?: boolean;
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
  resumeToken?: string;
}

export interface SecurityDescriptor {
  mode: AuthMode | string;
  token?: string;
  apiKey?: string;
  keyId?: string;
  principal?: PrincipalDescriptor;
  sessionAuthenticated?: boolean;
  expiresAt?: string;
  elevation?: {
    activeGrants?: ElevationGrantSummary[];
  };
  reserved?: boolean;
  [key: string]:
    | AepValue
    | PrincipalDescriptor
    | { activeGrants?: ElevationGrantSummary[] }
    | undefined;
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
  seq?: number;
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
  authRequired?: boolean;
  challenge?: AuthChallenge;
  head?: MetaMap;
  session?: SessionDescriptor;
  security: SecurityDescriptor;
}

export interface SessionAuthenticateParams {
  mode: AuthMode | string;
  challengeId?: string;
  signature?: string;
  token?: string;
  apiKey?: string;
}

export interface SessionAuthenticateResult {
  authenticated: true;
  head?: MetaMap;
  session?: SessionDescriptor;
  security: SecurityDescriptor;
}

export interface SessionResumeParams {
  sessionId: string;
  resumeToken: string;
  lastControlSeq?: number;
  subscriptions?: Array<{
    subscriptionId: string;
    lastSequence?: number;
  }>;
}

export interface ResumedSubscriptionStatus {
  subscriptionId: string;
  status: "resumed" | "resync_required" | "closed";
}

export interface SessionResumeResult {
  resumed: true;
  sessionId: string;
  resumeToken: string;
  currentControlSeq: number;
  replayedCount: number;
  resyncRequired?: boolean;
  head?: MetaMap;
  subscriptions: ResumedSubscriptionStatus[];
}

export interface SessionAcquireLeaseParams {
  path: Path;
  uid?: string;
  leaseId?: string;
  mode?: LeaseMode;
  durationMs?: number;
  holderName?: string;
}

export interface SessionAcquireLeaseResult {
  leaseId: string;
  path: Path;
  uid?: string;
  mode: LeaseMode;
  expiresAt: string;
}

export interface SessionReleaseLeaseParams {
  leaseId: string;
}

export interface SessionReleaseLeaseResult {
  released: true;
  leaseId: string;
}

export interface SessionElevateParams {
  challengeId?: string;
  targetPath?: Path;
  scopes?: string[];
  level: ElevationLevel;
  reason: string;
  durationMs?: number;
  singleUse?: boolean;
  factor: {
    type: AllowedFactor;
    proof?: string | Record<string, AepValue>;
    waitForApproval?: boolean;
  };
}

export interface SessionElevateResult {
  grantId: string;
  status: "granted" | "pending" | "denied";
  level: ElevationLevel;
  targetPath?: Path;
  scopes: string[];
  singleUse: boolean;
  expiresAt?: string;
}

export interface SessionDropElevationParams {
  grantId?: string;
}

export interface SessionDropElevationResult {
  dropped: string[];
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

export interface TreeQueryKeyValueFilter {
  key: string;
  value?: AepValue;
}

export type TreeQueryMetaFilter = TreeQueryKeyValueFilter;

export interface TreeQueryParams {
  rootPath?: Path;
  uids?: string[];
  kinds?: NodeKind[];
  types?: string[];
  properties?: TreeQueryKeyValueFilter[];
  state?: TreeQueryKeyValueFilter[];
  meta?: TreeQueryKeyValueFilter[];
  hasMethod?: string;
  direction?: Direction;
  payloadMode?: PayloadMode;
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
  path?: Path;
  uid?: string;
  followMoves?: boolean;
  maxDepth?: number;
  grantId?: string;
}

export interface NodeGetResult {
  path: Path;
  resolvedPath?: Path;
  node: AepNode;
}

export interface NodeLoadChildrenParams {
  path?: Path;
  uid?: string;
  followMoves?: boolean;
  cursor?: string;
  limit?: number;
  grantId?: string;
}

export interface NodeLoadChildrenResult {
  path: Path;
  resolvedPath?: Path;
  children: AepNode[];
  hasMore?: boolean;
  nextCursor?: string;
}

export interface NodeInvokeParams {
  path?: Path;
  uid?: string;
  followMoves?: boolean;
  method: string;
  params?: unknown;
  expectedRevision?: number;
  leaseId?: string;
  grantId?: string;
}

export interface NodeInvokeResult<T = unknown> {
  path: Path;
  resolvedPath?: Path;
  method: string;
  revision?: number;
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

export interface NodeMovedParams {
  fromPath: Path;
  toPath: Path;
  uid?: string;
  node?: AepNode;
  index?: number;
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

export interface SessionAuthExpiringParams {
  expiresAt: string;
  remainingMs: number;
}

export interface SessionElevationUpdatedParams {
  grantId: string;
  challengeId?: string;
  status: "granted" | "denied" | "expired" | "revoked";
  expiresAt?: string;
  reason?: string;
}

export interface SessionLeaseUpdatedParams {
  leaseId: string;
  path: Path;
  uid?: string;
  status: "acquired" | "released" | "expired";
  holderSessionId: string;
  holderName?: string;
  expiresAt?: string;
}

export interface GetBinaryOptions {
  region?: Region;
  format?: string;
  maxWidth?: number;
  maxHeight?: number;
  mode?: RenderMode;
  annotatePaths?: boolean;
  [key: string]: unknown;
}

export interface GetBinaryParams {
  refId: string;
  grantId?: string;
  params?: GetBinaryOptions;
}

export interface GetBinaryResult {
  reference: BinaryRef;
  data: Uint8Array;
  pathMap?: Record<string, Path>;
}

export interface DataRenderOptions {
  format?: string;
  region?: Region;
  maxWidth?: number;
  maxHeight?: number;
  annotatePaths?: boolean;
  maxDepth?: number;
  [key: string]: unknown;
}

export interface DataRenderParams {
  path?: Path;
  uid?: string;
  followMoves?: boolean;
  mode: RenderMode;
  grantId?: string;
  params?: DataRenderOptions;
}

export interface DataRenderResult {
  path: Path;
  resolvedPath?: Path;
  mode: RenderMode;
  mediaType: string;
  reference?: BinaryRef;
  data: Uint8Array | string;
  pathMap?: Record<string, Path>;
}

export interface ChannelOpenOptions {
  maxFps?: number;
  sampleRate?: number;
  startOffset?: number;
  unit?: SeekUnit;
  region?: Region;
  encoding?: string;
  eventFilter?: {
    names?: string[];
  };
  [key: string]: unknown;
}

export interface ChannelOpenParams {
  path?: Path;
  uid?: string;
  followMoves?: boolean;
  refId?: string;
  leaseId?: string;
  grantId?: string;
  params?: ChannelOpenOptions;
}

export interface ChannelOpenResult {
  subscriptionId: string;
  path?: Path;
  resolvedPath?: Path;
  reference: StreamRef;
  direction: Direction;
  payloadMode?: PayloadMode;
}

export interface ChannelSendParams {
  subscriptionId: string;
  leaseId?: string;
  sequence?: number;
  timestamp?: string;
  mediaType?: string;
  data?: Uint8Array;
  event?: ChannelEvent;
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
  uid?: string;
  followMoves?: boolean;
  refId?: string;
  offset: number;
  unit?: SeekUnit;
  grantId?: string;
  params?: Record<string, unknown>;
}

export interface ChannelSampleResult {
  reference: StreamRef;
  resolvedPath?: Path;
  offset: number;
  unit?: SeekUnit;
  mediaType: string;
  timestamp?: string;
  data?: Uint8Array;
  event?: ChannelEvent;
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
  data?: Uint8Array;
  event?: ChannelEvent;
  isFinal?: boolean;
}

export interface ChannelClosedParams {
  subscriptionId: string;
  refId: string;
  reason?: string;
}
