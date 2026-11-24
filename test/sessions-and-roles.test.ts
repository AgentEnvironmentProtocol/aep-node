import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AEP_ERROR_CODES, AepError, type BodyChild } from "aep-node";
import { AepClient } from "aep-node/client";
import { AepServer } from "aep-node/server";
import { MemoryTransportHub } from "aep-node/transport";

function buildSharedBody(): BodyChild[] {
  return [
    {
      id: "robot",
      kind: "ou",
      type: "robotics.body",
      methods: [
        { name: "robotics.estop", sideEffects: "write" },
        { name: "robotics.status", sideEffects: "read" },
      ],
      children: [
        {
          id: "left-eye",
          kind: "channel",
          type: "robotics.camera",
          mediaType: "video/h264",
          direction: "sense",
          deliveryMode: "stream",
          streamRef: { refId: "cam-left", mediaType: "video/h264" },
        },
        {
          id: "blackbox",
          kind: "channel",
          mediaType: "application/octet-stream",
          direction: "sense",
          deliveryMode: "stream+seek",
          streamRef: { refId: "blackbox", mediaType: "application/octet-stream", seek: { seekable: true, unit: "ms" } },
        },
        {
          id: "arm-cmd",
          kind: "channel",
          mediaType: "application/x-joints",
          direction: "act",
          deliveryMode: "stream",
          streamRef: { refId: "arm-cmd", mediaType: "application/x-joints" },
        },
        {
          id: "gripper-loop",
          kind: "channel",
          mediaType: "application/x-gripper-servo",
          direction: "duplex",
          deliveryMode: "stream",
          streamRef: { refId: "gripper-loop", mediaType: "application/x-gripper-servo" },
        },
        {
          id: "hud",
          kind: "interface",
          children: [
            {
              id: "label",
              kind: "view",
              type: "text",
              properties: {
                mediaType: "text/plain",
                temporalMode: "dynamic",
              },
              state: {
                value: "initial",
              },
            },
          ],
        },
      ],
    },
  ];
}

