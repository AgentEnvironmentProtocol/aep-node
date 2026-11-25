import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  AEP_ERROR_CODES,
  AepError,
  discoverConfigPath,
  interpolateSecrets,
  loadAepConfig,
  redactConfig,
  synthesizeRenderMinimal,
  validateAepConfig,
  validateBody,
  validateMountContainment,
  type BodyChild,
} from "aep-node";
import { AepClient } from "aep-node/client";
import { AepServer } from "aep-node/server";
import { BinaryEnvelopeCodec, JsonTextCodec, createMemoryTransportPair } from "aep-node/transport";

describe("Api/Endpoint Grammar, Multi-Tier Rendering, and Configuration Manifests", () => {
  it("validates Api/Endpoint containment, bounds/capture prohibition, uid uniqueness, and mount rules", () => {
    const validApiBody: BodyChild[] = [
      {
        id: "services",
        kind: "ou",
        children: [
          {
            id: "billing",
            uid: "uid-billing-api",
            kind: "api",
            type: "rest",
            revision: 1,
            properties: { version: "v2", rateLimit: { requestsPerSecond: 100, burst: 20 } },
            state: { status: "healthy" },
            children: [
              {
                id: "invoices",
                uid: "uid-invoices",
                kind: "endpoint",
                type: "collection",
                hasChildren: true,
                children: [
                  {
                    id: "inv-1",
                    uid: "uid-inv-1",
                    kind: "endpoint",
                    type: "resource",
                    children: [
                      {
                        id: "events",
                        kind: "channel",
                        mediaType: "application/aep+event",
                        direction: "sense",
                        deliveryMode: "stream+seek",
                        payloadMode: "event",
                        streamRef: {
                          refId: "inv-events",
                          mediaType: "application/aep+event",
                          seek: { seekable: true, unit: "events" },
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    validateBody(validApiBody);

    // bounds/capture forbidden on Api and Endpoint
    assert.throws(
      () =>
        validateBody([
          {
            id: "bad-api",
            kind: "api",
            properties: { bounds: { x: 0, y: 0, width: 100, height: 100 } },
          },
        ]),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );

    // Interface cannot live inside Api
    assert.throws(
      () =>
        validateBody([
          {
            id: "bad-api",
            kind: "api",
            children: [{ id: "win", kind: "interface" } as unknown as never],
          },
        ]),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );

    // Duplicate uid rejected
    assert.throws(
      () =>
        validateBody([
          { id: "a", uid: "dup-1", kind: "ou" },
          { id: "b", uid: "dup-1", kind: "api" },
        ]),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );

    // Mount containment: Api Body under Interface rejected, Api Body under Api allowed
    validateMountContainment("api", {
      path: "/",
      kind: "body",
      children: [{ id: "sub-api", kind: "api" }],
    });
    assert.throws(
      () =>
        validateMountContainment("interface", {
          path: "/",
          kind: "body",
          children: [{ id: "sub-api", kind: "api" }],
        }),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );
  });

  it("supports data.render (renderMinimal, renderExpress, renderFull), client renderMinimal synthesis, password masking, and codec round-trip", async () => {
    const server = new AepServer({
      body: [
        {
          id: "api",
          kind: "api",
          type: "service",
        },
        {
          id: "login",
          kind: "interface",
          type: "dialog",
          properties: { title: "Sign In" },
          children: [
            {
              id: "form",
              kind: "structure",
              type: "form",
              properties: { title: "Credentials" },
              children: [
                {
                  id: "user",
                  kind: "editable",
                  type: "textField",
                  properties: { label: "Username", placeholder: "you@example.com" },
                  state: { value: "alice", focused: true },
                },
                {
                  id: "pass",
                  kind: "editable",
                  type: "passwordField",
                  properties: { label: "Password" },
                  state: { value: "super-secret-password" },
                },
                {
                  id: "avatar",
                  kind: "view",
                  type: "image",
                  properties: { altText: "User Avatar" },
                  state: { binaryRef: { refId: "avatar-1", mediaType: "image/png" } },
                },
                {
                  id: "submit",
                  kind: "control",
                  type: "button",
                  properties: { label: "Continue" },
                },
              ],
            },
          ],
        },
      ],
    });

    server.registerRenderer("/login", (req) => {
      if (req.mode === "renderFull") {
        return {
          mediaType: "image/png",
          data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          pathMap: { "#1": "/login/form/user" },
        };
      }
      return synthesizeRenderMinimal(req.node, req.path, req.params);
    });

    const [ct, st] = createMemoryTransportPair();
    server.accept(st);
    const client = await AepClient.connect(ct, { syncTree: true });

    // Non-visual node fails with INVALID_PARAMS
    await assert.rejects(
      () => client.render({ path: "/api", mode: "renderMinimal" }),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_PARAMS,
    );

    // Server renderMinimal SVG + password masking + annotatePaths
    const svgRes = await client.render({
      path: "/login",
      mode: "renderMinimal",
      params: { format: "image/svg+xml", annotatePaths: true },
    });
    assert.equal(svgRes.mediaType, "image/svg+xml");
    assert.equal(typeof svgRes.data, "string");
    const svgText = svgRes.data as string;
    assert.ok(svgText.includes("<svg"));
    assert.ok(svgText.includes("••••"));
    assert.equal(svgText.includes("super-secret-password"), false);
    assert.ok(svgRes.pathMap);
    assert.ok(Object.values(svgRes.pathMap!).includes("/login/form/submit"));

    // Client-side local renderMinimal in text/x-aep-layout format
    const asciiRes = await client.renderMinimal("/login", {
      format: "text/x-aep-layout",
      annotatePaths: true,
    });
    assert.equal(asciiRes.mediaType, "text/x-aep-layout");
    const asciiText = asciiRes.data as string;
    assert.ok(asciiText.includes("Sign In"));
    assert.ok(asciiText.includes("••••"));
    assert.equal(asciiText.includes("super-secret-password"), false);

    // Binary renderFull PNG + Codec round-trip
    const pngRes = await client.render({ path: "/login", mode: "renderFull" });
    assert.equal(pngRes.mediaType, "image/png");
    assert.ok(pngRes.data instanceof Uint8Array);
    assert.deepEqual([...(pngRes.data as Uint8Array)], [0x89, 0x50, 0x4e, 0x47]);

    const jsonCodec = new JsonTextCodec();
    const binCodec = new BinaryEnvelopeCodec();
    const pngEnvelope = {
      protocolVersion: "1.0.0-draft",
      kind: "response" as const,
      id: "r1",
      ok: true as const,
      result: pngRes as unknown as Record<string, unknown>,
    };
    const decodedJson = jsonCodec.decode(jsonCodec.encode(pngEnvelope));
    const decodedBin = binCodec.decode(binCodec.encode(pngEnvelope));
    assert.ok(decodedJson.kind === "response" && decodedJson.ok && decodedJson.result);
    assert.ok(decodedBin.kind === "response" && decodedBin.ok && decodedBin.result);
    assert.deepEqual(
      [...((decodedJson.result as { data: Uint8Array }).data)],
      [0x89, 0x50, 0x4e, 0x47],
    );
    assert.deepEqual(
      [...((decodedBin.result as { data: Uint8Array }).data)],
      [0x89, 0x50, 0x4e, 0x47],
    );

    await client.close();
    await server.close();
  });

  it("loads, validates, interpolates secrets, discovers, and redacts aep.config.json manifests", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "aep-cfg-test-"));
    try {
      const secretFile = join(tmpDir, "token.txt");
      writeFileSync(secretFile, "file-secret-value\n", "utf8");

      const cfgPath = join(tmpDir, "aep.config.json");
      const rawCfg = {
        schemaVersion: "1.0",
        metadata: { name: "test-host", environment: "staging" },
        server: {
          info: { name: "aep-host", version: "1.0.0" },
          listeners: [{ transport: "wss", address: "0.0.0.0:7443" }],
          security: { authModes: ["bearer", "mtls"] },
        },
        connections: {
          billing: {
            transport: "wss",
            uri: "wss://billing.internal/aep",
            auth: {
              mode: "bearer",
              token: "${ENV:AEP_TEST_TOKEN}",
            },
            tls: {
              caFile: "${FILE:" + secretFile + "}",
            },
          },
        },
        mounts: [
          {
            id: "billing",
            anchorPath: "/services/billing",
            connection: "billing",
            authPropagation: { strategy: "token-exchange" },
            allowElevation: true,
            stripMetaPrefixes: ["internal."],
          },
        ],
      };
      writeFileSync(cfgPath, JSON.stringify(rawCfg), "utf8");

      // Discovery precedence: explicit > AEP_CONFIG > cwd
      const envCfgPath = join(tmpDir, "override.json");
      writeFileSync(envCfgPath, JSON.stringify({ schemaVersion: "1.0" }), "utf8");
      assert.equal(
        discoverConfigPath({ cwd: tmpDir, env: { AEP_CONFIG: envCfgPath } }),
        envCfgPath,
      );
      assert.equal(discoverConfigPath({ cwd: tmpDir, env: {} }), cfgPath);

      // Load with interpolation & redaction
      const loaded = loadAepConfig({
        cwd: tmpDir,
        env: { AEP_TEST_TOKEN: "env-secret-123" },
      });
      assert.equal(loaded.config.connections?.["billing"]?.auth?.token, "env-secret-123");
      assert.equal(loaded.config.connections?.["billing"]?.tls?.caFile, "file-secret-value");

      const redacted = redactConfig(loaded.config);
      assert.equal(redacted.connections?.["billing"]?.auth?.token, "[REDACTED]");
      assert.equal(loaded.config.connections?.["billing"]?.auth?.token, "env-secret-123");

      // Missing env var fails strictly
      assert.throws(
        () => interpolateSecrets(rawCfg, { env: {} }),
        (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_PARAMS,
      );

      // Invalid mount connection fails validation
      assert.throws(
        () =>
          validateAepConfig({
            schemaVersion: "1.0",
            mounts: [{ id: "m1", anchorPath: "/m1", connection: "missing" }],
          }),
        (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_PARAMS,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
