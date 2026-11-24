import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AEP_ERROR_CODES, AepError, type AepNode, type BodyChild } from "aep-node";
import { AepClient } from "aep-node/client";
import { AepServer } from "aep-node/server";
import { createMemoryTransportPair } from "aep-node/transport";

function buildRichBody(): BodyChild[] {
  return [
    {
      id: "workstation",
      kind: "ou",
      type: "desktop.host",
      properties: { description: "Primary developer workstation" },
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
          type: "window",
          properties: {
            title: "IDE Workspace",
            description: "Code editor window",
            capture: { binary: true, mediaType: "image/png", refId: "bin-ide", regionSupported: true },
          },
          state: { windowState: "normal", focused: true },
          children: [
            {
              id: "title",
              kind: "view",
              type: "desktop.label",
              properties: {
                mediaType: "text/plain",
                temporalMode: "dynamic",
                label: "Active File",
              },
              state: {
                value: "main.ts - AEP",
              },
            },
            {
              id: "editor",
              kind: "editable",
              type: "textArea",
              properties: {
                mediaType: "text/plain",
                label: "Code Editor",
                valueSchema: { type: "string" },
              },
              state: {
                value: "console.log('hello');",
                dirty: false,
              },
              methods: [
                { name: "setValue", sideEffects: "write" },
                { name: "getStats", sideEffects: "read" },
              ],
              events: [{ name: "valueChanged" }],
            },
            {
              id: "dom-lazy",
              kind: "document",
              properties: {
                editable: false,
                title: "Embedded Docs",
              },
              hasChildren: true,
            },
            {
              id: "metrics-table",
              kind: "structure",
              type: "table",
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
    assert.deepEqual(client.capabilities?.nodeKinds, [
      "ou",
      "interface",
      "structure",
      "component",
      "document",
      "view",
      "editable",
      "control",
    ]);
    assert.equal(client.capabilities?.nodeKinds.includes("channel"), false);
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

    server.registerChildrenLoader("/workstation/ide/dom-lazy", () => {
      const children: AepNode[] = [
        {
          id: "header",
          kind: "structure",
          type: "heading",
          properties: { level: 1 },
          children: [
            {
              id: "text",
              kind: "view",
              type: "text",
              properties: { mediaType: "text/plain", temporalMode: "static" },
              state: { value: "Welcome Header" },
            },
          ],
        },
        {
          id: "btn",
          kind: "control",
          type: "button",
          properties: { label: "Submit" },
          methods: [{ name: "invoke", sideEffects: "write" }],
        },
      ];
      return { children, hasMore: false };
    });

    server.registerMethod("/workstation/ide/editor", "setValue", async (params, ctx) => {
      const nextVal = String((params as { value: string }).value);
      await ctx.updateNode(ctx.path, (prev) => ({
        ...prev,
        state: {
          ...(prev.state ?? {}),
          value: nextVal,
          dirty: true,
        },
      }));
      await ctx.emitEvent(ctx.path, "valueChanged", { value: nextVal });
      return { updated: true, value: nextVal };
    });

    server.registerMethod("/workstation/ide/editor", "getStats", (_params, ctx) => {
      const val = typeof ctx.node.state?.value === "string" ? ctx.node.state.value : "";
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

    // tree.query predicates: wildcard types, built-in types, properties, state, mediaTypePrefix, textContains
    const wildcardQuery = await client.queryTree({
      types: ["desktop.*"],
      textContains: "main.ts",
    });
    assert.equal(wildcardQuery.totalCount, 1);
    assert.equal(wildcardQuery.matches[0]?.path, "/workstation/ide/title");

    const builtInTypeQuery = await client.queryTree({
      types: ["window", "textArea"],
    });
    assert.deepEqual(
      builtInTypeQuery.matches.map((m) => m.path),
      ["/workstation/ide", "/workstation/ide/editor"],
    );

    const propertiesQuery = await client.queryTree({
      properties: [{ key: "editable", value: false }],
    });
    assert.equal(propertiesQuery.totalCount, 1);
    assert.equal(propertiesQuery.matches[0]?.path, "/workstation/ide/dom-lazy");

    const stateQuery = await client.queryTree({
      state: [{ key: "dirty", value: false }],
    });
    assert.equal(stateQuery.totalCount, 1);
    assert.equal(stateQuery.matches[0]?.path, "/workstation/ide/editor");

    const textMediaMatches = await client.queryTree({
      mediaTypePrefix: "text/",
    });
    assert.deepEqual(
      textMediaMatches.matches.map((m) => m.path),
      ["/workstation/ide/title", "/workstation/ide/editor"],
    );

    // textContains MUST NOT match unrelated property strings such as properties.mediaType ("text/plain")
    const nonTextContainsMediaType = await client.queryTree({
      textContains: "text/plain",
    });
    assert.equal(nonTextContainsMediaType.totalCount, 0);

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
    assert.equal(domHeader.node.kind, "structure");
    assert.equal(domHeader.node.type, "heading");

    // Dynamic server.addNode & node.loadChildren enforce Invariant 9 on tables/rows
    await assert.rejects(
      () =>
        server.addNode("/workstation/ide/metrics-table", {
          id: "bad-child",
          kind: "view",
          type: "text",
          state: { value: "invalid" },
        }),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );

    const validRow = await server.addNode("/workstation/ide/metrics-table", {
      id: "row-1",
      kind: "structure",
      type: "row",
      hasChildren: true,
    });
    assert.equal(validRow.type, "row");

    server.registerChildrenLoader("/workstation/ide/metrics-table/row-1", () => [
      {
        id: "bad-view",
        kind: "view",
        type: "text",
      },
    ]);
    await assert.rejects(
      () => client.loadChildren("/workstation/ide/metrics-table/row-1"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );

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
      kind: "view",
      type: "badge",
      properties: { mediaType: "text/plain", temporalMode: "static" },
      state: { value: "v2" },
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

  it("supports Scenario 4 composite Video Player Component and Rich Document with embedded fillable Form", async () => {
    const server = new AepServer({
      capabilities: "aep-core-streaming",
      body: [
        {
          id: "training-win",
          kind: "interface",
          type: "window",
          properties: { title: "Operator Training Module" },
          state: { windowState: "normal", focused: true },
          children: [
            {
              id: "main-split",
              kind: "structure",
              type: "grid",
              properties: { columns: 2 },
              children: [
                {
                  id: "player",
                  kind: "component",
                  type: "media.videoPlayer",
                  state: { playbackState: "paused", positionMs: 0 },
                  methods: [
                    { name: "play", sideEffects: "write" },
                    { name: "pause", sideEffects: "write" },
                    { name: "seek", sideEffects: "write" },
                  ],
                  children: [
                    {
                      id: "video-out",
                      kind: "channel",
                      mediaType: "video/h264",
                      direction: "sense",
                      deliveryMode: "stream+seek",
                      streamRef: {
                        refId: "vid-1",
                        mediaType: "video/h264",
                        seek: { seekable: true, unit: "ms", durationMs: 120000 },
                      },
                    },
                    {
                      id: "audio-out",
                      kind: "channel",
                      mediaType: "audio/opus",
                      direction: "sense",
                      deliveryMode: "stream+seek",
                      streamRef: {
                        refId: "aud-1",
                        mediaType: "audio/opus",
                        seek: { seekable: true, unit: "ms", durationMs: 120000 },
                      },
                    },
                    {
                      id: "viewport",
                      kind: "view",
                      type: "videoSurface",
                      state: {
                        channelRef: "/training-win/main-split/player/video-out",
                      },
                    },
                    {
                      id: "transport",
                      kind: "structure",
                      type: "stack",
                      properties: { orientation: "horizontal" },
                      children: [
                        {
                          id: "play-pause",
                          kind: "control",
                          type: "button",
                          properties: { label: "Play" },
                          methods: [{ name: "invoke", sideEffects: "write" }],
                        },
                        {
                          id: "scrub",
                          kind: "editable",
                          type: "slider",
                          properties: {
                            valueSchema: { type: "number", minimum: 0, maximum: 120000 },
                          },
                          state: { value: 0 },
                          methods: [{ name: "setValue", sideEffects: "write" }],
                        },
                        {
                          id: "subtitles-toggle",
                          kind: "editable",
                          type: "checkbox",
                          properties: { label: "Captions" },
                          state: { value: true },
                          methods: [
                            { name: "setValue", sideEffects: "write" },
                            { name: "toggle", sideEffects: "write" },
                          ],
                        },
                        {
                          id: "timecode",
                          kind: "view",
                          type: "text",
                          properties: { mediaType: "text/plain", temporalMode: "dynamic" },
                          state: { value: "00:00 / 02:00" },
                        },
                      ],
                    },
                  ],
                },
                {
                  id: "module-guide",
                  kind: "document",
                  properties: { title: "Safety & Calibration Guide", editable: false },
                  children: [
                    {
                      id: "h1",
                      kind: "structure",
                      type: "heading",
                      properties: { level: 1 },
                      children: [
                        {
                          id: "title",
                          kind: "view",
                          type: "text",
                          state: { value: "Calibration Checklist" },
                        },
                      ],
                    },
                    {
                      id: "intro",
                      kind: "structure",
                      type: "paragraph",
                      children: [
                        {
                          id: "lead",
                          kind: "view",
                          type: "span",
                          state: { value: "Review the telemetry thresholds below, or consult the " },
                        },
                        {
                          id: "ref-link",
                          kind: "control",
                          type: "link",
                          properties: { label: "Reference Manual" },
                          methods: [{ name: "invoke", sideEffects: "read" }],
                        },
                      ],
                    },
                    {
                      id: "metrics",
                      kind: "structure",
                      type: "table",
                      children: [
                        {
                          id: "col-param",
                          kind: "structure",
                          type: "column",
                          properties: { label: "Parameter" },
                        },
                        {
                          id: "col-limit",
                          kind: "structure",
                          type: "column",
                          properties: { label: "Limit" },
                        },
                        {
                          id: "row-1",
                          kind: "structure",
                          type: "row",
                          children: [
                            {
                              id: "cell-1a",
                              kind: "structure",
                              type: "cell",
                              children: [
                                {
                                  id: "v1",
                                  kind: "view",
                                  type: "text",
                                  state: { value: "Max Torque" },
                                },
                              ],
                            },
                            {
                              id: "cell-1b",
                              kind: "structure",
                              type: "cell",
                              children: [
                                {
                                  id: "v2",
                                  kind: "view",
                                  type: "text",
                                  state: { value: "18.5 Nm" },
                                },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                    {
                      id: "check-form",
                      kind: "structure",
                      type: "form",
                      properties: { title: "Verification Check" },
                      state: { valid: false, dirty: false },
                      methods: [
                        { name: "submit", sideEffects: "write" },
                        { name: "reset", sideEffects: "write" },
                        { name: "validate", sideEffects: "read" },
                      ],
                      children: [
                        {
                          id: "answer",
                          kind: "editable",
                          type: "radioGroup",
                          properties: {
                            label: "Confirm calibration step",
                            required: true,
                            valueSchema: { enum: ["verified", "needs-service"] },
                          },
                          state: { value: null },
                          methods: [{ name: "setValue", sideEffects: "write" }],
                        },
                        {
                          id: "notes",
                          kind: "editable",
                          type: "textField",
                          properties: {
                            label: "Inspector Notes",
                            placeholder: "Optional remarks",
                          },
                          state: { value: "" },
                          methods: [{ name: "setValue", sideEffects: "write" }],
                        },
                        {
                          id: "submit",
                          kind: "control",
                          type: "button",
                          properties: { label: "Submit Check" },
                          methods: [{ name: "invoke", sideEffects: "write" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    server.registerChannel("/training-win/main-split/player/video-out", {
      async onOpen(ctx) {
        await ctx.sendChunk({
          data: new Uint8Array([0x00, 0x01]),
          offset: 0,
        });
      },
    });

    server.registerMethod(
      "/training-win/main-split/player/transport/scrub",
      "setValue",
      async (params, ctx) => {
        const positionMs = Number((params as { value: number }).value);
        await ctx.updateNode(ctx.path, (prev) => ({
          ...prev,
          state: { ...(prev.state ?? {}), value: positionMs },
        }));
        await ctx.updateNode("/training-win/main-split/player", (prev) => ({
          ...prev,
          state: { ...(prev.state ?? {}), positionMs },
        }));
        return { ok: true, positionMs };
      },
    );

    server.registerMethod("/training-win/main-split/player", "play", async (_params, ctx) => {
      const currentPos =
        typeof ctx.node.state?.positionMs === "number" ? ctx.node.state.positionMs : 0;
      await ctx.updateNode(ctx.path, (prev) => ({
        ...prev,
        state: { ...(prev.state ?? {}), playbackState: "playing", positionMs: currentPos },
      }));
      await ctx.updateNode("/training-win/main-split/player/transport/timecode", (prev) => ({
        ...prev,
        state: { ...(prev.state ?? {}), value: "00:45 / 02:00" },
      }));
      await server.publishChannelChunk("/training-win/main-split/player/video-out", {
        data: new Uint8Array([0x0a, 0x0b]),
        offset: currentPos,
        isFinal: true,
      });
      return { ok: true };
    });

    server.registerMethod(
      "/training-win/main-split/module-guide/check-form/answer",
      "setValue",
      async (params, ctx) => {
        const value = (params as { value: string }).value;
        await ctx.updateNode(ctx.path, (prev) => ({
          ...prev,
          state: { ...(prev.state ?? {}), value, valid: true, dirty: true },
        }));
        await ctx.updateNode("/training-win/main-split/module-guide/check-form", (prev) => ({
          ...prev,
          state: { ...(prev.state ?? {}), valid: true, dirty: true },
        }));
        return { ok: true };
      },
    );

    server.registerMethod(
      "/training-win/main-split/module-guide/check-form/notes",
      "setValue",
      async (params, ctx) => {
        const value = String((params as { value: string }).value);
        await ctx.updateNode(ctx.path, (prev) => ({
          ...prev,
          state: { ...(prev.state ?? {}), value, dirty: true },
        }));
        await ctx.updateNode("/training-win/main-split/module-guide/check-form", (prev) => ({
          ...prev,
          state: { ...(prev.state ?? {}), valid: true, dirty: true },
        }));
        return { ok: true };
      },
    );

    server.registerMethod(
      "/training-win/main-split/module-guide/check-form/submit",
      "invoke",
      async (_params, ctx) => {
        await ctx.updateNode("/training-win/main-split/module-guide/check-form", (prev) => ({
          ...prev,
          state: { ...(prev.state ?? {}), valid: true, dirty: false },
        }));
        return { submitted: true, status: "recorded" };
      },
    );

    const [ct, st] = createMemoryTransportPair();
    server.accept(st);
    const client = await AepClient.connect(ct, { syncTree: true });

    const updatedLog: Array<{ path: string; state: unknown }> = [];
    client.onNodeUpdated((ev) => {
      updatedLog.push({ path: ev.path, state: ev.node.state });
    });

    const viewportRes = await client.getNode("/training-win/main-split/player/viewport");
    assert.equal(viewportRes.node.kind, "view");
    const channelPath = viewportRes.node.state?.channelRef;
    assert.equal(channelPath, "/training-win/main-split/player/video-out");

    const videoSub = await client.openChannel({ path: channelPath! });
    const receivedOffsets: number[] = [];
    videoSub.onChunk((chunk) => {
      receivedOffsets.push(chunk.offset ?? -1);
    });

    await client.invoke("/training-win/main-split/player/transport/scrub", "setValue", {
      value: 45000,
    });
    await client.invoke("/training-win/main-split/player", "play");
    await new Promise((r) => setTimeout(r, 15));

    assert.deepEqual(receivedOffsets, [0, 45000]);
    assert.ok(
      updatedLog.some(
        (u) =>
          u.path === "/training-win/main-split/player" &&
          (u.state as { playbackState?: string; positionMs?: number })?.playbackState === "playing" &&
          (u.state as { positionMs?: number })?.positionMs === 45000,
      ),
    );
    assert.ok(
      updatedLog.some(
        (u) =>
          u.path === "/training-win/main-split/player/transport/timecode" &&
          (u.state as { value?: string })?.value === "00:45 / 02:00",
      ),
    );

    await client.invoke(
      "/training-win/main-split/module-guide/check-form/answer",
      "setValue",
      { value: "verified" },
    );
    await client.invoke(
      "/training-win/main-split/module-guide/check-form/notes",
      "setValue",
      { value: "Nominal torque" },
    );
    const submitRes = await client.invoke<{ submitted: boolean; status: string }>(
      "/training-win/main-split/module-guide/check-form/submit",
      "invoke",
    );
    assert.deepEqual(submitRes.result, { submitted: true, status: "recorded" });

    const finalForm = await client.getNode("/training-win/main-split/module-guide/check-form");
    assert.deepEqual(finalForm.node.state, { valid: true, dirty: false });

    await videoSub.close();
    await client.close();
    await server.close();
  });
});
