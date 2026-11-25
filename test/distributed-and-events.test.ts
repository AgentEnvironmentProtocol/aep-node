import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AEP_ERROR_CODES, AepError, type ChannelEvent } from "aep-node";
import { AepClient } from "aep-node/client";
import { AepServer } from "aep-node/server";
import {
  BinaryEnvelopeCodec,
  JsonTextCodec,
  MemoryTransportHub,
  createMemoryTransportPair,
} from "aep-node/transport";

describe("Event Channels, Optimistic Concurrency, Leases, Node Moves, and Session Resumption", () => {
  it("supports structured event channels (payloadMode=event), PAYLOAD_MODE_MISMATCH, eventFilter, stream+seek events, and codecs", async () => {
    const receivedEvents: ChannelEvent[] = [];
    const server = new AepServer({
      body: [
        {
          id: "billing",
          kind: "api",
          type: "webhook",
          children: [
            {
              id: "events",
              kind: "channel",
              mediaType: "application/aep+event",
              direction: "duplex",
              deliveryMode: "stream+seek",
              payloadMode: "event",
              streamRef: {
                refId: "billing-events",
                mediaType: "application/aep+event",
                seek: { seekable: true, unit: "events", startOffset: 0, endOffset: 10 },
              },
            },
          ],
        },
      ],
    });

    server.registerChannel("/billing/events", {
      onSend(params) {
        if (params.event) {
          receivedEvents.push(params.event);
        }
        return { accepted: true, sequence: params.sequence ?? 1 };
      },
      onSample(params) {
        return {
          offset: params.offset,
          unit: "events",
          event: { name: "invoice.paid", id: `evt-${params.offset}`, payload: { amount: 99 } },
        };
      },
    });

    const [ct, st] = createMemoryTransportPair();
    server.accept(st);
    const client = await AepClient.connect(ct);

    const queryRes = await client.queryTree({ payloadMode: "event" });
    assert.equal(queryRes.totalCount, 1);
    assert.equal(queryRes.matches[0]?.path, "/billing/events");

    const sub = await client.openChannel({
      path: "/billing/events",
      params: { eventFilter: { names: ["invoice.paid"] } },
    });
    assert.equal(sub.payloadMode, "event");

    // Sending binary data on an event channel fails with PAYLOAD_MODE_MISMATCH
    await assert.rejects(
      () => sub.send(new Uint8Array([1, 2, 3])),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.PAYLOAD_MODE_MISMATCH,
    );

    // Sending structured event succeeds
    await sub.sendEvent({ name: "invoice.refundRequested", payload: { id: "inv-1" } });
    assert.equal(receivedEvents.length, 1);
    assert.equal(receivedEvents[0]?.name, "invoice.refundRequested");

    // Server publishes two events; eventFilter keeps only invoice.paid
    const got: ChannelEvent[] = [];
    sub.onChunk((c) => {
      if (c.event) got.push(c.event);
    });
    await server.publishChannelChunk("/billing/events", {
      event: { name: "invoice.created", payload: { id: "inv-2" } },
    });
    await server.publishChannelChunk("/billing/events", {
      event: { name: "invoice.paid", id: "e-42", payload: { id: "inv-2", paid: true } },
    });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(got.length, 1);
    assert.equal(got[0]?.id, "e-42");

    // Sample by event offset
    const sampled = await client.sampleChannel({
      path: "/billing/events",
      offset: 5,
      unit: "events",
    });
    assert.equal(sampled.unit, "events");
    assert.equal(sampled.event?.name, "invoice.paid");
    assert.equal((sampled.event?.payload as { amount: number }).amount, 99);

    // Codec round-trip for event notification
    const jsonCodec = new JsonTextCodec();
    const binCodec = new BinaryEnvelopeCodec();
    const eventNote = {
      protocolVersion: "1.0.0-beta.0",
      kind: "notification" as const,
      method: "channel.chunk",
      seq: 3,
      params: {
        subscriptionId: sub.subscriptionId,
        refId: "billing-events",
        sequence: 1,
        timestamp: "2026-11-25T12:00:00.000Z",
        mediaType: "application/aep+event",
        event: { name: "invoice.paid", payload: { ok: true } },
      },
    };
    const roundJson = jsonCodec.decode(jsonCodec.encode(eventNote));
    const roundBin = binCodec.decode(binCodec.encode(eventNote));
    assert.equal(roundJson.kind, "notification");
    assert.equal(roundBin.kind, "notification");
    assert.equal(roundBin.seq, 3);

    await sub.close();
    await client.close();
    await server.close();
  });

  it("supports node.moved, uid followMoves, NODE_MOVED, optimistic revision checks, and cooperative subtree leases", async () => {
    const server = new AepServer({
      capabilities: {
        sessions: { policy: "multi-controller", leases: true, optimisticConcurrency: true },
      },
      body: [
        {
          id: "zone-a",
          kind: "ou",
          children: [
            {
              id: "svc",
              kind: "api",
              type: "service",
              children: [
                {
                  id: "worker",
                  uid: "uid-worker-1",
                  kind: "endpoint",
                  type: "resource",
                  revision: 1,
                  state: { value: "idle" },
                  methods: [{ name: "update", sideEffects: "write" }],
                  children: [
                    {
                      id: "telemetry",
                      uid: "uid-telemetry-1",
                      kind: "channel",
                      mediaType: "application/aep+event",
                      direction: "sense",
                      deliveryMode: "stream",
                      payloadMode: "event",
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          id: "zone-b",
          kind: "ou",
          children: [{ id: "svc", kind: "api", type: "service" }],
        },
      ],
    });

    server.registerMethod("/zone-a/svc/worker", "update", async (params, ctx) => {
      const updated = await ctx.updateNode(ctx.path, (prev) => ({
        ...prev,
        state: { ...(prev.state ?? {}), value: (params as { value: string }).value },
      }));
      return { value: updated.state?.value };
    });

    const hub = new MemoryTransportHub();
    server.listen(hub);

    const agent1 = await AepClient.connect(hub.connect(), { syncTree: true });
    const agent2 = await AepClient.connect(hub.connect());

    // 1. Optimistic concurrency: stale expectedRevision -> REVISION_CONFLICT
    await assert.rejects(
      () => agent1.invoke("/zone-a/svc/worker", "update", { value: "busy" }, { expectedRevision: 99 }),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.REVISION_CONFLICT,
    );
    const okInvoke = await agent1.invoke(
      "/zone-a/svc/worker",
      "update",
      { value: "busy" },
      { expectedRevision: 1 },
    );
    assert.equal(okInvoke.revision, 2);

    // 2. Cooperative subtree lease blocks competing writes
    const lease = await agent1.acquireLease({ path: "/zone-a", holderName: "agent-1" });
    await assert.rejects(
      () => agent2.invoke("/zone-a/svc/worker", "update", { value: "hijack" }),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.LEASE_CONFLICT,
    );
    await agent1.releaseLease(lease.leaseId);

    // 3. Move node while channel subscription is open; verify syncTree, uid followMoves, and NODE_MOVED
    const sub = await agent1.openChannel({ uid: "uid-telemetry-1" });
    const movedEvents: string[] = [];
    agent1.onNodeMoved((ev) => movedEvents.push(`${ev.fromPath}->${ev.toPath}`));

    await server.moveNode("/zone-a/svc/worker", "/zone-b/svc/worker-moved");
    await new Promise((r) => setTimeout(r, 15));

    assert.deepEqual(movedEvents, ["/zone-a/svc/worker->/zone-b/svc/worker-moved"]);
    const cachedZoneB = agent1.cachedBody?.find((n) => n.id === "zone-b");
    const cachedSvc = cachedZoneB?.kind === "ou" ? cachedZoneB.children?.[0] : undefined;
    assert.equal(cachedSvc?.kind === "api" ? cachedSvc.children?.[0]?.id : undefined, "worker-moved");

    // Stale path without uid fails with NODE_MOVED
    await assert.rejects(
      () => agent2.getNode("/zone-a/svc/worker"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.NODE_MOVED,
    );

    // Querying by uid follows move automatically
    const resolved = await agent2.getNode({ uid: "uid-worker-1" });
    assert.equal(resolved.resolvedPath, "/zone-b/svc/worker-moved");

    // Existing open channel subscription survives moveNode!
    const chunks: unknown[] = [];
    sub.onChunk((c) => chunks.push(c.event?.payload));
    await server.publishChannelChunk("/zone-b/svc/worker-moved/telemetry", {
      event: { name: "heartbeat", payload: { alive: true } },
    });
    await new Promise((r) => setTimeout(r, 15));
    assert.deepEqual(chunks, [{ alive: true }]);

    await sub.close();
    await agent1.close();
    await agent2.close();
    await server.close();
  });

  it("supports session.resume with Control-Plane seq replay and Channel subscription continuity", async () => {
    const server = new AepServer({
      capabilities: {
        resumption: { enabled: true, replayWindowEvents: 100, sessionTtlMs: 60_000 },
      },
      body: [
        {
          id: "sensor",
          kind: "channel",
          mediaType: "application/aep+event",
          direction: "sense",
          deliveryMode: "stream",
          payloadMode: "event",
        },
        {
          id: "ui",
          kind: "interface",
          type: "window",
          children: [
            {
              id: "status",
              kind: "view",
              type: "text",
              state: { value: "initial" },
            },
          ],
        },
      ],
    });

    const [ct1, st1] = createMemoryTransportPair();
    server.accept(st1);
    const client = await AepClient.connect(ct1);
    const savedSessionId = client.session!.sessionId;
    const savedResumeToken = client.resumeToken!;
    assert.ok(savedResumeToken);

    const sub = await client.openChannel({ path: "/sensor" });
    const receivedEvents: string[] = [];
    sub.onChunk((c) => {
      if (c.event?.name) receivedEvents.push(c.event.name);
    });

    await server.publishChannelChunk("/sensor", {
      event: { name: "tick-1", payload: { n: 1 } },
    });
    await new Promise((r) => setTimeout(r, 15));
    assert.deepEqual(receivedEvents, ["tick-1"]);

    // Simulate abrupt transport drop (NOT session.close)
    await ct1.close();
    await new Promise((r) => setTimeout(r, 15));

    // Server emits a node update and a channel chunk while client is disconnected
    await server.updateNode("/ui/status", (prev) => ({
      ...prev,
      state: { value: "updated-while-offline" },
    }));
    await server.publishChannelChunk("/sensor", {
      event: { name: "tick-2", payload: { n: 2 } },
    });

    // Client reconnects on a fresh transport and invokes session.resume
    const [ct2, st2] = createMemoryTransportPair();
    server.accept(st2);
    client.reattachTransport(ct2);

    const nodeUpdates: string[] = [];
    client.onNodeUpdated((ev) => nodeUpdates.push(String(ev.node.state?.value)));

    const resumeRes = await client.resume();
    assert.equal(resumeRes.resumed, true);
    assert.equal(resumeRes.sessionId, savedSessionId);
    assert.notEqual(resumeRes.resumeToken, savedResumeToken);
    assert.equal(resumeRes.replayedCount, 1);
    assert.equal(resumeRes.subscriptions[0]?.status, "resumed");

    await new Promise((r) => setTimeout(r, 15));
    assert.deepEqual(nodeUpdates, ["updated-while-offline"]);
    assert.deepEqual(receivedEvents, ["tick-1", "tick-2"]);

    // Invalid resumeToken -> SESSION_EXPIRED
    const [ctBad, stBad] = createMemoryTransportPair();
    server.accept(stBad);
    const badClient = new AepClient(ctBad);
    await assert.rejects(
      () =>
        badClient.resume({
          sessionId: savedSessionId,
          resumeToken: "wrong-token",
        }),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.SESSION_EXPIRED,
    );

    await badClient.close();
    await client.close();
    await server.close();
  });
});