describe("Sessions, Roles, and Concurrency Policies", () => {
  it("enforces single-controller policy, downgrade, CONTROLLER_OCCUPIED, observer restrictions, and sense fan-out (Scenario 3)", async () => {
    const server = new AepServer({
      body: buildSharedBody(),
      capabilities: {
        sessions: { policy: "single-controller", allowObserverStreams: true },
      },
    });
    server.registerMethod("/robot", "robotics.estop", () => ({ stopped: true }));
    server.registerMethod("/robot", "robotics.status", () => ({ ok: true }));
    server.registerChannel("/robot/blackbox", {
      onSample(params) {
        return { data: new Uint8Array([1, 2]), offset: params.offset };
      },
    });

    const hub = new MemoryTransportHub();
    server.listen(hub);

    // First client claims controller
    const ctrl = await AepClient.connect(hub.connect(), {
      session: { role: "controller" },
    });
    assert.equal(ctrl.session?.role, "controller");

    // Second client requesting controller with allowDowngradeToObserver=true downgrades to observer
    const obs = await AepClient.connect(hub.connect(), {
      session: { role: "controller", allowDowngradeToObserver: true },
    });
    assert.equal(obs.session?.role, "observer");

    // Third client requesting controller with allowDowngradeToObserver=false fails with CONTROLLER_OCCUPIED
    const denied = new AepClient(hub.connect());
    await assert.rejects(
      () => denied.initialize({ session: { role: "controller", allowDowngradeToObserver: false } }),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.CONTROLLER_OCCUPIED,
    );
    await denied.close();

    // Observer read method succeeds; write method fails with READ_ONLY_SESSION
    const status = await obs.invoke<{ ok: boolean }>("/robot", "robotics.status");
    assert.equal(status.result.ok, true);
    await assert.rejects(
      () => obs.invoke("/robot", "robotics.estop"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.READ_ONLY_SESSION,
    );

    // Observer cannot open "act" channel, nor send on "duplex", but CAN read "sense"/"duplex" and sample/seek
    await assert.rejects(
      () => obs.openChannel({ path: "/robot/arm-cmd" }),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.READ_ONLY_SESSION,
    );
    const obsDuplex = await obs.openChannel({ path: "/robot/gripper-loop" });
    await assert.rejects(
      () => obsDuplex.send(new Uint8Array([5])),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.READ_ONLY_SESSION,
    );
    await obsDuplex.close();

    const sampleRes = await obs.sampleChannel({ path: "/robot/blackbox", offset: 45000, unit: "ms" });
    assert.equal(sampleRes.offset, 45000);

    // Shared sense stream fans out to both controller and observer
    const ctrlCam = await ctrl.openChannel({ path: "/robot/left-eye" });
    const obsCam = await obs.openChannel({ path: "/robot/left-eye" });
    const ctrlFrames: number[][] = [];
    const obsFrames: number[][] = [];
    ctrlCam.onChunk((c) => ctrlFrames.push([...c.data]));
    obsCam.onChunk((c) => obsFrames.push([...c.data]));

    await server.publishChannelChunk("/robot/left-eye", { data: new Uint8Array([0xaa, 0xbb]) });
    await new Promise((r) => setTimeout(r, 15));
    assert.deepEqual(ctrlFrames, [[0xaa, 0xbb]]);
    assert.deepEqual(obsFrames, [[0xaa, 0xbb]]);

    // Closing controller frees controller slot for new client
    await ctrl.close();
    const nextCtrl = await AepClient.connect(hub.connect(), {
      session: { role: "controller", allowDowngradeToObserver: false },
    });
    assert.equal(nextCtrl.session?.role, "controller");

    await obs.close();
    await nextCtrl.close();
    await hub.close();
    await server.close();
  });

  it("supports multi-controller and isolated session policies", async () => {
    const multiServer = new AepServer({
      body: buildSharedBody(),
      capabilities: { sessions: { policy: "multi-controller" } },
    });
    multiServer.registerMethod("/robot", "robotics.estop", () => ({ stopped: true }));
    const multiHub = new MemoryTransportHub();
    multiServer.listen(multiHub);

    const c1 = await AepClient.connect(multiHub.connect(), { session: { role: "controller" } });
    const c2 = await AepClient.connect(multiHub.connect(), { session: { role: "controller" } });
    assert.equal(c1.session?.role, "controller");
    assert.equal(c2.session?.role, "controller");
    assert.deepEqual((await c2.invoke("/robot", "robotics.estop")).result, { stopped: true });

    await c1.close();
    await c2.close();
    await multiHub.close();
    await multiServer.close();

    // Isolated policy: tree mutations inside session 1 do not leak to session 2
    const isolatedServer = new AepServer({
      body: buildSharedBody(),
      capabilities: { sessions: { policy: "isolated" } },
    });
    isolatedServer.registerMethod("/robot", "setLabel", async (params, ctx) => {
      await ctx.updateNode("/robot/hud/label", (prev) => ({
        ...prev,
        state: {
          ...(prev.state ?? {}),
          value: String(params),
        },
      }));
      return { ok: true };
    });

    const isoHub = new MemoryTransportHub();
    isolatedServer.listen(isoHub);
    const s1 = await AepClient.connect(isoHub.connect(), { session: { role: "controller" } });
    const s2 = await AepClient.connect(isoHub.connect(), { session: { role: "controller" } });

    await s1.invoke("/robot", "setLabel", "session-1-only");
    const s1Label = await s1.getNode("/robot/hud/label");
    const s2Label = await s2.getNode("/robot/hud/label");
    assert.equal(s1Label.node.kind === "view" ? s1Label.node.state?.value : undefined, "session-1-only");
    assert.equal(s2Label.node.kind === "view" ? s2Label.node.state?.value : undefined, "initial");

    await s1.close();
    await s2.close();
    await isoHub.close();
    await isolatedServer.close();
  });
});
