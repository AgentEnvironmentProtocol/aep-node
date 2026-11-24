import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { AEP_ERROR_CODES, AepError, type BodyChild } from "aep-node";
import { AepClient } from "aep-node/client";
import { AepServer } from "aep-node/server";
import {
  BinaryEnvelopeCodec,
  JsonTextCodec,
  MemoryTransportHub,
  NetStreamServer,
  StreamTransport,
  WebSocketTransportServer,
  connectNetStream,
  connectWebSocket,
} from "aep-node/transport";

const BINARY_SAMPLE = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x7f, 0x13, 0x37, 0x42]);

function buildTransportTestServer(): AepServer {
  const body: BodyChild[] = [
    {
      id: "device",
      kind: "ou",
      children: [
        {
          id: "ui",
          kind: "interface",
          children: [
            {
              id: "screen",
              kind: "content",
              mediaType: "application/octet-stream",
              temporalMode: "static",
              binaryRef: { refId: "blob-1", mediaType: "application/octet-stream" },
            },
          ],
        },
        {
          id: "telemetry",
          kind: "channel",
          mediaType: "application/octet-stream",
          direction: "duplex",
          deliveryMode: "stream",
          streamRef: { refId: "tel-0", mediaType: "application/octet-stream" },
        },
      ],
    },
  ];

  const server = new AepServer({ body });
  server.registerBinary({ refId: "blob-1", mediaType: "application/octet-stream" }, BINARY_SAMPLE);
  server.registerBinary({ refId: "large-blob", mediaType: "application/octet-stream" }, () => {
    const big = new Uint8Array(70_000);
    for (let i = 0; i < big.length; i += 1) {
      big[i] = i & 0xff;
    }
    return big;
  });
  server.registerChannel("/device/telemetry", {
    async onSend(params, ctx) {
      await ctx.sendChunk({ data: params.data });
      return { accepted: true, sequence: params.sequence ?? 1 };
    },
  });
  return server;
}

async function verifyRoundTrip(client: AepClient, expectedLarge = false): Promise<void> {
  const tree = await client.getTree({ path: "/" });
  assert.equal(tree.node.kind, "body");
  assert.equal(tree.node.children[0]?.id, "device");

  const bin = await client.getBinary("blob-1");
  assert.deepEqual(bin.data, BINARY_SAMPLE);

  if (expectedLarge) {
    const large = await client.getBinary("large-blob");
    assert.equal(large.data.byteLength, 70_000);
    assert.equal(large.data[0], 0);
    assert.equal(large.data[65_537], 65_537 & 0xff);
  }

  const sub = await client.openChannel({ path: "/device/telemetry" });
  const received: Uint8Array[] = [];
  sub.onChunk((chunk) => received.push(chunk.data));
  await sub.send(BINARY_SAMPLE);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], BINARY_SAMPLE);
  await sub.close();
}

describe("Transports and Codecs", () => {
  it("validates JsonTextCodec and BinaryEnvelopeCodec errors", () => {
    const jsonCodec = new JsonTextCodec();
    const binCodec = new BinaryEnvelopeCodec();

    assert.throws(
      () => jsonCodec.decode("{not-valid-json"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.PARSE_ERROR,
    );
    assert.throws(
      () => jsonCodec.decode(JSON.stringify({ protocolVersion: "1.0.0-draft", kind: "weird" })),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );

    assert.throws(
      () => binCodec.decode(new Uint8Array([0x99, 0x01, 0x02])),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.PARSE_ERROR,
    );
    assert.throws(
      () => binCodec.decode("string-not-allowed"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.PARSE_ERROR,
    );
  });

  it("round-trips over MemoryTransportHub", async () => {
    const server = buildTransportTestServer();
    const hub = new MemoryTransportHub();
    server.listen(hub);

    const client = await AepClient.connect(hub.connect());
    await verifyRoundTrip(client, true);

    await client.close();
    await hub.close();
    await server.close();
  });

  it("round-trips over StreamTransport in binary and ndjson modes (PassThrough & TCP)", async () => {
    const server = buildTransportTestServer();

    // 1. In-process PassThrough Duplex pairs in NDJSON mode (base64 fallback)
    const cToS = new PassThrough();
    const sToC = new PassThrough();
    server.accept(new StreamTransport(cToS, sToC, { framing: "ndjson" }));
    const ndjsonClient = await AepClient.connect(
      new StreamTransport(sToC, cToS, { framing: "ndjson" }),
    );
    await verifyRoundTrip(ndjsonClient, false);
    await ndjsonClient.close();

    // 2. TCP NetStreamServer + connectNetStream in binary framing mode
    const netServer = new NetStreamServer({ framing: "binary" });
    server.listen(netServer);
    const addr = await netServer.listen({ host: "127.0.0.1", port: 0 });
    assert.equal(typeof addr, "object");
    const port = (addr as { port: number }).port;

    const tcpTransport = await connectNetStream(
      { host: "127.0.0.1", port },
      { framing: "binary" },
    );
    const tcpClient = await AepClient.connect(tcpTransport);
    await verifyRoundTrip(tcpClient, true);

    await tcpClient.close();
    await netServer.close();
    await server.close();
  });

  it("round-trips over WebSocketTransportServer and native WebSocket in binary and json modes", async () => {
    const server = buildTransportTestServer();

    // 1. Binary mode WebSocket with >65KB payload + verifyClient peerIdentity
    let capturedPeerIdentity: Record<string, unknown> | undefined;
    const wsBinaryServer = new WebSocketTransportServer({
      path: "/aep",
      mode: "binary",
      verifyClient: (req) => ({
        userAgent: String(req.headers["user-agent"] ?? "node"),
      }),
    });
    wsBinaryServer.onConnection((t) => {
      capturedPeerIdentity = t.peerIdentity;
      server.accept(t);
    });
    const addr1 = await wsBinaryServer.listen(0, "127.0.0.1");

    const wsBinTransport = await connectWebSocket(`ws://127.0.0.1:${addr1.port}/aep`, {
      mode: "binary",
    });
    const wsBinClient = await AepClient.connect(wsBinTransport);
    assert.ok(capturedPeerIdentity);
    await verifyRoundTrip(wsBinClient, true);
    await wsBinClient.close();
    await wsBinaryServer.close();

    // 2. JSON text mode WebSocket
    const wsJsonServer = new WebSocketTransportServer({ path: "/aep-json", mode: "json" });
    server.listen(wsJsonServer);
    const addr2 = await wsJsonServer.listen(0, "127.0.0.1");

    const wsJsonTransport = await connectWebSocket(`ws://127.0.0.1:${addr2.port}/aep-json`, {
      mode: "json",
    });
    const wsJsonClient = await AepClient.connect(wsJsonTransport);
    await verifyRoundTrip(wsJsonClient, true);
    await wsJsonClient.close();
    await wsJsonServer.close();

    await server.close();
  });
});
