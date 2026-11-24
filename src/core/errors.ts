export const AEP_ERROR_CODES = {
  PARSE_ERROR: "PARSE_ERROR",
  INVALID_MESSAGE: "INVALID_MESSAGE",
  METHOD_NOT_FOUND: "METHOD_NOT_FOUND",
  INVALID_PARAMS: "INVALID_PARAMS",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  NOT_INITIALIZED: "NOT_INITIALIZED",
  UNSUPPORTED_VERSION: "UNSUPPORTED_VERSION",
  UNSUPPORTED_CAPABILITY: "UNSUPPORTED_CAPABILITY",
  UNSUPPORTED_AUTH_MODE: "UNSUPPORTED_AUTH_MODE",
  NODE_NOT_FOUND: "NODE_NOT_FOUND",
  INVALID_PATH: "INVALID_PATH",
  INVALID_REFERENCE: "INVALID_REFERENCE",
  BINARY_NOT_FOUND: "BINARY_NOT_FOUND",
  CHANNEL_NOT_FOUND: "CHANNEL_NOT_FOUND",
  DIRECTION_MISMATCH: "DIRECTION_MISMATCH",
  READ_ONLY_SESSION: "READ_ONLY_SESSION",
  CONTROLLER_OCCUPIED: "CONTROLLER_OCCUPIED",
  MOUNT_UNAVAILABLE: "MOUNT_UNAVAILABLE",
  MOUNT_TIMEOUT: "MOUNT_TIMEOUT",
  MOUNT_CYCLE: "MOUNT_CYCLE",
} as const;

export type AepErrorCode = (typeof AEP_ERROR_CODES)[keyof typeof AEP_ERROR_CODES];

export interface AepErrorObject {
  code: AepErrorCode | string;
  message: string;
  data?: unknown;
}

export class AepError extends Error {
  readonly code: AepErrorCode | string;
  readonly data?: unknown;

  constructor(code: AepErrorCode | string, message: string, data?: unknown) {
    super(message);
    this.name = "AepError";
    this.code = code;
    if (data !== undefined) {
      this.data = data;
    }
  }

  toJSON(): AepErrorObject {
    const out: AepErrorObject = {
      code: this.code,
      message: this.message,
    };
    if (this.data !== undefined) {
      out.data = this.data;
    }
    return out;
  }

  static isAepErrorObject(value: unknown): value is AepErrorObject {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const candidate = value as Record<string, unknown>;
    return typeof candidate["code"] === "string" && typeof candidate["message"] === "string";
  }

  static from(
    error: unknown,
    fallbackCode: AepErrorCode | string = AEP_ERROR_CODES.INTERNAL_ERROR,
  ): AepError {
    if (error instanceof AepError) {
      return error;
    }
    if (AepError.isAepErrorObject(error)) {
      return new AepError(error.code, error.message, error.data);
    }
    if (error instanceof Error) {
      return new AepError(fallbackCode, error.message);
    }
    return new AepError(fallbackCode, typeof error === "string" ? error : "Unknown AEP error");
  }
}
