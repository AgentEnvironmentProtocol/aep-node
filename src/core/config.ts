import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AEP_ERROR_CODES, AepError } from "./errors.js";
import { isValidPath, isValidSegment } from "./path.js";
import type {
  AllowedFactor,
  AuthMode,
  CapabilitiesObject,
  Path,
  RenderMode,
  SessionRole,
} from "./types.js";

export interface AepListenerConfig {
  id?: string;
  transport: "quic" | "wss" | "ws" | "unix" | "named-pipe" | "stdio";
  address?: string;
  path?: string;
  alpn?: string[];
  allowInsecureTransport?: boolean;
  tls?: {
    certFile?: string;
    keyFile?: string;
    clientCaFile?: string;
    requireClientCert?: boolean;
  };
}

export interface AepServerSecurityConfig {
  authModes?: AuthMode[];
  allowUnauthenticatedLoopback?: boolean;
  jwt?: {
    issuer?: string;
    audience?: string;
    jwksUri?: string;
    publicKeyFile?: string;
  };
  elevation?: {
    enabled?: boolean;
    maxDurationMs?: number;
    defaultAllowedFactors?: AllowedFactor[];
    auditLogPath?: string;
  };
}

export interface AepServerConfig {
  info: {
    name: string;
    version: string;
    description?: string;
  };
  profile?: string;
  capabilities?: Partial<CapabilitiesObject>;
  listeners: AepListenerConfig[];
  security?: AepServerSecurityConfig;
}

export interface AepConnectionConfig {
  transport: "quic" | "wss" | "ws" | "unix" | "named-pipe" | "stdio" | "memory";
  uri?: string;
  uris?: string[];
  loadBalancing?: {
    strategy: "failover" | "round-robin" | "least-loaded" | "consistent-hash";
    healthCheckIntervalMs?: number;
  };
  path?: string;
  spawn?: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  };
  tls?: {
    caFile?: string;
    certFile?: string;
    keyFile?: string;
    serverName?: string;
    pinSha256?: string[];
    insecureSkipVerify?: boolean;
  };
  auth?: {
    mode: AuthMode;
    token?: string;
    apiKey?: string;
    keyId?: string;
    privateKeyFile?: string;
  };
  allowInsecureTransport?: boolean;
  reconnect?: {
    enabled?: boolean;
    initialDelayMs?: number;
    maxDelayMs?: number;
    multiplier?: number;
    maxAttempts?: number;
  };
}

export interface AepMountConfig {
  id: string;
  anchorPath: Path;
  connection: string;
  remotePath?: Path;
  role?: SessionRole;
  lazy?: boolean;
  required?: boolean;
  timeoutMs?: number;
  authPropagation?: {
    strategy: "none" | "static" | "token-exchange" | "passthrough";
    audience?: string;
    scopes?: string[];
    tokenEndpoint?: string;
  };
  allowElevation?: boolean;
  stripMetaPrefixes?: string[];
}

export interface AepClientConfig {
  info?: {
    name: string;
    version: string;
  };
  defaultRole?: SessionRole;
  allowDowngradeToObserver?: boolean;
  rendering?: {
    preferredMode?: RenderMode;
    minimalSynthesizer?: "client" | "server" | "auto";
    format?: "image/svg+xml" | "image/png" | "text/x-aep-layout";
    annotatePaths?: boolean;
  };
}

export interface AepConfig {
  schemaVersion: "1.0";
  metadata?: {
    name?: string;
    environment?: string;
    description?: string;
  };
  server?: AepServerConfig;
  connections?: Record<string, AepConnectionConfig>;
  mounts?: AepMountConfig[];
  client?: AepClientConfig;
}

