import { AEP_ERROR_CODES, AepError } from "../core/errors.js";
import { isPathWithin, isValidNamespacedIdent, parsePath, splitParentPath } from "../core/path.js";
import {
  cloneBodyRoot,
  cloneNode,
  findNodeByUidInChildren,
  findNodeInChildren,
} from "../core/tree-utils.js";
import type {
  AepNode,
  BodyChild,
  BodyRoot,
  CapabilitiesObject,
  MetaMap,
  NodeKind,
  Path,
} from "../core/types.js";
import {
  validateBody,
  validateBodyCapabilities,
  validateNode,
  validateNodeCapabilities,
} from "../core/validation.js";

export interface MoveRecord {
  fromPath: Path;
  toPath: Path;
  uid?: string;
}

export class TreeStore {
  private head: MetaMap = {};
  private body: BodyChild[] = [];
  private readonly moveHistory = new Map<Path, MoveRecord>();

  constructor(
    initialHead: MetaMap = {},
    initialBody: readonly BodyChild[] = [],
    capabilities?: CapabilitiesObject,
  ) {
    this.replaceHead(initialHead);
    const clonedBody = initialBody.map((node) => cloneNode(node));
    validateBody(clonedBody);
    if (capabilities) {
      validateBodyCapabilities(clonedBody, capabilities);
    }
    this.body = clonedBody;
  }

  getHead(): MetaMap {
    return structuredClone(this.head);
  }

