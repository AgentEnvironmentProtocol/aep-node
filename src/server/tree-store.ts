import { AEP_ERROR_CODES, AepError } from "../core/errors.js";
import { isValidNamespacedIdent, parsePath, splitParentPath } from "../core/path.js";
import {
  cloneBodyRoot,
  cloneNode,
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

export class TreeStore {
  private head: MetaMap = {};
  private body: BodyChild[] = [];

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

    validateNode(next, parentKind, ancestors, parentPath, parentType);
    if (capabilities) {
      validateNodeCapabilities(next, capabilities, path);
    }

    targetList[idx] = next;
    return cloneNode(next);
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
    return cloneNode(removed!);
  }
}
