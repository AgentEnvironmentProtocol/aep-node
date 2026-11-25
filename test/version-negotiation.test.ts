import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AEP_ERROR_CODES,
  AEP_PROTOCOL_VERSION,
  AEP_WEBSOCKET_SUBPROTOCOL,
  AepError,
  HEAD_KEYS,
  areVersionsSemverCompatible,
  compareProtocolVersions,
  createLegacyVersionAliasAdapter,
  isValidProtocolVersion,
  negotiateProtocolVersion,
  parseProtocolVersion,
  type BodyChild,
  type ProtocolVersionAdapter,
} from "aep-node";
import { AepClient } from "aep-node/client";
import { AepServer } from "aep-node/server";
import {
  WebSocketTransportServer,
  connectWebSocket,
  createMemoryTransportPair,
} from "aep-node/transport";

const SAMPLE_BODY: BodyChild[] = [
  {
    id: "workspace",
    kind: "ou",
    children: [
      {
        id: "main",
        kind: "interface",
        type: "window",
        children: [
          {
            id: "status",
            kind: "view",
            type: "text",
            state: { value: "ready" },
          },
        ],
      },
    ],
  },
];

describe("Protocol Version Negotiation and Adaptation", () => {
  it("parses, compares, and enforces SemVer pre-release isolation", () => {
    assert.equal(AEP_PROTOCOL_VERSION, "1.0.0-beta.0");
    assert.equal(isValidProtocolVersion("1.0.0-beta.0"), true);
    assert.equal(isValidProtocolVersion("1.2.3+build.7"), true);
    assert.equal(isValidProtocolVersion("not-a-version"), false);

    const parsed = parseProtocolVersion("1.0.0-beta.0");
    assert.ok(parsed);
    assert.equal(parsed.major, 1);
    assert.equal(parsed.minor, 0);
    assert.equal(parsed.patch, 0);
    assert.deepEqual(parsed.prerelease, ["beta", "0"]);

    assert.ok(compareProtocolVersions("1.0.0-beta.0", "1.0.0-beta.1") < 0);
    assert.ok(compareProtocolVersions("1.0.0-beta.1", "1.0.0") < 0);
    assert.ok(compareProtocolVersions("1.2.0", "1.0.0") > 0);

    // Pre-release tags and 0.x versions are strictly isolated
    assert.equal(areVersionsSemverCompatible("1.0.0-beta.0", "1.0.0-beta.0"), true);
    assert.equal(areVersionsSemverCompatible("1.0.0-beta.0", "1.0.0-beta.1"), false);
    assert.equal(areVersionsSemverCompatible("1.0.0-beta.0", "1.0.0-draft"), false);
    assert.equal(areVersionsSemverCompatible("1.0.0-beta.0", "1.0.0"), false);
    assert.equal(areVersionsSemverCompatible("0.1.0", "0.2.0"), false);

    // Stable MAJOR >= 1 versions share minor compatibility
    assert.equal(areVersionsSemverCompatible("1.2.0", "1.0.0"), true);
    assert.equal(areVersionsSemverCompatible("2.0.0", "1.0.0"), false);
  });

  it("negotiates exact preference order and returns supportedVersions on UNSUPPORTED_VERSION", async () => {
    const server = new AepServer({
      protocolVersions: [AEP_PROTOCOL_VERSION, "1.0.0"],
      body: SAMPLE_BODY,
    });

    const [c1, s1] = createMemoryTransportPair();
    server.accept(s1);
    const client1 = new AepClient(c1, {
      supportedVersions: ["1.0.0", AEP_PROTOCOL_VERSION],
    });
    const initRes = await client1.initialize();
    assert.equal(initRes.protocolVersion, "1.0.0");
    assert.equal(client1.protocolVersion, "1.0.0");
    assert.equal(client1.head[HEAD_KEYS.PROTOCOL_VERSION], "1.0.0");
    await client1.close();

    const [c2, s2] = createMemoryTransportPair();
    server.accept(s2);
    const client2 = new AepClient(c2, {
      supportedVersions: ["1.0.0-beta.1"],
      adaptOnUnsupportedVersion: false,
    });
    await assert.rejects(
      () => client2.initialize(),
      (err: unknown) => {
        if (!(err instanceof AepError) || err.code !== AEP_ERROR_CODES.UNSUPPORTED_VERSION) {
          return false;
        }
        const data = err.data as { supportedVersions?: unknown } | undefined;
        assert.deepEqual(data?.supportedVersions, [AEP_PROTOCOL_VERSION, "1.0.0"]);
        return true;
      },
    );
    await client2.close();
    await server.close();
  });

  it("supports compatible stable SemVer minor negotiation and opt-out", async () => {
    const server = new AepServer({
      protocolVersions: ["1.0.0"],
      body: SAMPLE_BODY,
    });

    const [c1, s1] = createMemoryTransportPair();
    server.accept(s1);
    const client = await AepClient.connect(c1, {
      supportedVersions: ["1.3.0"],
    });
    assert.equal(client.protocolVersion, "1.0.0");
    const nodeRes = await client.getNode("/workspace/main/status");
    assert.equal(nodeRes.node.state?.value, "ready");
    await client.close();
    await server.close();

    // Strict server disables compatible minor fallback; client adapts via error.data.supportedVersions
    const strictServer = new AepServer({
      protocolVersions: ["1.0.0"],
      allowCompatibleMinorVersions: false,
      body: SAMPLE_BODY,
    });
    const [c2, s2] = createMemoryTransportPair();
    strictServer.accept(s2);
    const adaptingClient = await AepClient.connect(c2, {
      supportedVersions: ["1.3.0"],
      allowCompatibleMinorVersions: true,
      adaptOnUnsupportedVersion: true,
    });
    assert.equal(adaptingClient.protocolVersion, "1.0.0");
    await adaptingClient.close();

    // When client also disables compatible minor negotiation, handshake rejects cleanly
    const [c3, s3] = createMemoryTransportPair();
    strictServer.accept(s3);
    const nonAdaptingClient = new AepClient(c3, {
      supportedVersions: ["1.3.0"],
      allowCompatibleMinorVersions: false,
    });
    await assert.rejects(
      () => nonAdaptingClient.initialize(),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.UNSUPPORTED_VERSION,
    );
    await nonAdaptingClient.close();
    await strictServer.close();
  });

  it("bridges legacy and custom versions using ProtocolVersionAdapter on server and client", async () => {
    const legacyServer = new AepServer({
      protocolVersions: [AEP_PROTOCOL_VERSION],
      versionAdapters: [createLegacyVersionAliasAdapter("1.0.0-draft")],
      body: SAMPLE_BODY,
    });
    assert.deepEqual(legacyServer.protocolVersions, [AEP_PROTOCOL_VERSION, "1.0.0-draft"]);

    const [c1, s1] = createMemoryTransportPair();
    const observedWireVersions: string[] = [];
    const origSend = c1.send.bind(c1);
    c1.send = async (env) => {
      observedWireVersions.push(env.protocolVersion);
      return await origSend(env);
    };

    legacyServer.accept(s1);
    const legacyClient = await AepClient.connect(c1, {
      supportedVersions: ["1.0.0-draft"],
    });
    assert.equal(legacyClient.protocolVersion, "1.0.0-draft");
    assert.equal(legacyClient.head[HEAD_KEYS.PROTOCOL_VERSION], "1.0.0-draft");
    const statusNode = await legacyClient.getNode("/workspace/main/status");
    assert.equal(statusNode.node.state?.value, "ready");
    assert.ok(observedWireVersions.every((v) => v === "1.0.0-draft"));
    await legacyClient.close();
    await legacyServer.close();

    // Client-side custom adapter triggered automatically after UNSUPPORTED_VERSION response
    const customAdapter: ProtocolVersionAdapter = {
      ...createLegacyVersionAliasAdapter("1.0.0-alpha.9"),
      adaptCapabilities: (caps) => ({ ...caps }),
    };
    const alphaServer = new AepServer({
      protocolVersions: ["1.0.0-alpha.9"],
      body: SAMPLE_BODY,
    });
    const [c2, s2] = createMemoryTransportPair();
    alphaServer.accept(s2);

    const modernClient = await AepClient.connect(c2, {
      supportedVersions: [AEP_PROTOCOL_VERSION],
      versionAdapters: [customAdapter],
    });
    assert.equal(modernClient.protocolVersion, "1.0.0-alpha.9");
    assert.equal(modernClient.activeVersionAdapter?.version, "1.0.0-alpha.9");
    const node = await modernClient.getNode("/workspace/main/status");
    assert.equal(node.node.state?.value, "ready");
    await modernClient.close();
    await alphaServer.close();
  });

  it("rejects post-handshake envelopes with mismatched protocolVersion", async () => {
    const server = new AepServer({ body: SAMPLE_BODY });
    const [c1, s1] = createMemoryTransportPair();
    const handle = server.accept(s1);

    const client = await AepClient.connect(c1);
    assert.equal(handle.protocolVersion, AEP_PROTOCOL_VERSION);

    const replies: Array<{ ok?: boolean; error?: { code?: string } }> = [];
    c1.onMessage((env) => {
      if (env.kind === "response" && env.id === "tampered-1") {
        replies.push(env as { ok?: boolean; error?: { code?: string } });
      }
    });

    await c1.send({
      protocolVersion: "9.9.9",
      kind: "request",
      id: "tampered-1",
      method: "tree.get",
      params: { path: "/" },
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.ok, false);
    assert.equal(replies[0]?.error?.code, AEP_ERROR_CODES.UNSUPPORTED_VERSION);

    await client.close();
    await server.close();
  });

  it("negotiates WebSocket aep.v1 subprotocol and rejects unsupported subprotocols", async () => {
    const server = new AepServer({ body: SAMPLE_BODY });
    const wsServer = new WebSocketTransportServer({
      path: "/aep",
      mode: "binary",
      requireSubprotocol: true,
    });
    server.listen(wsServer);
    const addr = await wsServer.listen(0, "127.0.0.1");
    const url = `ws://127.0.0.1:${addr.port}/aep`;

    const transport = await connectWebSocket(url);
    assert.equal(transport.protocol, AEP_WEBSOCKET_SUBPROTOCOL);
    const client = await AepClient.connect(transport);
    assert.equal(client.protocolVersion, AEP_PROTOCOL_VERSION);
    await client.close();

    // Missing subprotocol rejected when requireSubprotocol = true
    await assert.rejects(() => connectWebSocket(url, { protocols: [] }));

    // Unsupported subprotocol rejected
    await assert.rejects(() => connectWebSocket(url, { protocols: ["unknown.proto"] }));

    await wsServer.close();
    await server.close();

    // Verify negotiateProtocolVersion directly
    const direct = negotiateProtocolVersion(["1.0.0-beta.0"], {
      supportedVersions: [AEP_PROTOCOL_VERSION],
    });
    assert.equal(direct?.selectedVersion, AEP_PROTOCOL_VERSION);
    assert.equal(direct?.matchKind, "exact");
  });
});