  setHead(patch: MetaMap): MetaMap {
    const next = structuredClone(this.head);
    for (const [key, value] of Object.entries(patch)) {
      if (!isValidNamespacedIdent(key)) {
        throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, `Invalid Head key "${key}"`);
      }
      if (value === undefined) {
        delete next[key];
      } else {
        next[key] = structuredClone(value);
      }
    }
    this.head = next;
    return this.getHead();
  }

  replaceHead(nextHead: MetaMap): MetaMap {
    const next: MetaMap = {};
    for (const [key, value] of Object.entries(nextHead)) {
      if (!isValidNamespacedIdent(key)) {
        throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, `Invalid Head key "${key}"`);
      }
      if (value !== undefined) {
        next[key] = structuredClone(value);
      }
    }
    this.head = next;
    return this.getHead();
  }

  getRawBody(): readonly BodyChild[] {
    return this.body;
  }

  findNode(path: Path): AepNode | undefined {
    const found = findNodeInChildren(this.body, path);
    return found ? cloneNode(found) : undefined;
  }

  findNodeInternal(path: Path): AepNode | undefined {
    return findNodeInChildren(this.body, path);
  }

  findNodeByUid(uid: string): { path: Path; node: AepNode } | undefined {
    const found = findNodeByUidInChildren(this.body, uid);
    return found ? { path: found.path, node: cloneNode(found.node) } : undefined;
  }

  findNodeByUidInternal(uid: string): { path: Path; node: AepNode } | undefined {
    return findNodeByUidInChildren(this.body, uid);
  }

  resolveMove(path: Path): MoveRecord | undefined {
    let current = path;
    const visited = new Set<Path>();
    let latest: MoveRecord | undefined;
    while (!visited.has(current)) {
      visited.add(current);
      const rec = this.moveHistory.get(current);
      if (!rec) {
        break;
      }
      latest = {
        fromPath: path,
        toPath: rec.toPath,
        ...(rec.uid !== undefined ? { uid: rec.uid } : {}),
      };
      current = rec.toPath;
    }
    if (latest && !this.findNodeInternal(latest.toPath) && latest.uid) {
      const byUid = this.findNodeByUidInternal(latest.uid);
      if (byUid) {
        return {
          fromPath: path,
          toPath: byUid.path,
          uid: latest.uid,
        };
      }
    }
    return latest;
  }

  private collectUids(node: AepNode, out: Set<string>): void {
    if (node.uid !== undefined) {
      if (out.has(node.uid)) {
        throw new AepError(
          AEP_ERROR_CODES.INVALID_MESSAGE,
          `Duplicate NodeUid "${node.uid}" within added/updated subtree`,
        );
      }
      out.add(node.uid);
    }
    if (node.kind !== "channel" && node.children) {
      for (const child of node.children) {
        this.collectUids(child, out);
      }
    }
  }

  private ensureUidsUnique(node: AepNode, ignoreSubtreePath?: Path): void {
    const incoming = new Set<string>();
    this.collectUids(node, incoming);
    if (incoming.size === 0) {
      return;
    }
    const walk = (nodes: readonly AepNode[], parentPath: Path): void => {
      for (const existing of nodes) {
        const currentPath = parentPath === "/" ? `/${existing.id}` : `${parentPath}/${existing.id}`;
        if (ignoreSubtreePath && isPathWithin(currentPath, ignoreSubtreePath)) {
          continue;
        }
        if (existing.uid !== undefined && incoming.has(existing.uid)) {
          throw new AepError(
            AEP_ERROR_CODES.INVALID_MESSAGE,
            `Duplicate NodeUid "${existing.uid}" already exists at "${currentPath}"`,
          );
        }
        if (existing.kind !== "channel" && existing.children) {
          walk(existing.children, currentPath);
        }
      }
    };
    walk(this.body, "/");
  }

  getNode(path: Path, maxDepth?: number): AepNode {
    if (path === "/") {
      throw new AepError(AEP_ERROR_CODES.INVALID_PATH, 'node.get cannot target root "/"');
    }
    parsePath(path);
    if (maxDepth !== undefined && (!Number.isInteger(maxDepth) || maxDepth < 0)) {
      throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, "maxDepth must be a non-negative integer");
    }
    const found = findNodeInChildren(this.body, path);
    if (!found) {
      const moved = this.resolveMove(path);
      if (moved) {
        throw new AepError(
          AEP_ERROR_CODES.NODE_MOVED,
          `Node at "${path}" moved to "${moved.toPath}"`,
          moved,
        );
      }
      throw new AepError(AEP_ERROR_CODES.NODE_NOT_FOUND, `Node not found at path "${path}"`);
    }
    return cloneNode(found, maxDepth);
  }

  getTree(path: Path = "/", maxDepth?: number): BodyRoot | AepNode {
    parsePath(path);
    if (maxDepth !== undefined && (!Number.isInteger(maxDepth) || maxDepth < 0)) {
      throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, "maxDepth must be a non-negative integer");
    }
    if (path === "/") {
      return cloneBodyRoot(this.body, maxDepth);
    }
    const found = findNodeInChildren(this.body, path);
    if (!found) {
      throw new AepError(AEP_ERROR_CODES.NODE_NOT_FOUND, `Node not found at path "${path}"`);
    }
    return cloneNode(found, maxDepth);
  }

  addNode(
    parentPath: Path,
    node: AepNode,
    index?: number,
    capabilities?: CapabilitiesObject,
  ): AepNode {
    parsePath(parentPath);
    const cloned = cloneNode(node);

    let parentKind: NodeKind | "body";
    let parentType: string | undefined;
    let targetList: AepNode[];
    const ancestors = new Set<object>();

    if (parentPath === "/") {
      parentKind = "body";
      targetList = this.body;
    } else {
      const parent = findNodeInChildren(this.body, parentPath);
      if (!parent) {
        throw new AepError(
          AEP_ERROR_CODES.NODE_NOT_FOUND,
          `Parent node not found at path "${parentPath}"`,
        );
      }
      parentKind = parent.kind;
      parentType = parent.type;
      ancestors.add(parent);
      if (parent.kind === "channel") {
        throw new AepError(
          AEP_ERROR_CODES.INVALID_MESSAGE,
          `Cannot add child to Channel node "${parentPath}"`,
        );
      }
      if (!parent.children) {
        parent.children = [];
      }
      targetList = parent.children;
    }

    validateNode(cloned, parentKind, ancestors, parentPath, parentType);
    if (targetList.some((sibling) => sibling.id === cloned.id)) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `Duplicate sibling NodeId "${cloned.id}" under "${parentPath}"`,
      );
    }
    this.ensureUidsUnique(cloned);
    if (capabilities) {
      const nodePath = parentPath === "/" ? `/${cloned.id}` : `${parentPath}/${cloned.id}`;
      validateNodeCapabilities(cloned, capabilities, nodePath);
    }

    if (index !== undefined) {
      if (!Number.isInteger(index) || index < 0 || index > targetList.length) {
        throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, `Invalid insertion index ${index}`);
      }
      targetList.splice(index, 0, cloned);
    } else {
      targetList.push(cloned);
    }

    const insertedPath = parentPath === "/" ? `/${cloned.id}` : `${parentPath}/${cloned.id}`;
    this.moveHistory.delete(insertedPath);
    return cloneNode(cloned);
  }

  updateNode(
    path: Path,
    updater: AepNode | ((prev: AepNode) => AepNode),
    capabilities?: CapabilitiesObject,
  ): AepNode {
    if (path === "/") {
      throw new AepError(AEP_ERROR_CODES.INVALID_PATH, 'Cannot update root "/" directly');
    }
    const { parentPath, id } = splitParentPath(path);

    let parentKind: NodeKind | "body";
    let parentType: string | undefined;
    let targetList: AepNode[];
    const ancestors = new Set<object>();

    if (parentPath === "/") {
      parentKind = "body";
      targetList = this.body;
    } else {
      const parent = findNodeInChildren(this.body, parentPath);
      if (!parent || parent.kind === "channel" || !parent.children) {
        throw new AepError(AEP_ERROR_CODES.NODE_NOT_FOUND, `Node not found at path "${path}"`);
      }
      parentKind = parent.kind;
      parentType = parent.type;
      ancestors.add(parent);
      targetList = parent.children;
    }

    const idx = targetList.findIndex((item) => item.id === id);
    if (idx === -1) {
      throw new AepError(AEP_ERROR_CODES.NODE_NOT_FOUND, `Node not found at path "${path}"`);
    }

    const existing = targetList[idx]!;
    const rawNext = typeof updater === "function" ? updater(cloneNode(existing)) : updater;
    const next = cloneNode(rawNext);
    if (next.id !== id) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `Updated node id "${next.id}" must match target path segment "${id}"`,
      );
    }
    if (existing.revision !== undefined && (next.revision === undefined || next.revision === existing.revision)) {
      next.revision = existing.revision + 1;
    }

    validateNode(next, parentKind, ancestors, parentPath, parentType);
    this.ensureUidsUnique(next, path);
    if (capabilities) {
      validateNodeCapabilities(next, capabilities, path);
    }

    targetList[idx] = next;
    return cloneNode(next);
  }

  moveNode(
    fromPath: Path,
    toPath: Path,
    index?: number,
    capabilities?: CapabilitiesObject,
  ): { node: AepNode; fromPath: Path; toPath: Path; uid?: string } {
    if (fromPath === "/" || toPath === "/") {
      throw new AepError(AEP_ERROR_CODES.INVALID_PATH, 'node.move cannot target root "/"');
    }
    parsePath(fromPath);
    parsePath(toPath);
    if (fromPath === toPath) {
      throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, `Source and destination path are identical: "${fromPath}"`);
    }
    if (isPathWithin(toPath, fromPath)) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        `Cannot move node "${fromPath}" into its own descendant "${toPath}"`,
      );
    }

    const { parentPath: srcParentPath, id: srcId } = splitParentPath(fromPath);
    let srcList: AepNode[];
    if (srcParentPath === "/") {
      srcList = this.body;
    } else {
      const srcParent = findNodeInChildren(this.body, srcParentPath);
      if (!srcParent || srcParent.kind === "channel" || !srcParent.children) {
        throw new AepError(AEP_ERROR_CODES.NODE_NOT_FOUND, `Node not found at path "${fromPath}"`);
      }
      srcList = srcParent.children;
    }
    const srcIdx = srcList.findIndex((item) => item.id === srcId);
    if (srcIdx === -1) {
      throw new AepError(AEP_ERROR_CODES.NODE_NOT_FOUND, `Node not found at path "${fromPath}"`);
    }
    const existing = srcList[srcIdx]!;

    const { parentPath: dstParentPath, id: dstId } = splitParentPath(toPath);
    let dstParentKind: NodeKind | "body";
    let dstParentType: string | undefined;
    let dstList: AepNode[];
    let dstParentRef: Exclude<AepNode, { kind: "channel" }> | undefined;
    const ancestors = new Set<object>();

    if (dstParentPath === "/") {
      dstParentKind = "body";
      dstList = this.body;
    } else {
      const dstParent = findNodeInChildren(this.body, dstParentPath);
      if (!dstParent) {
        throw new AepError(
          AEP_ERROR_CODES.NODE_NOT_FOUND,
          `Destination parent node not found at path "${dstParentPath}"`,
        );
      }
      if (dstParent.kind === "channel") {
        throw new AepError(
          AEP_ERROR_CODES.INVALID_MESSAGE,
          `Cannot move node into Channel "${dstParentPath}"`,
        );
      }
      dstParentRef = dstParent;
      dstParentKind = dstParent.kind;
      dstParentType = dstParent.type;
      ancestors.add(dstParent);
      if (!dstParent.children) {
        dstParent.children = [];
      }
      dstList = dstParent.children;
    }

    if (dstParentPath !== srcParentPath || dstId !== srcId) {
      if (dstList.some((sibling) => sibling.id === dstId)) {
        throw new AepError(
          AEP_ERROR_CODES.INVALID_MESSAGE,
          `Destination path "${toPath}" already exists`,
        );
      }
    }

    const movedCopy = cloneNode(existing);
    movedCopy.id = dstId;

    validateNode(movedCopy, dstParentKind, ancestors, dstParentPath, dstParentType);
    if (capabilities) {
      validateNodeCapabilities(movedCopy, capabilities, toPath);
    }

    srcList.splice(srcIdx, 1);
    const actualDstList = (dstParentRef ? (dstParentRef.children ??= []) : this.body) as AepNode[];
    if (index !== undefined) {
      if (!Number.isInteger(index) || index < 0 || index > actualDstList.length) {
        srcList.splice(srcIdx, 0, existing);
        throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, `Invalid insertion index ${index}`);
      }
      actualDstList.splice(index, 0, movedCopy);
    } else {
      actualDstList.push(movedCopy);
    }

    this.moveHistory.set(fromPath, {
      fromPath,
      toPath,
      ...(movedCopy.uid !== undefined ? { uid: movedCopy.uid } : {}),
    });
    this.moveHistory.delete(toPath);

    return {
      node: cloneNode(movedCopy),
      fromPath,
      toPath,
      ...(movedCopy.uid !== undefined ? { uid: movedCopy.uid } : {}),
    };
  }

  removeNode(path: Path): AepNode {
    if (path === "/") {
      throw new AepError(AEP_ERROR_CODES.INVALID_PATH, 'Cannot remove root "/"');
    }
    const { parentPath, id } = splitParentPath(path);

    let targetList: AepNode[];
    if (parentPath === "/") {
      targetList = this.body;
    } else {
      const parent = findNodeInChildren(this.body, parentPath);
      if (!parent || parent.kind === "channel" || !parent.children) {
        throw new AepError(AEP_ERROR_CODES.NODE_NOT_FOUND, `Node not found at path "${path}"`);
      }
      targetList = parent.children;
    }

    const idx = targetList.findIndex((item) => item.id === id);
    if (idx === -1) {
      throw new AepError(AEP_ERROR_CODES.NODE_NOT_FOUND, `Node not found at path "${path}"`);
    }
    const [removed] = targetList.splice(idx, 1);
    this.moveHistory.delete(path);
    return cloneNode(removed!);
  }
}
