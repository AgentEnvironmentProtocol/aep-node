import { AEP_ERROR_CODES, AepError } from "./errors.js";
import { isValidPath, parsePath } from "./path.js";
import type {
  AepNode,
  AepValue,
  BodyChild,
  BodyRoot,
  Path,
  TreeQueryKeyValueFilter,
  TreeQueryMatch,
  TreeQueryParams,
  TreeQueryResult,
} from "./types.js";

export function deepEqualValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (typeof a !== typeof b || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqualValue(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    const objA = a as Record<string, unknown>;
    const objB = b as Record<string, unknown>;
    const keysA = Object.keys(objA);
    const keysB = Object.keys(objB);
    if (keysA.length !== keysB.length) {
      return false;
    }
    for (const key of keysA) {
      if (!Object.prototype.hasOwnProperty.call(objB, key)) {
        return false;
      }
      if (!deepEqualValue(objA[key], objB[key])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

export function cloneNode<T extends AepNode>(node: T, maxDepth?: number): T {
  const copy: Record<string, unknown> = {
    id: node.id,
    kind: node.kind,
  };

  if (node.uid !== undefined) {
    copy["uid"] = node.uid;
  }
  if (node.type !== undefined) {
    copy["type"] = node.type;
  }
  if (node.revision !== undefined) {
    copy["revision"] = node.revision;
  }
  if (node.properties !== undefined) {
    copy["properties"] = structuredClone(node.properties);
  }
  if (node.state !== undefined) {
    copy["state"] = structuredClone(node.state);
  }
  if (node.methods !== undefined) {
    copy["methods"] = structuredClone(node.methods);
  }
  if (node.events !== undefined) {
    copy["events"] = structuredClone(node.events);
  }
  if (node.meta !== undefined) {
    copy["meta"] = structuredClone(node.meta);
  }

  if (node.kind === "channel") {
    copy["mediaType"] = node.mediaType;
    copy["direction"] = node.direction;
    copy["deliveryMode"] = node.deliveryMode;
    if (node.payloadMode !== undefined) {
      copy["payloadMode"] = node.payloadMode;
    }
    if (node.eventSchema !== undefined) {
      copy["eventSchema"] = structuredClone(node.eventSchema);
    }
    if (node.streamRef !== undefined) {
      copy["streamRef"] = structuredClone(node.streamRef);
    }
    return copy as T;
  }

  const hasExistingChildren = Array.isArray(node.children) && node.children.length > 0;
  if (maxDepth !== undefined && maxDepth <= 0) {
    if (node.hasChildren === true || hasExistingChildren) {
      copy["hasChildren"] = true;
    }
    return copy as T;
  }

  if (node.hasChildren !== undefined) {
    copy["hasChildren"] = node.hasChildren;
  }
  if (node.children !== undefined) {
    const nextDepth = maxDepth !== undefined ? maxDepth - 1 : undefined;
    copy["children"] = node.children.map((child) => cloneNode(child, nextDepth));
  }

  return copy as T;
}

export function cloneBodyRoot(children: readonly BodyChild[], maxDepth?: number): BodyRoot {
  if (maxDepth !== undefined && maxDepth <= 0) {
    return {
      path: "/",
      kind: "body",
      children: [],
    };
  }
  const childDepth = maxDepth !== undefined ? maxDepth - 1 : undefined;
  return {
    path: "/",
    kind: "body",
    children: children.map((child) => cloneNode(child, childDepth)),
  };
}

export function findNodeInChildren(children: readonly BodyChild[], path: Path): AepNode | undefined {
  const segments = parsePath(path);
  if (segments.length === 0) {
    return undefined;
  }
  let currentList: readonly AepNode[] = children;
  let current: AepNode | undefined;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!;
    current = currentList.find((node) => node.id === seg);
    if (!current) {
      return undefined;
    }
    if (i < segments.length - 1) {
      if (current.kind === "channel" || !current.children) {
        return undefined;
      }
      currentList = current.children;
    }
  }
  return current;
}

export function findNodeByUidInChildren(
  children: readonly BodyChild[],
  uid: string,
  basePath: Path = "/",
): { path: Path; node: AepNode } | undefined {
  const walk = (
    nodes: readonly AepNode[],
    parentPath: Path,
  ): { path: Path; node: AepNode } | undefined => {
    for (const node of nodes) {
      const nodePath = parentPath === "/" ? `/${node.id}` : `${parentPath}/${node.id}`;
      if (node.uid === uid) {
        return { path: nodePath, node };
      }
      if (node.kind !== "channel" && node.children) {
        const found = walk(node.children, nodePath);
        if (found) {
          return found;
        }
      }
    }
    return undefined;
  };
  return walk(children, basePath);
}

function matchesTypeTag(nodeType: string | undefined, patterns: readonly string[]): boolean {
  if (!nodeType) {
    return false;
  }
  for (const pattern of patterns) {
    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -1);
      if (nodeType.startsWith(prefix)) {
        return true;
      }
    } else if (nodeType === pattern) {
      return true;
    }
  }
  return false;
}

function collectStrings(value: AepValue | undefined, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, out);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const val of Object.values(value)) {
      collectStrings(val, out);
    }
  }
}

