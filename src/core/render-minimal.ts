import { AEP_ERROR_CODES, AepError } from "./errors.js";
import type { AepNode, DataRenderOptions, DataRenderResult, Path } from "./types.js";

const NON_VISUAL_KINDS = new Set(["ou", "api", "endpoint", "channel"]);

interface LayoutBox {
  node: AepNode;
  path: Path;
  depth: number;
  x: number;
  y: number;
  width: number;
  height: number;
  marker?: string;
  children: LayoutBox[];
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function truncateText(value: string, maxLen: number): string {
  if (value.length <= maxLen) {
    return value;
  }
  if (maxLen <= 1) {
    return value.slice(0, maxLen);
  }
  return `${value.slice(0, maxLen - 1)}…`;
}

function formatStateValue(node: AepNode): string {
  if (node.kind === "editable" && node.type === "passwordField") {
    if (node.state?.value !== undefined && node.state.value !== "") {
      return "••••";
    }
    return "";
  }
  const val = node.state?.value;
  if (val === undefined || val === null) {
    return "";
  }
  if (typeof val === "string") {
    return val;
  }
  if (typeof val === "number" || typeof val === "boolean") {
    return String(val);
  }
  return JSON.stringify(val);
}

function isAnnotatedTarget(node: AepNode, isRoot: boolean): boolean {
  if (isRoot) {
    return false;
  }
  if (node.kind === "editable" || node.kind === "control" || node.kind === "component" || node.kind === "interface") {
    return true;
  }
  if (node.kind === "view" && (node.state?.channelRef !== undefined || node.state?.binaryRef !== undefined)) {
    return true;
  }
  return false;
}

function readBounds(node: AepNode): { x: number; y: number; width: number; height: number } | null {
  const b = node.properties?.["bounds"];
  if (
    typeof b === "object" &&
    b !== null &&
    !Array.isArray(b) &&
    typeof (b as Record<string, unknown>)["x"] === "number" &&
    typeof (b as Record<string, unknown>)["y"] === "number" &&
    typeof (b as Record<string, unknown>)["width"] === "number" &&
    typeof (b as Record<string, unknown>)["height"] === "number"
  ) {
    const rec = b as Record<string, number>;
    return {
      x: rec["x"]!,
      y: rec["y"]!,
      width: rec["width"]!,
      height: rec["height"]!,
    };
  }
  return null;
}

function isContainerKind(node: AepNode): boolean {
  return (
    node.kind === "interface" ||
    node.kind === "structure" ||
    node.kind === "component" ||
    node.kind === "document"
  );
}

function getHeaderHeight(node: AepNode): number {
  if (node.kind === "interface" || node.kind === "component" || node.kind === "document") {
    return 24;
  }
  if (
    node.kind === "structure" &&
    (node.type === "form" || node.type === "section" || node.type === "table")
  ) {
    return 22;
  }
  return 0;
}

function isHorizontalContainer(node: AepNode): boolean {
  if (node.kind !== "structure") {
    return false;
  }
  if (node.type === "stack" && node.properties?.["orientation"] === "horizontal") {
    return true;
  }
  if (node.type === "row") {
    return true;
  }
  return false;
}

function layoutTree(
  node: AepNode,
  path: Path,
  depth: number,
  x: number,
  y: number,
  availWidth: number,
  maxDepth: number | undefined,
  annotatePaths: boolean,
  pathMap: Record<string, Path>,
  counter: { next: number },
  isRoot: boolean,
): LayoutBox {
  const explicitBounds = readBounds(node);
  const boxX = explicitBounds ? explicitBounds.x : x;
  const boxY = explicitBounds ? explicitBounds.y : y;
  const boxWidth = explicitBounds ? Math.max(40, explicitBounds.width) : availWidth;

  let marker: string | undefined;
  if (annotatePaths && isAnnotatedTarget(node, isRoot)) {
    marker = `#${counter.next++}`;
    pathMap[marker] = path;
  }

  const rawChildren =
    node.kind === "channel" ||
    !node.children ||
    (maxDepth !== undefined && depth >= maxDepth)
      ? []
      : node.children.filter((c) => !NON_VISUAL_KINDS.has(c.kind));

  if (rawChildren.length === 0) {
    const defaultHeight = isContainerKind(node) ? 44 : 32;
    return {
      node,
      path,
      depth,
      x: boxX,
      y: boxY,
      width: boxWidth,
      height: explicitBounds ? Math.max(24, explicitBounds.height) : defaultHeight,
      ...(marker !== undefined ? { marker } : {}),
      children: [],
    };
  }

  const pad = 8;
  const gap = 6;
  const headerH = getHeaderHeight(node);
  const innerX = boxX + pad;
  let cursorY = boxY + headerH + pad;
  const innerWidth = Math.max(40, boxWidth - pad * 2);
  const childBoxes: LayoutBox[] = [];

  if (isHorizontalContainer(node)) {
    const cols = rawChildren.length;
    const cellW = Math.max(40, Math.floor((innerWidth - gap * (cols - 1)) / cols));
    let maxRowH = 0;
    for (let i = 0; i < rawChildren.length; i += 1) {
      const child = rawChildren[i]!;
      const childPath = `${path}/${child.id}`;
      const childBox = layoutTree(
        child,
        childPath,
        depth + 1,
        innerX + i * (cellW + gap),
        cursorY,
        cellW,
        maxDepth,
        annotatePaths,
        pathMap,
        counter,
        false,
      );
      childBoxes.push(childBox);
      if (childBox.height > maxRowH) {
        maxRowH = childBox.height;
      }
    }
    cursorY += maxRowH + pad;
  } else if (node.kind === "structure" && node.type === "grid") {
    const rawCols = node.properties?.["columns"];
    const cols =
      typeof rawCols === "number" && Number.isInteger(rawCols) && rawCols > 0
        ? rawCols
        : Array.isArray(rawCols) && rawCols.length > 0
          ? rawCols.length
          : 2;
    const cellW = Math.max(40, Math.floor((innerWidth - gap * (cols - 1)) / cols));
    for (let i = 0; i < rawChildren.length; i += cols) {
      const rowSlice = rawChildren.slice(i, i + cols);
      let rowH = 0;
      for (let colIdx = 0; colIdx < rowSlice.length; colIdx += 1) {
        const child = rowSlice[colIdx]!;
        const childPath = `${path}/${child.id}`;
        const childBox = layoutTree(
          child,
          childPath,
          depth + 1,
          innerX + colIdx * (cellW + gap),
          cursorY,
          cellW,
          maxDepth,
          annotatePaths,
          pathMap,
          counter,
          false,
        );
        childBoxes.push(childBox);
        if (childBox.height > rowH) {
          rowH = childBox.height;
        }
      }
      cursorY += rowH + gap;
    }
    cursorY += pad - gap;
  } else {
    for (const child of rawChildren) {
      const childPath = `${path}/${child.id}`;
      const childBox = layoutTree(
        child,
        childPath,
        depth + 1,
        innerX,
        cursorY,
        innerWidth,
        maxDepth,
        annotatePaths,
        pathMap,
        counter,
        false,
      );
      childBoxes.push(childBox);
      cursorY += childBox.height + gap;
    }
    cursorY += pad - gap;
  }

  let computedHeight = Math.max(40, cursorY - boxY);
  if (explicitBounds) {
    computedHeight = Math.max(explicitBounds.height, computedHeight);
  }
  for (const childBox of childBoxes) {
    const childBottom = childBox.y + childBox.height + pad;
    if (childBottom - boxY > computedHeight) {
      computedHeight = childBottom - boxY;
    }
  }

  return {
    node,
    path,
    depth,
    x: boxX,
    y: boxY,
    width: boxWidth,
    height: computedHeight,
    ...(marker !== undefined ? { marker } : {}),
    children: childBoxes,
  };
}

function getBoxBounds(root: LayoutBox): { maxX: number; maxY: number } {
  let maxX = root.x + root.width;
  let maxY = root.y + root.height;
  for (const child of root.children) {
    const b = getBoxBounds(child);
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  }
  return { maxX, maxY };
}

function scaleBoxes(box: LayoutBox, sx: number, sy: number): void {
  box.x = Math.round(box.x * sx);
  box.y = Math.round(box.y * sy);
  box.width = Math.max(20, Math.round(box.width * sx));
  box.height = Math.max(16, Math.round(box.height * sy));
  for (const child of box.children) {
    scaleBoxes(child, sx, sy);
  }
}

function describePrimitiveLabel(box: LayoutBox): string {
  const { node, marker } = box;
  const markerPrefix = marker ? `[${marker}] ` : "";
  const titleProp =
    typeof node.properties?.["title"] === "string" ? node.properties["title"] : undefined;
  const labelProp =
    typeof node.properties?.["label"] === "string" ? node.properties["label"] : undefined;
  const altProp =
    typeof node.properties?.["altText"] === "string" ? node.properties["altText"] : undefined;
  const placeholder =
    typeof node.properties?.["placeholder"] === "string" ? node.properties["placeholder"] : undefined;

  if (node.kind === "view") {
    if (node.type === "image") {
      return `${markerPrefix}[IMAGE: ${altProp ?? node.id}]`;
    }
    if (node.type === "icon") {
      return `${markerPrefix}[ICON: ${altProp ?? node.id}]`;
    }
    if (node.type === "videoSurface") {
      return `${markerPrefix}[VIDEO: ${node.state?.channelRef ?? altProp ?? node.id}]`;
    }
    if (node.type === "canvas") {
      return `${markerPrefix}[CANVAS: ${altProp ?? node.id}]`;
    }
    if (node.type === "audioOutput") {
      return `${markerPrefix}[AUDIO: ${node.state?.channelRef ?? altProp ?? node.id}]`;
    }
    const textVal = formatStateValue(node);
    const display = textVal || labelProp || node.id;
    return `${markerPrefix}${truncateText(display, 48)}`;
  }

  if (node.kind === "editable") {
    const val = formatStateValue(node);
    const label = labelProp ?? node.id;
    const shown = val ? val : placeholder ? `(${placeholder})` : "";
    return `${markerPrefix}${label}: ${truncateText(shown, 40)}`;
  }

  if (node.kind === "control") {
    const label = labelProp ?? node.id;
    return `${markerPrefix}[ ${label} ]`;
  }

  const headerTitle = titleProp ?? labelProp ?? node.id;
  const typeSuffix = node.type ? ` (${node.type})` : ` (${node.kind})`;
  return `${markerPrefix}${headerTitle}${typeSuffix}`;
}

function renderSvgBox(box: LayoutBox, out: string[]): void {
  const { node, x, y, width, height, path } = box;
  const pathAttr = ` data-aep-path="${escapeXml(path)}" data-aep-kind="${escapeXml(node.kind)}"`;
  const disabled = node.properties?.["disabled"] === true;
  const focused = node.state?.focused === true;
  const invalid = node.state?.valid === false;

  let stroke = "#64748b";
  let fill = "#ffffff";
  let strokeDash = "";
  let strokeWidth = 1;

  if (node.kind === "interface" || node.kind === "component" || node.kind === "document") {
    stroke = "#334155";
    fill = "#f8fafc";
    strokeWidth = 1.5;
  } else if (node.kind === "structure") {
    stroke = "#94a3b8";
    fill = "#f1f5f9";
    strokeDash = ' stroke-dasharray="4 2"';
  } else if (node.kind === "editable") {
    stroke = invalid ? "#dc2626" : focused ? "#2563eb" : "#475569";
    strokeWidth = focused || invalid ? 2 : 1;
    fill = disabled ? "#e2e8f0" : "#ffffff";
  } else if (node.kind === "control") {
    stroke = disabled ? "#94a3b8" : "#1d4ed8";
    fill = disabled ? "#e2e8f0" : "#eff6ff";
  } else if (node.kind === "view") {
    stroke = "#cbd5e1";
    fill = "#ffffff";
  }

  const rx = node.kind === "control" ? 6 : 2;
  out.push(
    `<g${pathAttr}><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"${strokeDash}/>`,
  );

  const labelText = describePrimitiveLabel(box);
  const headerH = getHeaderHeight(node);
  if (headerH > 0 && box.children.length > 0) {
    out.push(
      `<rect x="${x}" y="${y}" width="${width}" height="${headerH}" fill="#e2e8f0" stroke="${stroke}" stroke-width="1"/>`,
    );
    out.push(
      `<text x="${x + 6}" y="${y + 16}" font-family="monospace" font-size="11" fill="#0f172a">${escapeXml(labelText)}</text>`,
    );
  } else {
    const isMediaPlaceholder =
      node.kind === "view" &&
      (node.type === "image" ||
        node.type === "icon" ||
        node.type === "videoSurface" ||
        node.type === "canvas");
    if (isMediaPlaceholder) {
      out.push(
        `<line x1="${x}" y1="${y}" x2="${x + width}" y2="${y + height}" stroke="#cbd5e1" stroke-width="1"/>`,
        `<line x1="${x + width}" y1="${y}" x2="${x}" y2="${y + height}" stroke="#cbd5e1" stroke-width="1"/>`,
      );
    }
    const textFill = disabled ? "#64748b" : "#0f172a";
    out.push(
      `<text x="${x + 8}" y="${y + Math.min(height - 6, 20)}" font-family="monospace" font-size="11" fill="${textFill}">${escapeXml(labelText)}</text>`,
    );
  }

  for (const child of box.children) {
    renderSvgBox(child, out);
  }
  out.push("</g>");
}

function renderAsciiBox(box: LayoutBox, indent: number, out: string[]): void {
  const prefix = "  ".repeat(indent);
  const label = describePrimitiveLabel(box);
  const flags: string[] = [];
  if (box.node.properties?.["disabled"] === true) flags.push("disabled");
  if (box.node.state?.focused === true) flags.push("focused");
  if (box.node.state?.valid === false) flags.push("invalid");
  const flagStr = flags.length > 0 ? ` {${flags.join(",")}}` : "";
  out.push(`${prefix}+- ${label}${flagStr}`);
  for (const child of box.children) {
    renderAsciiBox(child, indent + 1, out);
  }
}

export function synthesizeRenderMinimal(
  node: AepNode,
  rootPath: Path,
  options?: DataRenderOptions,
): DataRenderResult {
  if (NON_VISUAL_KINDS.has(node.kind)) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_PARAMS,
      `data.render cannot target non-visual node kind "${node.kind}" at "${rootPath}"`,
    );
  }

  const format = options?.format ?? "image/svg+xml";
  if (format !== "image/svg+xml" && format !== "text/x-aep-layout") {
    throw new AepError(
      AEP_ERROR_CODES.UNSUPPORTED_CAPABILITY,
      `renderMinimal synthesizer does not support format "${format}"`,
    );
  }

  const annotatePaths = options?.annotatePaths === true;
  const pathMap: Record<string, Path> = {};
  const counter = { next: 1 };

  const rootWidth = options?.maxWidth && options.maxWidth > 0 ? Math.min(640, options.maxWidth) : 640;
  const layout = layoutTree(
    node,
    rootPath,
    0,
    8,
    8,
    rootWidth - 16,
    options?.maxDepth,
    annotatePaths,
    pathMap,
    counter,
    true,
  );

  const bounds = getBoxBounds(layout);
  const totalW = Math.max(100, bounds.maxX + 8);
  const totalH = Math.max(60, bounds.maxY + 8);

  let finalW = totalW;
  let finalH = totalH;
  if (options?.maxWidth || options?.maxHeight) {
    const sx = options.maxWidth && totalW > options.maxWidth ? options.maxWidth / totalW : 1;
    const sy = options.maxHeight && totalH > options.maxHeight ? options.maxHeight / totalH : 1;
    const scale = Math.min(sx, sy);
    if (scale < 1) {
      scaleBoxes(layout, scale, scale);
      finalW = Math.max(40, Math.round(totalW * scale));
      finalH = Math.max(40, Math.round(totalH * scale));
    }
  }

  let data: string;
  if (format === "text/x-aep-layout") {
    const lines: string[] = [];
    renderAsciiBox(layout, 0, lines);
    data = lines.join("\n");
  } else {
    const parts: string[] = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${finalW}" height="${finalH}" viewBox="0 0 ${finalW} ${finalH}">`,
      `<rect x="0" y="0" width="${finalW}" height="${finalH}" fill="#ffffff"/>`,
    ];
    renderSvgBox(layout, parts);
    parts.push("</svg>");
    data = parts.join("");
  }

  return {
    path: rootPath,
    mode: "renderMinimal",
    mediaType: format,
    data,
    ...(annotatePaths ? { pathMap } : {}),
  };
}
