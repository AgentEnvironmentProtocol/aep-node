import {
  AEP_PROTOCOL_VERSION,
  HEAD_KEYS,
  type CapabilitiesObject,
  type ControlEnvelope,
  type MetaMap,
} from "./types.js";

const SEMVER_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const NUMERIC_IDENT_REGEX = /^(0|[1-9]\d*)$/;

export interface ParsedProtocolVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  build: string[];
}

export interface ProtocolVersionAdapter {
  /** Target wire protocolVersion handled by this adapter (e.g., "1.0.0-draft" or "1.1.0"). */
  readonly version: string;
  /** Canonical runtime version this adapter bridges to (defaults to AEP_PROTOCOL_VERSION). */
  readonly targetVersion?: string;
  /** Optional transformation of outbound ControlEnvelope (canonical -> wire version). */
  encodeEnvelope?: (envelope: ControlEnvelope) => ControlEnvelope;
  /** Optional transformation of inbound ControlEnvelope (wire version -> canonical). */
  decodeEnvelope?: (envelope: ControlEnvelope) => ControlEnvelope;
  /** Optional capability adaptation when negotiating with a peer on this version. */
  adaptCapabilities?: (capabilities: CapabilitiesObject) => CapabilitiesObject;
  /** Optional Head metadata adaptation. */
  adaptHead?: (head: MetaMap) => MetaMap;
}

export interface VersionNegotiationOptions {
  supportedVersions?: readonly string[];
  adapters?: readonly ProtocolVersionAdapter[];
  allowCompatibleMinor?: boolean;
}

export interface VersionNegotiationResult {
  selectedVersion: string;
  adapter?: ProtocolVersionAdapter;
  matchKind: "exact" | "adapter" | "semver-minor";
}

export function parseProtocolVersion(version: string): ParsedProtocolVersion | null {
  if (typeof version !== "string") {
    return null;
  }
  const match = SEMVER_REGEX.exec(version.trim());
  if (!match) {
    return null;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const prerelease = match[4] ? match[4].split(".") : [];
  const build = match[5] ? match[5].split(".") : [];
  return {
    raw: version.trim(),
    major,
    minor,
    patch,
    prerelease,
    build,
  };
}

export function isValidProtocolVersion(version: string): boolean {
  return parseProtocolVersion(version) !== null;
}

export function compareProtocolVersions(a: string, b: string): number {
  const pa = parseProtocolVersion(a);
  const pb = parseProtocolVersion(b);
  if (!pa || !pb) {
    return a.localeCompare(b);
  }
  if (pa.major !== pb.major) {
    return pa.major - pb.major;
  }
  if (pa.minor !== pb.minor) {
    return pa.minor - pb.minor;
  }
  if (pa.patch !== pb.patch) {
    return pa.patch - pb.patch;
  }
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) {
    return 0;
  }
  if (pa.prerelease.length === 0) {
    return 1;
  }
  if (pb.prerelease.length === 0) {
    return -1;
  }

  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    const idA = pa.prerelease[i];
    const idB = pb.prerelease[i];
    if (idA === undefined) {
      return -1;
    }
    if (idB === undefined) {
      return 1;
    }
    if (idA === idB) {
      continue;
    }
    const numA = NUMERIC_IDENT_REGEX.test(idA);
    const numB = NUMERIC_IDENT_REGEX.test(idB);
    if (numA && numB) {
      return Number(idA) - Number(idB);
    }
    if (numA) {
      return -1;
    }
    if (numB) {
      return 1;
    }
    return idA < idB ? -1 : 1;
  }
  return 0;
}

/**
 * Checks SemVer compatibility per AEP Spec 06 §1.1:
 * - Identical normalized `major.minor.patch[-prerelease]` always matches.
 * - Pre-release versions (`prerelease.length > 0`) and `0.x` versions are isolated
 *   and never implicitly match across distinct identifiers.
 * - Stable releases (`major >= 1`, no prerelease) sharing the same `major` are compatible.
 */
export function areVersionsSemverCompatible(a: string, b: string): boolean {
  const pa = parseProtocolVersion(a);
  const pb = parseProtocolVersion(b);
  if (!pa || !pb) {
    return a === b;
  }
  if (
    pa.major === pb.major &&
    pa.minor === pb.minor &&
    pa.patch === pb.patch &&
    pa.prerelease.join(".") === pb.prerelease.join(".")
  ) {
    return true;
  }
  if (pa.prerelease.length > 0 || pb.prerelease.length > 0) {
    return false;
  }
  if (pa.major === 0 || pb.major === 0) {
    return false;
  }
  return pa.major === pb.major;
}

export function selectCompatibleBaselineVersion(a: string, b: string): string {
  return compareProtocolVersions(a, b) <= 0 ? a : b;
}