const TEXT_CONTAINS_PROPERTY_KEYS = ["title", "label", "description", "altText"] as const;

function matchesTextContains(node: AepNode, needleLower: string): boolean {
  const strings: string[] = [];
  if (node.properties) {
    for (const key of TEXT_CONTAINS_PROPERTY_KEYS) {
      const val = node.properties[key];
      if (typeof val === "string") {
        strings.push(val);
      }
    }
  }
  if (node.state?.value !== undefined) {
    collectStrings(node.state.value, strings);
  }
  if (node.meta) {
    collectStrings(node.meta, strings);
  }
  return strings.some((s) => s.toLowerCase().includes(needleLower));
}

function matchesKeyValueFilters(
  map: Record<string, unknown> | undefined,
  filters: readonly TreeQueryKeyValueFilter[],
): boolean {
  if (filters.length === 0) {
    return true;
  }
  if (!map) {
    return false;
  }
  for (const filter of filters) {
    if (!Object.prototype.hasOwnProperty.call(map, filter.key) || map[filter.key] === undefined) {
      return false;
    }
    if (filter.value !== undefined && !deepEqualValue(map[filter.key], filter.value)) {
      return false;
    }
  }
  return true;
}

export function matchesQueryPredicates(node: AepNode, params: TreeQueryParams): boolean {
  if (params.uids && (!node.uid || !params.uids.includes(node.uid))) {
    return false;
  }
  if (params.kinds && !params.kinds.includes(node.kind)) {
    return false;
  }
  if (params.types && !matchesTypeTag(node.type, params.types)) {
    return false;
  }
  if (params.properties && !matchesKeyValueFilters(node.properties, params.properties)) {
    return false;
  }
  if (params.state && !matchesKeyValueFilters(node.state, params.state)) {
    return false;
  }
  if (params.meta && !matchesKeyValueFilters(node.meta, params.meta)) {
    return false;
  }
  if (params.hasMethod !== undefined) {
    if (!node.methods || !node.methods.some((m) => m.name === params.hasMethod)) {
      return false;
    }
  }
  if (params.direction !== undefined) {
    if (node.kind !== "channel" || node.direction !== params.direction) {
      return false;
    }
  }
  if (params.payloadMode !== undefined) {
    if (node.kind !== "channel" || (node.payloadMode ?? "binary") !== params.payloadMode) {
      return false;
    }
  }
  if (params.mediaTypePrefix !== undefined) {
    const mediaType =
      node.kind === "channel"
        ? node.mediaType
        : typeof node.properties?.["mediaType"] === "string"
          ? node.properties["mediaType"]
          : undefined;
    if (!mediaType || !mediaType.startsWith(params.mediaTypePrefix)) {
      return false;
    }
  }
  if (params.textContains !== undefined) {
    if (!matchesTextContains(node, params.textContains.toLowerCase())) {
      return false;
    }
  }
  return true;
}

export function querySubtree(
  target: BodyRoot | AepNode,
  basePath: Path,
  params: TreeQueryParams,
): TreeQueryMatch[] {
  if (!isValidPath(basePath)) {
    throw new AepError(AEP_ERROR_CODES.INVALID_PATH, `Invalid query root path: "${basePath}"`);
  }
  if (params.maxDepth !== undefined && (!Number.isInteger(params.maxDepth) || params.maxDepth < 0)) {
    throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, "maxDepth must be a non-negative integer");
  }

  const matches: TreeQueryMatch[] = [];
  const visit = (node: AepNode, path: Path, depth: number): void => {
    if (params.maxDepth !== undefined && depth > params.maxDepth) {
      return;
    }
    if (matchesQueryPredicates(node, params)) {
      matches.push({
        path,
        node: cloneNode(node, 0),
        depth,
      });
    }
    if (params.maxDepth !== undefined && depth >= params.maxDepth) {
      return;
    }
    if (node.kind !== "channel" && node.children) {
      for (const child of node.children) {
        const childPath = path === "/" ? `/${child.id}` : `${path}/${child.id}`;
        visit(child, childPath, depth + 1);
      }
    }
  };

  if (target.kind === "body") {
    for (const child of target.children) {
      const childPath = basePath === "/" ? `/${child.id}` : `${basePath}/${child.id}`;
      visit(child, childPath, 1);
    }
  } else {
    visit(target, basePath, 0);
  }

  return matches;
}

export function paginateMatches(
  matches: readonly TreeQueryMatch[],
  cursor?: string,
  limit?: number,
): TreeQueryResult {
  let offset = 0;
  if (cursor !== undefined) {
    if (!/^\d+$/.test(cursor)) {
      throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, `Invalid pagination cursor: "${cursor}"`);
    }
    offset = Number(cursor);
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, "limit must be a positive integer");
  }

  const end = limit !== undefined ? offset + limit : undefined;
  const page = matches.slice(offset, end);
  const nextOffset = offset + page.length;
  const hasMore = limit !== undefined && nextOffset < matches.length;

  return {
    matches: page,
    totalCount: matches.length,
    ...(hasMore ? { nextCursor: String(nextOffset) } : {}),
  };
}
