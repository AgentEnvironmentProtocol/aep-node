import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AEP_ERROR_CODES, AepError, type BodyChild } from "aep-node";
import { AepClient } from "aep-node/client";
import { AepServer } from "aep-node/server";
import { createMemoryTransportPair } from "aep-node/transport";

function buildRichBody(): BodyChild[] {
  return [
    {
      id: "workstation",
      kind: "ou",
      type: "desktop.host",
      meta: { "aep.description": "Primary developer workstation" },
      children: [
        {
          id: "sys-audio",
          kind: "channel",
          type: "desktop.audio",
          mediaType: "audio/opus",
          direction: "sense",
          deliveryMode: "stream",
          streamRef: { refId: "stream-audio", mediaType: "audio/opus", sampleRate: 48000 },
        },
        {
          id: "blackbox",
          kind: "channel",
          type: "robotics.imu",
          mediaType: "application/x-telemetry",
          direction: "sense",
          deliveryMode: "stream+seek",
          streamRef: {
            refId: "stream-blackbox",
            mediaType: "application/x-telemetry",
            seek: { seekable: true, unit: "ms", durationMs: 60000, startOffset: 0, endOffset: 60000 },
          },
        },
        {
          id: "motor",
          kind: "channel",
          type: "robotics.joint",
          mediaType: "application/x-joints",
          direction: "act",
          deliveryMode: "stream",
          streamRef: { refId: "stream-motor", mediaType: "application/x-joints" },
        },
        {
          id: "ide",
          kind: "interface",
          type: "desktop.window",
          meta: {
            "aep.description": "Code editor window",
            "aep.capture": { binary: true, mediaType: "image/png", refId: "bin-ide", regionSupported: true },
          },
          children: [
            {
              id: "title",
              kind: "content",
              type: "desktop.label",
              mediaType: "text/plain",
              temporalMode: "dynamic",
              value: "main.ts - AEP",
            },
            {
              id: "editor",
              kind: "input",
              type: "desktop.textField",
              mediaType: "text/plain",
              value: "console.log('hello');",
              methods: [
                { name: "setValue", sideEffects: "write" },
                { name: "getStats", sideEffects: "read" },
              ],
              events: [{ name: "valueChanged" }],
            },
            {
              id: "dom-lazy",
              kind: "structure",
              type: "web.page",
              hasChildren: true,
            },
          ],
        },
      ],
    },
  ];
}