export function buildSupportedVersionList(
  supportedVersions?: readonly string[],
  adapters?: readonly ProtocolVersionAdapter[],
): string[] {
  const base =
    supportedVersions && supportedVersions.length > 0
      ? [...supportedVersions]
      : [AEP_PROTOCOL_VERSION];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const v of base) {
    if (typeof v === "string" && v.length > 0 && !seen.has(v)) {
      seen.add(v);
      result.push(v);
    }
  }
  if (adapters) {
    for (const adapter of adapters) {
      if (adapter.version && !seen.has(adapter.version)) {
        seen.add(adapter.version);
        result.push(adapter.version);
      }
    }
  }
  return result;
}

export function negotiateProtocolVersion(
  clientSupportedVersions: readonly string[],
  serverOptions: VersionNegotiationOptions = {},
): VersionNegotiationResult | null {
  if (!Array.isArray(clientSupportedVersions) || clientSupportedVersions.length === 0) {
    return null;
  }

  const adapterMap = new Map<string, ProtocolVersionAdapter>();
  if (serverOptions.adapters) {
    for (const adapter of serverOptions.adapters) {
      adapterMap.set(adapter.version, adapter);
    }
  }

  const serverVersions = buildSupportedVersionList(
    serverOptions.supportedVersions,
    serverOptions.adapters,
  );
  const serverVersionSet = new Set(serverVersions);

  // Pass 1: exact / adapter match in client preference order
  for (const clientVer of clientSupportedVersions) {
    if (serverVersionSet.has(clientVer)) {
      const adapter = adapterMap.get(clientVer);
      return {
        selectedVersion: clientVer,
        ...(adapter !== undefined ? { adapter } : {}),
        matchKind: adapter ? "adapter" : "exact",
      };
    }
  }

  // Pass 2: stable MAJOR >= 1 SemVer compatible-minor fallback
  if (serverOptions.allowCompatibleMinor !== false) {
    for (const clientVer of clientSupportedVersions) {
      const pc = parseProtocolVersion(clientVer);
      if (!pc || pc.major < 1 || pc.prerelease.length > 0) {
        continue;
      }
      let bestMatch: string | undefined;
      for (const serverVer of serverVersions) {
        const ps = parseProtocolVersion(serverVer);
        if (!ps || ps.major < 1 || ps.prerelease.length > 0) {
          continue;
        }
        if (areVersionsSemverCompatible(clientVer, serverVer)) {
          const baseline = selectCompatibleBaselineVersion(clientVer, serverVer);
          if (!bestMatch || compareProtocolVersions(baseline, bestMatch) > 0) {
            bestMatch = baseline;
          }
        }
      }
      if (bestMatch) {
        const adapter = adapterMap.get(bestMatch);
        return {
          selectedVersion: bestMatch,
          ...(adapter !== undefined ? { adapter } : {}),
          matchKind: "semver-minor",
        };
      }
    }
  }

  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rewriteHeadProtocolVersionInPayload(payload: unknown, version: string): unknown {
  if (!isPlainObject(payload)) {
    return payload;
  }
  const head = payload["head"];
  if (!isPlainObject(head)) {
    return payload;
  }
  return {
    ...payload,
    head: {
      ...head,
      [HEAD_KEYS.PROTOCOL_VERSION]: version,
    },
  };
}

/**
 * Creates a zero-boilerplate ProtocolVersionAdapter for bridging a legacy or
 * alternate protocolVersion (such as "1.0.0-draft" or a future pre-release)
 * to the canonical runtime protocol version.
 */
export function createLegacyVersionAliasAdapter(
  legacyVersion: string,
  overrides: Partial<Omit<ProtocolVersionAdapter, "version">> = {},
): ProtocolVersionAdapter {
  const targetVersion = overrides.targetVersion ?? AEP_PROTOCOL_VERSION;

  return {
    version: legacyVersion,
    targetVersion,
    encodeEnvelope: (envelope: ControlEnvelope): ControlEnvelope => {
      let next: ControlEnvelope = {
        ...envelope,
        protocolVersion: legacyVersion,
      };
      if (next.kind === "response" && next.ok === true && isPlainObject(next.result)) {
        next = {
          ...next,
          result: rewriteHeadProtocolVersionInPayload(next.result, legacyVersion),
        };
      } else if (next.kind === "notification" && next.method === "head.updated") {
        next = {
          ...next,
          params: rewriteHeadProtocolVersionInPayload(next.params, legacyVersion),
        };
      }
      return overrides.encodeEnvelope ? overrides.encodeEnvelope(next) : next;
    },
    decodeEnvelope: (envelope: ControlEnvelope): ControlEnvelope => {
      let next: ControlEnvelope = {
        ...envelope,
        protocolVersion: targetVersion,
      };
      if (overrides.decodeEnvelope) {
        next = overrides.decodeEnvelope(next);
      }
      return next;
    },
    ...(overrides.adaptCapabilities ? { adaptCapabilities: overrides.adaptCapabilities } : {}),
    adaptHead: (head: MetaMap): MetaMap => {
      const next: MetaMap = {
        ...head,
        [HEAD_KEYS.PROTOCOL_VERSION]: legacyVersion,
      };
      return overrides.adaptHead ? overrides.adaptHead(next) : next;
    },
  };
}
