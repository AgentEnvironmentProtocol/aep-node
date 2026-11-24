import { AEP_ERROR_CODES, AepError } from "./errors.js";
import type { Path } from "./types.js";

const SEGMENT_REGEX = /^[A-Za-z0-9._-]+$/;

export function isValidSegment(segment: string): boolean {
  return (
    typeof segment === "string" &&
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    SEGMENT_REGEX.test(segment)
  );
}

export function isValidNamespacedIdent(ident: string): boolean {
  if (typeof ident !== "string" || ident.length === 0) {
    return false;
  }
  const parts = ident.split(".");
  return parts.length > 0 && parts.every((part) => isValidSegment(part));
}

export function isValidPath(path: string): boolean {
  if (typeof path !== "string") {
    return false;
  }
  if (path === "/") {
    return true;
  }
  if (!path.startsWith("/") || path.endsWith("/")) {
    return false;
  }
  const segments = path.slice(1).split("/");
  return segments.length > 0 && segments.every((segment) => isValidSegment(segment));
}

export function parsePath(path: string): string[] {
  if (!isValidPath(path)) {
    throw new AepError(AEP_ERROR_CODES.INVALID_PATH, `Invalid AEP path: "${String(path)}"`);
  }
  if (path === "/") {
    return [];
  }
  return path.slice(1).split("/");
}

export function formatPath(segments: readonly string[]): Path {
  if (segments.length === 0) {
    return "/";
  }
  for (const segment of segments) {
    if (!isValidSegment(segment)) {
      throw new AepError(AEP_ERROR_CODES.INVALID_PATH, `Invalid AEP path segment: "${String(segment)}"`);
    }
  }
  return `/${segments.join("/")}`;
}

export function joinPath(base: Path, childOrSubpath: string): Path {
  const baseSegments = parsePath(base);
  if (childOrSubpath === "/") {
    return formatPath(baseSegments);
  }
  if (typeof childOrSubpath !== "string" || childOrSubpath.length === 0 || childOrSubpath.endsWith("/")) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_PATH,
      `Invalid AEP subpath to join: "${String(childOrSubpath)}"`,
    );
  }
  const normalized = childOrSubpath.startsWith("/") ? childOrSubpath.slice(1) : childOrSubpath;
  const subSegments = normalized.split("/");
  for (const segment of subSegments) {
    if (!isValidSegment(segment)) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PATH,
        `Invalid AEP path segment in subpath: "${String(childOrSubpath)}"`,
      );
    }
  }
  return formatPath([...baseSegments, ...subSegments]);
}

export function splitParentPath(path: Path): { parentPath: Path; id: string } {
  const segments = parsePath(path);
  if (segments.length === 0) {
    throw new AepError(AEP_ERROR_CODES.INVALID_PATH, 'Root path "/" does not have a parent path');
  }
  const id = segments[segments.length - 1]!;
  const parentPath = formatPath(segments.slice(0, -1));
  return { parentPath, id };
}

export function isPathWithin(targetPath: Path, prefixPath: Path): boolean {
  parsePath(targetPath);
  parsePath(prefixPath);
  if (prefixPath === "/") {
    return true;
  }
  return targetPath === prefixPath || targetPath.startsWith(`${prefixPath}/`);
}

export function stripPathPrefix(targetPath: Path, prefixPath: Path): Path {
  if (!isPathWithin(targetPath, prefixPath)) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_PATH,
      `Path "${targetPath}" is not within prefix "${prefixPath}"`,
    );
  }
  if (prefixPath === "/") {
    return targetPath;
  }
  if (targetPath === prefixPath) {
    return "/";
  }
  return targetPath.slice(prefixPath.length);
}

export function rebasePath(path: Path, fromPrefix: Path, toPrefix: Path): Path | null {
  parsePath(toPrefix);
  if (!isPathWithin(path, fromPrefix)) {
    return null;
  }
  const relative = stripPathPrefix(path, fromPrefix);
  return joinPath(toPrefix, relative);
}