describe("Control Plane and Data Plane", () => {
  it("enforces session lifecycle, version, and auth mode checks", async () => {
    const server = new AepServer({
      capabilities: "aep-core-static",
      security: { allowedModes: ["unauthenticated"] },
    });

    const [c1, s1] = createMemoryTransportPair();
    server.accept(s1);
    const uninitClient = new AepClient(c1);
    await assert.rejects(
      () => uninitClient.getTree(),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.NOT_INITIALIZED,
    );
    await assert.rejects(
      () => uninitClient.initialize({ supportedVersions: ["99.0.0"] }),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.UNSUPPORTED_VERSION,
    );
    await assert.rejects(
      () => uninitClient.initialize({ security: { mode: "kerberos" } }),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.UNSUPPORTED_AUTH_MODE,
    );
    await uninitClient.close();
    await server.close();
  });

  it("enforces aep-core-static capability boundaries", async () => {
    assert.throws(
      () =>
        new AepServer({
          capabilities: "aep-core-static",
          body: [
            {
              id: "cam",
              kind: "channel",
              mediaType: "video/h264",
              direction: "sense",
              deliveryMode: "stream",
            },
          ],
        }),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.UNSUPPORTED_CAPABILITY,
    );

    const server = new AepServer({ capabilities: "aep-core-static" });
    server.registerBinary(
      { refId: "shot-1", mediaType: "image/png" },
      (params) => {
        const tag = params?.region ? `${params.region.width}x${params.region.height}` : "full";
        return new TextEncoder().encode(`png:${tag}`);
      },
    );

    const [ct, st] = createMemoryTransportPair();
    server.accept(st);
    const client = await AepClient.connect(ct, { capabilities: "aep-core-static" });

    assert.equal(client.capabilities?.profile, "aep-core-static");
    const bin = await client.getBinary("shot-1", {
      region: { x: 10, y: 20, width: 300, height: 200, coordSpace: "pixel" },
    });
    assert.equal(new TextDecoder().decode(bin.data), "png:300x200");

    await assert.rejects(
      () => client.openChannel({ path: "/anything" }),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.UNSUPPORTED_CAPABILITY,
    );
    await assert.rejects(
      () => client.sampleChannel({ path: "/anything", offset: 0 }),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.UNSUPPORTED_CAPABILITY,
    );

    await client.close();
    await server.close();
  });

  it("supports tree.get maxDepth, tree.query predicates & pagination, node.get, lazy loadChildren, and node.invoke", async () => {
    const server = new AepServer({
      capabilities: "aep-core-streaming",
      body: buildRichBody(),
    });

    server.registerChildrenLoader("/workstation/ide/dom-lazy", () => ({
      children: [
        {
          id: "header",
          kind: "content",
          type: "web.header",
          mediaType: "text/plain",
          temporalMode: "static",
          value: "Welcome Header",
        },
        {
          id: "btn",
          kind: "input",
          type: "web.button",
          mediaType: "text/plain",
          value: "Submit",
        },
      ],
      hasMore: false,
    }));

    server.registerMethod("/workstation/ide/editor", "setValue", async (params, ctx) => {
      const nextVal = String((params as { value: string }).value);
      await ctx.updateNode(ctx.path, (prev) => ({
        ...prev,
        ...(prev.kind === "input" ? { value: nextVal } : {}),
      }));
      await ctx.emitEvent(ctx.path, "valueChanged", { value: nextVal });
      return { updated: true, value: nextVal };
    });

    server.registerMethod("/workstation/ide/editor", "getStats", (_params, ctx) => {
      const val = ctx.node.kind === "input" && typeof ctx.node.value === "string" ? ctx.node.value : "";
      return { length: val.length };
    });

    const [ct, st] = createMemoryTransportPair();
    server.accept(st);
    const client = await AepClient.connect(ct, { syncTree: true });

    // tree.get with maxDepth=1 returns workstation with hasChildren=true
    const shallow = await client.getTree({ path: "/", maxDepth: 1 });
    assert.equal(shallow.node.kind, "body");
    assert.equal(shallow.node.children.length, 1);
    assert.equal(shallow.node.children[0]?.hasChildren, true);
    assert.equal((shallow.node.children[0] as { children?: unknown }).children, undefined);

    // node.get validation
    await assert.rejects(
      () => client.getNode("/"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_PATH,
    );
    await assert.rejects(
      () => client.getNode("/workstation/does-not-exist"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.NODE_NOT_FOUND,
    );

    // tree.query predicates
    const wildcardQuery = await client.queryTree({
      types: ["desktop.*"],
      textContains: "main.ts",
    });
    assert.equal(wildcardQuery.totalCount, 1);
    assert.equal(wildcardQuery.matches[0]?.path, "/workstation/ide/title");

    const senseChannels = await client.queryTree({
      kinds: ["channel"],
      direction: "sense",
      mediaTypePrefix: "audio/",
    });
    assert.equal(senseChannels.totalCount, 1);
    assert.equal(senseChannels.matches[0]?.path, "/workstation/sys-audio");

    const methodMatch = await client.queryTree({ hasMethod: "setValue" });
    assert.equal(methodMatch.totalCount, 1);
    assert.equal(methodMatch.matches[0]?.path, "/workstation/ide/editor");

    // Pagination
    const page1 = await client.queryTree({ limit: 2 });
    assert.equal(page1.matches.length, 2);
    assert.ok(page1.totalCount >= 5);
    assert.ok(page1.nextCursor);
    const page2 = await client.queryTree({ limit: 2, cursor: page1.nextCursor });
    assert.equal(page2.matches.length, 2);
    assert.notEqual(page1.matches[0]?.path, page2.matches[0]?.path);

    // node.loadChildren rejects channel and materializes lazy container
    await assert.rejects(
      () => client.loadChildren("/workstation/sys-audio"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_PARAMS,
    );
    const loaded = await client.loadChildren("/workstation/ide/dom-lazy");
    assert.equal(loaded.children.length, 2);
    const domHeader = await client.getNode("/workstation/ide/dom-lazy/header");
    assert.equal(domHeader.node.kind, "content");

    // Live events and syncTree mirroring
    const events: string[] = [];
    const updatedPaths: string[] = [];
    client.onNodeEvent((ev) => events.push(`${ev.path}:${ev.event}`));
    client.onNodeUpdated((ev) => updatedPaths.push(ev.path));

    const invokeRes = await client.invoke<{ updated: boolean; value: string }>(
      "/workstation/ide/editor",
      "setValue",
      { value: "const x = 42;" },
    );
    assert.equal(invokeRes.result.updated, true);

    const statsRes = await client.invoke<{ length: number }>(
      "/workstation/ide/editor",
      "getStats",
    );
    assert.equal(statsRes.result.length, "const x = 42;".length);

    assert.deepEqual(events, ["/workstation/ide/editor:valueChanged"]);
    assert.deepEqual(updatedPaths, ["/workstation/ide/editor"]);

    // Verify live syncTree add/update/remove + head.updated
    await server.addNode("/workstation/ide", {
      id: "badge",
      kind: "content",
      mediaType: "text/plain",
      temporalMode: "static",
      value: "v2",
    });
    await server.updateHead({ "vendor.mode": "active" });

    // Wait a microtask for async notifications to settle
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(client.head["vendor.mode"], "active");
    const syncedIde = client.cachedBody?.[0];
    assert.ok(syncedIde && syncedIde.kind === "ou");
    const badgeQuery = await client.queryTree({ rootPath: "/workstation/ide" });
    assert.ok(badgeQuery.matches.some((m) => m.path === "/workstation/ide/badge"));

    await server.removeNode("/workstation/ide/badge");
    await new Promise((r) => setTimeout(r, 10));
    await assert.rejects(
      () => client.getNode("/workstation/ide/badge"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.NODE_NOT_FOUND,
    );

    await client.close();
    await server.close();
  });

  it("supports channel.open, send, seek, sample, close, and AsyncIterable chunks", async () => {
    const server = new AepServer({ body: buildRichBody() });

    const sentPayloads: Uint8Array[] = [];
    let currentSeekOffset = 0;

    server.registerChannel("/workstation/motor", {
      onSend(params) {
        sentPayloads.push(params.data);
        return { accepted: true, sequence: params.sequence ?? 1 };
      },
    });

    server.registerChannel("/workstation/blackbox", {
      async onOpen(ctx) {
        await ctx.sendChunk({
          data: new Uint8Array([1, 2, 3]),
          offset: currentSeekOffset,
          isFinal: false,
        });
      },
      onSeek(params) {
        currentSeekOffset = params.offset;
        return { offset: params.offset, unit: params.unit ?? "ms" };
      },
      onSample(params) {
        return {
          data: new Uint8Array([9, 8, 7]),
          offset: params.offset,
          unit: params.unit ?? "ms",
          timestamp: "2026-11-23T00:00:00.000Z",
        };
      },
    });

    const [ct, st] = createMemoryTransportPair();
    server.accept(st);
    const client = await AepClient.connect(ct);

    // Conflicting path & refId -> INVALID_PARAMS
    await assert.rejects(
      () => client.openChannel({ path: "/workstation/sys-audio", refId: "stream-motor" }),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_PARAMS,
    );

    // Sense channel with async iteration + DIRECTION_MISMATCH on send
    const audioSub = await client.openChannel({ refId: "stream-audio" });
    assert.equal(audioSub.path, "/workstation/sys-audio");
    await assert.rejects(
      () => audioSub.send(new Uint8Array([0xff])),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.DIRECTION_MISMATCH,
    );

    await server.publishChannelChunk("/workstation/sys-audio", {
      data: new Uint8Array([10, 20, 30]),
    });
    await server.publishChannelChunk("/workstation/sys-audio", {
      data: new Uint8Array([40, 50]),
      isFinal: true,
    });

    const received: number[][] = [];
    for await (const chunk of audioSub) {
      received.push([...chunk.data]);
      if (chunk.isFinal) {
        await audioSub.close();
      }
    }
    assert.deepEqual(received, [
      [10, 20, 30],
      [40, 50],
    ]);

    // Act channel send
    const motorSub = await client.openChannel({ path: "/workstation/motor" });
    const sendRes = await motorSub.send(new Uint8Array([0xaa, 0xbb]), { sequence: 7 });
    assert.equal(sendRes.accepted, true);
    assert.equal(sendRes.sequence, 7);
    assert.deepEqual([...sentPayloads[0]!], [0xaa, 0xbb]);
    await motorSub.close();

    // Seek + Sample on stream+seek channel
    const sampled = await client.sampleChannel({
      path: "/workstation/blackbox",
      offset: 12500,
      unit: "ms",
    });
    assert.equal(sampled.offset, 12500);
    assert.deepEqual([...sampled.data], [9, 8, 7]);

    const replaySub = await client.openChannel({ path: "/workstation/blackbox" });
    const seekRes = await replaySub.seek(42000, "ms");
    assert.equal(seekRes.offset, 42000);
    assert.equal(seekRes.unit, "ms");
    await server.pushSubscriptionChunk(replaySub.subscriptionId, {
      data: new Uint8Array([42]),
      offset: 42000,
      isFinal: true,
    });

    const replayChunks: number[] = [];
    for await (const c of replaySub) {
      replayChunks.push(c.offset ?? -1);
      if (c.isFinal) {
        await replaySub.close();
      }
    }
    assert.deepEqual(replayChunks, [0, 42000]);

    await client.close();
    await server.close();
  });
});
