import { AEP_ERROR_CODES, AepError } from "../core/errors.js";
import type { ControlEnvelope } from "../core/types.js";
import type { Codec } from "./types.js";

const FRAME_MAGIC_CONTROL_JSON = 0x01;
const FRAME_MAGIC_BINARY_CARRIER = 0x02;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toUint8Array(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

function isBinaryReferenceResult(result: unknown): result is Record<string, unknown> {
  if (!isPlainObject(result)) {
    return false;
  }
  const ref = result["reference"];
  return (
    isPlainObject(ref) &&
    typeof ref["refId"] === "string" &&
    typeof ref["mediaType"] === "string" &&
    Object.prototype.hasOwnProperty.call(result, "data")
  );
}

function isBinaryRenderResult(result: unknown): result is Record<string, unknown> {
  if (!isPlainObject(result)) {
    return false;
  }
  return (
    typeof result["mode"] === "string" &&
    typeof result["mediaType"] === "string" &&
    Object.prototype.hasOwnProperty.call(result, "data") &&
    !result["mediaType"].startsWith("text/") &&
    result["mediaType"] !== "image/svg+xml"
  );
}

export function validateControlEnvelope(value: unknown): ControlEnvelope {
  if (!isPlainObject(value)) {
    throw new AepError(AEP_ERROR_CODES.INVALID_MESSAGE, "Envelope must be an object");
  }
  if (typeof value["protocolVersion"] !== "string" || value["protocolVersion"].length === 0) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_MESSAGE,
      "Envelope missing required protocolVersion string",
    );
  }
  const kind = value["kind"];
  if (kind === "request") {
    if (typeof value["id"] !== "string" || value["id"].length === 0) {
      throw new AepError(AEP_ERROR_CODES.INVALID_MESSAGE, "Request envelope missing id");
    }
    if (typeof value["method"] !== "string" || value["method"].length === 0) {
      throw new AepError(AEP_ERROR_CODES.INVALID_MESSAGE, "Request envelope missing method");
    }
    return value as unknown as ControlEnvelope;
  }
  if (kind === "response") {
    if (typeof value["id"] !== "string" || value["id"].length === 0) {
      throw new AepError(AEP_ERROR_CODES.INVALID_MESSAGE, "Response envelope missing id");
    }
    if (typeof value["ok"] !== "boolean") {
      throw new AepError(AEP_ERROR_CODES.INVALID_MESSAGE, "Response envelope missing boolean ok");
    }
    if (value["ok"] === false && !AepError.isAepErrorObject(value["error"])) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        "Error response envelope missing valid error object",
      );
    }
    return value as unknown as ControlEnvelope;
  }
  if (kind === "notification") {
    if (typeof value["method"] !== "string" || value["method"].length === 0) {
      throw new AepError(AEP_ERROR_CODES.INVALID_MESSAGE, "Notification envelope missing method");
    }
    if (
      value["seq"] !== undefined &&
      (typeof value["seq"] !== "number" || !Number.isInteger(value["seq"]) || value["seq"] < 0)
    ) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_MESSAGE,
        "Notification envelope seq must be a non-negative integer",
      );
    }
    return value as unknown as ControlEnvelope;
  }
  throw new AepError(
    AEP_ERROR_CODES.INVALID_MESSAGE,
    `Invalid envelope kind "${String(kind)}"`,
  );
}

interface ExtractedBinaryPayload {
  headerEnvelope: ControlEnvelope;
  bytes: Uint8Array;
}

function extractBinaryCarrier(envelope: ControlEnvelope): ExtractedBinaryPayload | null {
  if (
    (envelope.kind === "request" && envelope.method === "channel.send") ||
    (envelope.kind === "notification" && envelope.method === "channel.chunk")
  ) {
    if (isPlainObject(envelope.params)) {
      const bytes = toUint8Array(envelope.params["data"]);
      if (bytes) {
        const paramsCopy: Record<string, unknown> = { ...envelope.params };
        delete paramsCopy["data"];
        return {
          headerEnvelope: { ...envelope, params: paramsCopy },
          bytes,
        };
      }
    }
    return null;
  }

  if (
    envelope.kind === "response" &&
    envelope.ok === true &&
    isPlainObject(envelope.result) &&
    (isBinaryReferenceResult(envelope.result) || isBinaryRenderResult(envelope.result))
  ) {
    const bytes = toUint8Array(envelope.result["data"]);
    if (bytes) {
      const resultCopy: Record<string, unknown> = { ...envelope.result };
      delete resultCopy["data"];
      return {
        headerEnvelope: { ...envelope, result: resultCopy },
        bytes,
      };
    }
  }

  return null;
}