const VALID_TOP_KEYS = new Set([
  "schemaVersion",
  "metadata",
  "server",
  "connections",
  "mounts",
  "client",
]);
const VALID_AUTH_MODES = new Set<string>([
  "unauthenticated",
  "mtls",
  "os-peer",
  "bearer",
  "api-key",
  "challenge-response",
]);
const VALID_LISTENER_TRANSPORTS = new Set(["quic", "wss", "ws", "unix", "named-pipe", "stdio"]);
const VALID_CONN_TRANSPORTS = new Set([
  "quic",
  "wss",
  "ws",
  "unix",
  "named-pipe",
  "stdio",
  "memory",
]);
const VALID_LB_STRATEGIES = new Set([
  "failover",
  "round-robin",
  "least-loaded",
  "consistent-hash",
]);
const VALID_AUTH_PROP_STRATEGIES = new Set([
  "none",
  "static",
  "token-exchange",
  "passthrough",
]);
const VALID_RENDER_MODES = new Set(["renderMinimal", "renderExpress", "renderFull"]);
const SECRET_FIELD_KEYS = new Set([
  "token",
  "apiKey",
  "privateKeyFile",
  "keyFile",
  "passphrase",
  "secret",
  "clientSecret",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface InterpolateSecretsOptions {
  env?: Record<string, string | undefined>;
  readFile?: (filePath: string) => string;
}

function resolveSecretToken(
  raw: string,
  options: InterpolateSecretsOptions,
  context: string,
): string {
  const envMap = options.env ?? process.env;
  const readFn =
    options.readFile ?? ((filePath: string) => readFileSync(filePath, "utf8"));

  return raw.replace(/\$\{(ENV|FILE):([^}]+)\}/g, (_match, kind: string, target: string) => {
    if (kind === "ENV") {
      const value = envMap[target];
      if (value === undefined) {
        throw new AepError(
          AEP_ERROR_CODES.INVALID_PARAMS,
          `Missing environment variable "${target}" referenced in ${context}`,
        );
      }
      return value;
    }
    try {
      const content = readFn(target);
      return content.replace(/[\r\n]+$/, "");
    } catch (err) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PARAMS,
        `Failed to read secret file "${target}" referenced in ${context}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}

function interpolateNode(
  value: unknown,
  inSecretScope: boolean,
  options: InterpolateSecretsOptions,
  context: string,
): unknown {
  if (typeof value === "string") {
    return inSecretScope ? resolveSecretToken(value, options, context) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item, idx) =>
      interpolateNode(item, inSecretScope, options, `${context}[${idx}]`),
    );
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      const enterScope =
        inSecretScope ||
        key === "auth" ||
        key === "tls" ||
        key === "headers" ||
        key === "env" ||
        key === "authPropagation";
      out[key] = interpolateNode(val, enterScope, options, `${context}.${key}`);
    }
    return out;
  }
  return value;
}

export function interpolateSecrets<T>(
  config: T,
  options: InterpolateSecretsOptions = {},
): T {
  return interpolateNode(config, false, options, "config") as T;
}

function redactNode(value: unknown, parentKey?: string): unknown {
  if (typeof value === "string") {
    if (parentKey && SECRET_FIELD_KEYS.has(parentKey)) {
      return "[REDACTED]";
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactNode(item));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (key === "headers" && isPlainObject(val)) {
        const redactedHeaders: Record<string, unknown> = {};
        for (const hKey of Object.keys(val)) {
          redactedHeaders[hKey] = "[REDACTED]";
        }
        out[key] = redactedHeaders;
      } else if (SECRET_FIELD_KEYS.has(key) && typeof val === "string") {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactNode(val, key);
      }
    }
    return out;
  }
  return value;
}

export function redactConfig<T>(config: T): T {
  return redactNode(structuredClone(config)) as T;
}

export function validateAepConfig(raw: unknown): AepConfig {
  if (!isPlainObject(raw)) {
    throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, "AEP config root must be an object");
  }
  for (const key of Object.keys(raw)) {
    if (!VALID_TOP_KEYS.has(key)) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PARAMS,
        `Unknown top-level AEP config field "${key}"`,
      );
    }
  }
  if (raw["schemaVersion"] !== "1.0") {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_PARAMS,
      `Unsupported or missing AEP config schemaVersion "${String(raw["schemaVersion"])}"; expected "1.0"`,
    );
  }

  if (raw["server"] !== undefined) {
    const server = raw["server"];
    if (!isPlainObject(server)) {
      throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, "config.server must be an object");
    }
    if (
      !isPlainObject(server["info"]) ||
      typeof server["info"]["name"] !== "string" ||
      typeof server["info"]["version"] !== "string"
    ) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PARAMS,
        "config.server.info requires string name and version",
      );
    }
    if (!Array.isArray(server["listeners"]) || server["listeners"].length === 0) {
      throw new AepError(
        AEP_ERROR_CODES.INVALID_PARAMS,
        "config.server.listeners must be a non-empty array",
      );
    }
    for (let i = 0; i < server["listeners"].length; i += 1) {
      const listener = server["listeners"][i];
      if (
        !isPlainObject(listener) ||
        typeof listener["transport"] !== "string" ||
        !VALID_LISTENER_TRANSPORTS.has(listener["transport"])
      ) {
        throw new AepError(
          AEP_ERROR_CODES.INVALID_PARAMS,
          `Invalid transport in config.server.listeners[${i}]`,
        );
      }
    }
    if (server["security"] !== undefined) {
      const sec = server["security"];
      if (!isPlainObject(sec)) {
        throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, "config.server.security must be an object");
      }
      if (sec["authModes"] !== undefined) {
        if (
          !Array.isArray(sec["authModes"]) ||
          sec["authModes"].some((m) => typeof m !== "string" || !VALID_AUTH_MODES.has(m))
        ) {
          throw new AepError(
            AEP_ERROR_CODES.INVALID_PARAMS,
            "config.server.security.authModes contains an invalid AuthMode",
          );
        }
      }
    }
  }

  const connectionKeys = new Set<string>();
  if (raw["connections"] !== undefined) {
    if (!isPlainObject(raw["connections"])) {
      throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, "config.connections must be an object");
    }
    for (const [connId, conn] of Object.entries(raw["connections"])) {
      if (
        !isPlainObject(conn) ||
        typeof conn["transport"] !== "string" ||
        !VALID_CONN_TRANSPORTS.has(conn["transport"])
      ) {
        throw new AepError(
          AEP_ERROR_CODES.INVALID_PARAMS,
          `Invalid transport in config.connections["${connId}"]`,
        );
      }
      if (conn["loadBalancing"] !== undefined) {
        const lb = conn["loadBalancing"];
        if (
          !isPlainObject(lb) ||
          (lb["strategy"] !== undefined &&
            (typeof lb["strategy"] !== "string" || !VALID_LB_STRATEGIES.has(lb["strategy"])))
        ) {
          throw new AepError(
            AEP_ERROR_CODES.INVALID_PARAMS,
            `Invalid loadBalancing in config.connections["${connId}"]`,
          );
        }
      }
      if (conn["auth"] !== undefined) {
        const auth = conn["auth"];
        if (
          !isPlainObject(auth) ||
          typeof auth["mode"] !== "string" ||
          !VALID_AUTH_MODES.has(auth["mode"])
        ) {
          throw new AepError(
            AEP_ERROR_CODES.INVALID_PARAMS,
            `Invalid auth.mode in config.connections["${connId}"]`,
          );
        }
      }
      connectionKeys.add(connId);
    }
  }

  if (raw["mounts"] !== undefined) {
    if (!Array.isArray(raw["mounts"])) {
      throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, "config.mounts must be an array");
    }
    for (let i = 0; i < raw["mounts"].length; i += 1) {
      const mount = raw["mounts"][i];
      if (!isPlainObject(mount)) {
        throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, `config.mounts[${i}] must be an object`);
      }
      if (typeof mount["id"] !== "string" || !isValidSegment(mount["id"])) {
        throw new AepError(
          AEP_ERROR_CODES.INVALID_PARAMS,
          `config.mounts[${i}].id must be a valid Segment`,
        );
      }
      if (typeof mount["anchorPath"] !== "string" || !isValidPath(mount["anchorPath"])) {
        throw new AepError(
          AEP_ERROR_CODES.INVALID_PATH,
          `config.mounts[${i}].anchorPath is invalid`,
        );
      }
      if (typeof mount["connection"] !== "string" || !connectionKeys.has(mount["connection"])) {
        throw new AepError(
          AEP_ERROR_CODES.INVALID_PARAMS,
          `config.mounts[${i}].connection "${String(mount["connection"])}" does not reference a defined connection`,
        );
      }
      if (
        mount["remotePath"] !== undefined &&
        (typeof mount["remotePath"] !== "string" || !isValidPath(mount["remotePath"]))
      ) {
        throw new AepError(
          AEP_ERROR_CODES.INVALID_PATH,
          `config.mounts[${i}].remotePath is invalid`,
        );
      }
      if (mount["authPropagation"] !== undefined) {
        const ap = mount["authPropagation"];
        if (
          !isPlainObject(ap) ||
          typeof ap["strategy"] !== "string" ||
          !VALID_AUTH_PROP_STRATEGIES.has(ap["strategy"])
        ) {
          throw new AepError(
            AEP_ERROR_CODES.INVALID_PARAMS,
            `config.mounts[${i}].authPropagation.strategy is invalid`,
          );
        }
      }
    }
  }

  if (raw["client"] !== undefined) {
    const client = raw["client"];
    if (!isPlainObject(client)) {
      throw new AepError(AEP_ERROR_CODES.INVALID_PARAMS, "config.client must be an object");
    }
    if (client["rendering"] !== undefined) {
      const rendering = client["rendering"];
      if (!isPlainObject(rendering)) {
        throw new AepError(
          AEP_ERROR_CODES.INVALID_PARAMS,
          "config.client.rendering must be an object",
        );
      }
      if (
        rendering["preferredMode"] !== undefined &&
        (typeof rendering["preferredMode"] !== "string" ||
          !VALID_RENDER_MODES.has(rendering["preferredMode"]))
      ) {
        throw new AepError(
          AEP_ERROR_CODES.INVALID_PARAMS,
          `Invalid client rendering preferredMode "${String(rendering["preferredMode"])}"`,
        );
      }
    }
  }

  return raw as unknown as AepConfig;
}

export interface ConfigDiscoveryOptions {
  explicitPath?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  fileExists?: (path: string) => boolean;
}

export function discoverConfigPath(options: ConfigDiscoveryOptions = {}): string | undefined {
  const exists = options.fileExists ?? existsSync;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;

  if (options.explicitPath) {
    const resolved = resolve(cwd, options.explicitPath);
    return exists(resolved) ? resolved : undefined;
  }

  const envPath = env["AEP_CONFIG"];
  if (envPath) {
    const resolved = resolve(cwd, envPath);
    return exists(resolved) ? resolved : undefined;
  }

  const workspaceCandidate = join(cwd, "aep.config.json");
  if (exists(workspaceCandidate)) {
    return workspaceCandidate;
  }

  const userCandidate =
    platform === "win32" && env["APPDATA"]
      ? join(env["APPDATA"], "aep", "aep.config.json")
      : join(homedir(), ".config", "aep", "aep.config.json");
  if (exists(userCandidate)) {
    return userCandidate;
  }

  const systemCandidate =
    platform === "win32"
      ? join(env["ProgramData"] ?? "C:\\ProgramData", "aep", "aep.config.json")
      : "/etc/aep/aep.config.json";
  if (exists(systemCandidate)) {
    return systemCandidate;
  }

  return undefined;
}

export interface LoadAepConfigOptions extends ConfigDiscoveryOptions {
  interpolate?: boolean;
  readFile?: (path: string) => string;
}

export function loadAepConfig(options: LoadAepConfigOptions = {}): {
  path: string;
  config: AepConfig;
} {
  const readFn = options.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const foundPath = options.explicitPath
    ? resolve(options.cwd ?? process.cwd(), options.explicitPath)
    : discoverConfigPath(options);

  if (!foundPath || !(options.fileExists ?? existsSync)(foundPath)) {
    throw new AepError(
      AEP_ERROR_CODES.INVALID_PARAMS,
      `AEP configuration file not found${options.explicitPath ? `: "${options.explicitPath}"` : ""}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFn(foundPath));
  } catch (err) {
    throw new AepError(
      AEP_ERROR_CODES.PARSE_ERROR,
      `Failed to parse AEP configuration "${foundPath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const validated = validateAepConfig(parsed);
  if (options.interpolate !== false) {
    return {
      path: foundPath,
      config: interpolateSecrets(validated, {
        env: options.env,
        readFile: options.readFile,
      }),
    };
  }
  return {
    path: foundPath,
    config: validated,
  };
}
