import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AEP_ERROR_CODES, AepError } from "aep-node";
import { AepClient, AepCompositeClient } from "aep-node/client";
import { AepServer } from "aep-node/server";
import { MemoryTransportHub, createMemoryTransportPair } from "aep-node/transport";

describe("Passthrough Mounting and Multi-Root Composition", () => {
  it("supports Desktop IDE mounting Terminal and lazy Webview with refId & ChannelRef isolation (Scenario 1)", async () => {
    // 1. Terminal AEP server
    const termServer = new AepServer({
      serverInfo: { name: "term-server", version: "1.0.0" },
      body: [
        {
          id: "term",
          kind: "interface",
          type: "desktop.terminal",
          children: [
            {
              id: "term-out",
              kind: "channel",
              mediaType: "text/plain",
              direction: "sense",
              deliveryMode: "stream",
              streamRef: { refId: "tty-0", mediaType: "text/plain" },
            },
            {
              id: "term-link",
              kind: "content",
              mediaType: "text/plain",
              temporalMode: "dynamic",
              channelRef: "/term/term-out",
            },
            {
              id: "scrollback",
              kind: "content",
              type: "desktop.textLog",
              mediaType: "text/plain",
              temporalMode: "dynamic",
              value: "ready",
            },
            {
              id: "stdin",
              kind: "input",
              type: "desktop.commandInput",
              mediaType: "text/plain",
              methods: [{ name: "sendLine", sideEffects: "write" }],
            },
          ],
        },
      ],
    });
    termServer.registerBinary(
      { refId: "snapshot-1", mediaType: "image/png" },
      new TextEncoder().encode("term-png"),
    );
    termServer.registerMethod("/term/stdin", "sendLine", async (params, ctx) => {
      const cmd = String((params as { text: string }).text);
      await ctx.updateNode("/term/scrollback", (prev) => ({
        ...prev,
        ...(prev.kind === "content" ? { value: `ran:${cmd}:ok` } : {}),
      }));
      return {
        ok: true,
        snapshot: { refId: "snapshot-1", mediaType: "image/png" },
      };
    });

    // 2. Webview AEP server (same local refId "snapshot-1")
    const webServer = new AepServer({
      serverInfo: { name: "web-server", version: "1.0.0" },
      body: [
        {
          id: "preview",
          kind: "interface",
          type: "web.iframe",
          children: [
            {
              id: "dom-root",
              kind: "structure",
              type: "web.page",
              hasChildren: true,
            },
            {
              id: "preview-shot",
              kind: "content",
              mediaType: "image/png",
              temporalMode: "static",
              binaryRef: { refId: "snapshot-1", mediaType: "image/png" },
            },
          ],
        },
      ],
    });
    webServer.registerBinary(
      { refId: "snapshot-1", mediaType: "image/png" },
      new TextEncoder().encode("web-png"),
    );
    webServer.registerChildrenLoader("/preview/dom-root", () => [
      { id: "header", kind: "content", type: "web.header", mediaType: "text/plain", temporalMode: "static", value: "Docs" },
      { id: "btn", kind: "input", type: "web.button", mediaType: "text/plain", value: "Go" },
    ]);

    // 3. Desktop IDE host server
    const hostServer = new AepServer({
      serverInfo: { name: "ide-host", version: "1.0.0" },
      body: [
        {
          id: "workstation",
          kind: "ou",
          type: "desktop.host",
          children: [
            {
              id: "ide",
              kind: "interface",
              type: "desktop.window",
              children: [
                {
                  id: "layout",
                  kind: "structure",
                  type: "desktop.panel",
                  children: [
                    {
                      id: "editor",
                      kind: "input",
                      type: "desktop.textField",
                      mediaType: "text/plain",
                      value: "fn main() {}",
                    },
                    {
                      id: "term",
                      kind: "interface",
                      type: "desktop.terminal",
                    },
                    {
                      id: "preview",
                      kind: "interface",
                      type: "web.iframe",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const [termClientTr, termServerTr] = createMemoryTransportPair();
    termServer.accept(termServerTr);
    const termClient = new AepClient(termClientTr);
    await hostServer.mount({
      anchorPath: "/workstation/ide/layout/term",
      sourcePath: "/term",
      client: termClient,
      mountKey: "term",
    });

    const [webClientTr, webServerTr] = createMemoryTransportPair();
    webServer.accept(webServerTr);
    const webClient = new AepClient(webClientTr);
    await hostServer.mount({
      anchorPath: "/workstation/ide/layout/preview",
      sourcePath: "/preview",
      client: webClient,
      lazy: true,
      mountKey: "web",
    });

    const [agentClientTr, agentServerTr] = createMemoryTransportPair();
    hostServer.accept(agentServerTr);
    const agent = await AepClient.connect(agentClientTr);

    // tree.query spans local + mounted providers
    const queryRes = await agent.queryTree({
      rootPath: "/workstation/ide",
      kinds: ["interface", "input"],
    });
    const matchedPaths = queryRes.matches.map((m) => m.path);
    assert.ok(matchedPaths.includes("/workstation/ide/layout/editor"));
    assert.ok(matchedPaths.includes("/workstation/ide/layout/term"));
    assert.ok(matchedPaths.includes("/workstation/ide/layout/term/stdin"));
    assert.ok(matchedPaths.includes("/workstation/ide/layout/preview"));

    // ChannelRef inside mounted terminal was rewritten to upstream path
    const termLink = await agent.getNode("/workstation/ide/layout/term/term-link");
    assert.equal(termLink.node.kind, "content");
    assert.equal(termLink.node.channelRef, "/workstation/ide/layout/term/term-out");

    // Lazy mount hydrates on loadChildren, and lazy DOM inside mount loads children
    const previewChildren = await agent.loadChildren("/workstation/ide/layout/preview");
    assert.equal(previewChildren.children.length, 2);
    const domChildren = await agent.loadChildren("/workstation/ide/layout/preview/dom-root");
    assert.deepEqual(
      domChildren.children.map((c) => c.id),
      ["header", "btn"],
    );

    // Invoke terminal method and observe path-rebased node.updated + isolated refId
    const updates: Array<{ path: string; value: unknown }> = [];
    agent.onNodeUpdated((ev) => {
      updates.push({
        path: ev.path,
        value: ev.node.kind === "content" ? ev.node.value : undefined,
      });
    });

    const invokeRes = await agent.invoke<{ ok: boolean; snapshot: { refId: string } }>(
      "/workstation/ide/layout/term/stdin",
      "sendLine",
      { text: "cargo test" },
    );
    assert.equal(invokeRes.result.ok, true);
    assert.notEqual(invokeRes.result.snapshot.refId, "snapshot-1");

    await new Promise((r) => setTimeout(r, 15));
    assert.ok(
      updates.some(
        (u) =>
          u.path === "/workstation/ide/layout/term/scrollback" &&
          u.value === "ran:cargo test:ok",
      ),
    );

    // Distinct BinaryRef isolation despite identical local refId "snapshot-1"
    const webShotNode = await agent.getNode("/workstation/ide/layout/preview/preview-shot");
    assert.equal(webShotNode.node.kind, "content");
    const webRefId = webShotNode.node.binaryRef!.refId;
    assert.notEqual(webRefId, invokeRes.result.snapshot.refId);

    const termBin = await agent.getBinary(invokeRes.result.snapshot.refId);
    const webBin = await agent.getBinary(webRefId);
    assert.equal(new TextDecoder().decode(termBin.data), "term-png");
    assert.equal(new TextDecoder().decode(webBin.data), "web-png");

    await agent.close();
    await hostServer.close();
    await termServer.close();
    await webServer.close();
  });

  it("assembles Robot (with nested Arm sub-server) + Cloud Workspace in AepCompositeClient (Scenario 2)", async () => {
    // 1. Arm sub-server
    const armServer = new AepServer({
      serverInfo: { name: "arm-subserver", version: "1.0.0" },
      body: [
        {
          id: "gripper-loop",
          kind: "channel",
          type: "robotics.gripper",
          mediaType: "application/x-gripper-servo",
          direction: "duplex",
          deliveryMode: "stream",
          streamRef: { refId: "gripper-0", mediaType: "application/x-gripper-servo" },
        },
      ],
    });
    armServer.registerChannel("/gripper-loop", {
      async onSend(params, ctx) {
        await ctx.sendChunk({
          data: new Uint8Array([params.data[0]! + 1]),
        });
        return { accepted: true, sequence: params.sequence ?? 1 };
      },
    });

    // 2. Robot server mounts Arm sub-server at /right-arm
    const robotServer = new AepServer({
      serverInfo: { name: "robot-server", version: "1.0.0" },
      head: { "aep.vocabularies": ["aep.robotics"] },
      body: [
        {
          id: "head",
          kind: "ou",
          type: "robotics.head",
          children: [
            {
              id: "left-eye",
              kind: "channel",
              type: "robotics.camera",
              mediaType: "video/h264",
              direction: "sense",
              deliveryMode: "stream",
              streamRef: { refId: "left-eye", mediaType: "video/h264" },
            },
          ],
        },
        {
          id: "right-arm",
          kind: "ou",
          type: "robotics.limb",
        },
      ],
    });

    const [armCt, armSt] = createMemoryTransportPair();
    armServer.accept(armSt);
    await robotServer.mount({
      anchorPath: "/right-arm",
      client: new AepClient(armCt),
      mountKey: "arm",
    });

    // 3. Cloud Workspace server
    const cloudServer = new AepServer({
      serverInfo: { name: "cloud-sandbox", version: "1.0.0" },
      head: { "aep.vocabularies": ["aep.desktop"] },
      body: [
        {
          id: "shell",
          kind: "interface",
          type: "desktop.terminal",
          methods: [{ name: "run", sideEffects: "write" }],
        },
      ],
    });
    cloudServer.registerMethod("/shell", "run", (params) => ({
      logged: (params as { cmd: string }).cmd,
    }));

    // 4. Composite client mounts both Robot and Cloud Workspace
    const [robotCt, robotSt] = createMemoryTransportPair();
    robotServer.accept(robotSt);
    const robotClient = await AepClient.connect(robotCt);

    const [cloudCt, cloudSt] = createMemoryTransportPair();
    cloudServer.accept(cloudSt);
    const cloudClient = await AepClient.connect(cloudCt);

    const composite = new AepCompositeClient();
    await composite.mountServer("robot", robotClient, {
      type: "robotics.body",
      methods: [{ name: "robotics.estop", sideEffects: "write" }],
    });
    await composite.mountServer("cloud-workspace", cloudClient, {
      type: "desktop.host",
    });

    const fullTree = await composite.getTree({ path: "/" });
    assert.equal(fullTree.node.kind, "body");
    assert.deepEqual(
      fullTree.node.children.map((c) => c.id),
      ["robot", "cloud-workspace"],
    );

    const duplexQuery = await composite.queryTree({
      kinds: ["channel"],
      direction: "duplex",
    });
    assert.equal(duplexQuery.totalCount, 1);
    assert.equal(duplexQuery.matches[0]?.path, "/robot/right-arm/gripper-loop");

    // Multi-hop duplex streaming through Composite -> Robot -> Arm
    const sub = await composite.openChannel({ path: "/robot/right-arm/gripper-loop" });
    const feedback: number[][] = [];
    sub.onChunk((c) => feedback.push([...c.data]));

    await sub.send(new Uint8Array([0x20]));
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(feedback, [[0x21]]);
    await sub.close();

    // Cloud shell invocation
    const runRes = await composite.invoke<{ logged: string }>("/cloud-workspace/shell", "run", {
      cmd: "log-pick-event",
    });
    assert.equal(runRes.result.logged, "log-pick-event");

    await composite.closeAll();
    await cloudServer.close();
    await robotServer.close();
    await armServer.close();
  });

  it("enforces observer restrictions locally at mount host, detects cycles, and isolates faults", async () => {
    let downstreamWriteCalls = 0;
    const downstream = new AepServer({
      body: [
        {
          id: "ui",
          kind: "interface",
          children: [
            {
              id: "ctrl",
              kind: "input",
              mediaType: "text/plain",
              methods: [{ name: "mutate", sideEffects: "write" }],
            },
            {
              id: "actuator",
              kind: "channel",
              mediaType: "application/x-joints",
              direction: "act",
              deliveryMode: "stream",
            },
            {
              id: "slow",
              kind: "content",
              mediaType: "text/plain",
              temporalMode: "static",
              methods: [{ name: "hang", sideEffects: "read" }],
            },
          ],
        },
      ],
    });
    downstream.registerMethod("/ui/ctrl", "mutate", () => {
      downstreamWriteCalls += 1;
      return { mutated: true };
    });
    downstream.registerMethod("/ui/slow", "hang", async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { ok: true };
    });

    const host = new AepServer({
      body: [
        {
          id: "slot",
          kind: "interface",
        },
      ],
    });

    const [downCt, downSt] = createMemoryTransportPair();
    downstream.accept(downSt);
    await host.mount({
      anchorPath: "/slot",
      sourcePath: "/ui",
      client: new AepClient(downCt),
      timeoutMs: 50,
    });

    const hub = new MemoryTransportHub();
    host.listen(hub);

    const observer = await AepClient.connect(hub.connect(), {
      session: { role: "observer" },
    });

    // Observer rejected locally BEFORE reaching downstream
    await assert.rejects(
      () => observer.invoke("/slot/ctrl", "mutate"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.READ_ONLY_SESSION,
    );
    await assert.rejects(
      () => observer.openChannel({ path: "/slot/actuator" }),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.READ_ONLY_SESSION,
    );
    assert.equal(downstreamWriteCalls, 0);

    // Timeout maps to MOUNT_TIMEOUT
    await assert.rejects(
      () => observer.invoke("/slot/slow", "hang"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.MOUNT_TIMEOUT,
    );

    // Downstream disconnect maps to MOUNT_UNAVAILABLE
    await downCt.close("down");
    await new Promise((r) => setTimeout(r, 10));
    await assert.rejects(
      () => observer.getNode("/slot/ctrl"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.MOUNT_UNAVAILABLE,
    );

    // Cycle detection: self-mount & 2-hop cycle A -> B -> A
    const srvA = new AepServer({ originId: "origin-A", body: [{ id: "m", kind: "ou" }] });
    const srvB = new AepServer({ originId: "origin-B", body: [{ id: "m", kind: "ou" }] });

    const [selfCt, selfSt] = createMemoryTransportPair();
    srvA.accept(selfSt);
    await assert.rejects(
      () => srvA.mount({ anchorPath: "/m", client: new AepClient(selfCt) }),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.MOUNT_CYCLE,
    );

    const [abCt, abSt] = createMemoryTransportPair();
    srvB.accept(abSt);
    await srvA.mount({ anchorPath: "/m", client: new AepClient(abCt) });

    const [baCt, baSt] = createMemoryTransportPair();
    srvA.accept(baSt);
    await assert.rejects(
      () => srvB.mount({ anchorPath: "/m", client: new AepClient(baCt) }),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.MOUNT_CYCLE,
    );

    await observer.close();
    await hub.close();
    await host.close();
    await downstream.close();
    await srvA.close();
    await srvB.close();
  });
});