function decodeBase64(encoded: string): Uint8Array {
  const buf = Buffer.from(encoded, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function restoreBinaryCarrier(envelope: ControlEnvelope, bytes: Uint8Array): ControlEnvelope {
  if (
    (envelope.kind === "request" && envelope.method === "channel.send") ||
    (envelope.kind === "notification" && envelope.method === "channel.chunk")
  ) {
    if (!isPlainObject(envelope.params)) {
      throw new AepError(AEP_ERROR_CODES.INVALID_MESSAGE, `${envelope.method} missing params`);
    }
    return {
      ...envelope,
      params: {
        ...envelope.params,
        data: bytes,
      },
    };
  }
  if (envelope.kind === "response" && envelope.ok === true && isPlainObject(envelope.result)) {
    return {
      ...envelope,
      result: {
        ...envelope.result,
        data: bytes,
      },
    };
  }
  throw new AepError(
    AEP_ERROR_CODES.INVALID_MESSAGE,
    "Binary carrier frame does not target a valid Data-Plane payload envelope",
  );
}

export class JsonTextCodec implements Codec {
  readonly name = "json";
  readonly supportsBinary = false;

  encode(envelope: ControlEnvelope): string {
    const extracted = extractBinaryCarrier(envelope);
    if (!extracted) {
      return JSON.stringify(envelope);
    }
    const base64 = encodeBase64(extracted.bytes);
    if (extracted.headerEnvelope.kind === "response" && extracted.headerEnvelope.ok === true) {
      const result = extracted.headerEnvelope.result as Record<string, unknown>;
      return JSON.stringify({
        ...extracted.headerEnvelope,
        result: { ...result, data: base64 },
      });
    }
    const msg = extracted.headerEnvelope as { params: Record<string, unknown> };
    return JSON.stringify({
      ...extracted.headerEnvelope,
      params: { ...msg.params, data: base64 },
    });
  }

  decode(frame: Uint8Array | string): ControlEnvelope {
    let text: string;
    if (typeof frame === "string") {
      text = frame;
    } else if (frame instanceof Uint8Array) {
      try {
        text = textDecoder.decode(frame);
      } catch (err) {
        throw new AepError(AEP_ERROR_CODES.PARSE_ERROR, "Invalid UTF-8 in JSON frame", err);
      }
    } else {
      throw new AepError(AEP_ERROR_CODES.PARSE_ERROR, "Unsupported frame type for JsonTextCodec");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new AepError(
        AEP_ERROR_CODES.PARSE_ERROR,
        `Malformed JSON frame: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const envelope = validateControlEnvelope(parsed);
    if (
      (envelope.kind === "request" && envelope.method === "channel.send") ||
      (envelope.kind === "notification" && envelope.method === "channel.chunk")
    ) {
      if (isPlainObject(envelope.params) && typeof envelope.params["data"] === "string") {
        return {
          ...envelope,
          params: {
            ...envelope.params,
            data: decodeBase64(envelope.params["data"]),
          },
        };
      }
    } else if (
      envelope.kind === "response" &&
      envelope.ok === true &&
      isPlainObject(envelope.result) &&
      (isBinaryReferenceResult(envelope.result) || isBinaryRenderResult(envelope.result)) &&
      typeof envelope.result["data"] === "string"
    ) {
      return {
        ...envelope,
        result: {
          ...envelope.result,
          data: decodeBase64(envelope.result["data"]),
        },
      };
    }

    return envelope;
  }
}

export class BinaryEnvelopeCodec implements Codec {
  readonly name = "aep-binary-v1";
  readonly supportsBinary = true;

  encode(envelope: ControlEnvelope): Uint8Array {
    const extracted = extractBinaryCarrier(envelope);
    if (!extracted) {
      const jsonBytes = textEncoder.encode(JSON.stringify(envelope));
      const frame = new Uint8Array(1 + jsonBytes.byteLength);
      frame[0] = FRAME_MAGIC_CONTROL_JSON;
      frame.set(jsonBytes, 1);
      return frame;
    }

    const headerBytes = textEncoder.encode(JSON.stringify(extracted.headerEnvelope));
    const frame = new Uint8Array(1 + 4 + headerBytes.byteLength + extracted.bytes.byteLength);
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    frame[0] = FRAME_MAGIC_BINARY_CARRIER;
    view.setUint32(1, headerBytes.byteLength, false);
    frame.set(headerBytes, 5);
    frame.set(extracted.bytes, 5 + headerBytes.byteLength);
    return frame;
  }

  decode(frame: Uint8Array | string): ControlEnvelope {
    if (!(frame instanceof Uint8Array)) {
      throw new AepError(
        AEP_ERROR_CODES.PARSE_ERROR,
        "BinaryEnvelopeCodec requires a Uint8Array frame",
      );
    }
    if (frame.byteLength < 2) {
      throw new AepError(AEP_ERROR_CODES.PARSE_ERROR, "Truncated AEP binary frame");
    }
    const magic = frame[0];
    if (magic === FRAME_MAGIC_CONTROL_JSON) {
      let jsonStr: string;
      let parsed: unknown;
      try {
        jsonStr = textDecoder.decode(frame.subarray(1));
        parsed = JSON.parse(jsonStr);
      } catch (err) {
        throw new AepError(
          AEP_ERROR_CODES.PARSE_ERROR,
          `Malformed AEP binary control frame: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return validateControlEnvelope(parsed);
    }

    if (magic === FRAME_MAGIC_BINARY_CARRIER) {
      if (frame.byteLength < 5) {
        throw new AepError(AEP_ERROR_CODES.PARSE_ERROR, "Truncated AEP binary carrier header length");
      }
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      const headerLength = view.getUint32(1, false);
      if (frame.byteLength < 5 + headerLength) {
        throw new AepError(AEP_ERROR_CODES.PARSE_ERROR, "Truncated AEP binary carrier header");
      }
      let parsed: unknown;
      try {
        const headerStr = textDecoder.decode(frame.subarray(5, 5 + headerLength));
        parsed = JSON.parse(headerStr);
      } catch (err) {
        throw new AepError(
          AEP_ERROR_CODES.PARSE_ERROR,
          `Malformed AEP binary carrier header JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const headerEnvelope = validateControlEnvelope(parsed);
      const payloadCopy = new Uint8Array(frame.subarray(5 + headerLength));
      return restoreBinaryCarrier(headerEnvelope, payloadCopy);
    }

    throw new AepError(
      AEP_ERROR_CODES.PARSE_ERROR,
      `Unknown AEP binary frame magic byte: 0x${(magic ?? 0).toString(16)}`,
    );
  }
}

export const defaultJsonCodec = new JsonTextCodec();
export const defaultBinaryCodec = new BinaryEnvelopeCodec();
