import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AEP_ERROR_CODES,
  AepError,
  formatPath,
  isPathWithin,
  isValidNamespacedIdent,
  isValidPath,
  isValidSegment,
  joinPath,
  parsePath,
  rebasePath,
  splitParentPath,
  stripPathPrefix,
  validateBody,
  validateChannelRefs,
  validateMountContainment,
  validateNode,
  type BodyChild,
  type ChannelNode,
  type ComponentElementNode,
  type ControlElementNode,
  type DocumentElementNode,
  type InterfaceNode,
  type OUNode,
  type StructureElementNode,
  type ViewElementNode,
} from "aep-node";

describe("Path and Lexical Validation", () => {
  it("validates Segments, NamespacedIdents, and Paths", () => {
    assert.equal(isValidSegment("left-eye"), true);
    assert.equal(isValidSegment("node_1.v2"), true);
    assert.equal(isValidSegment("."), false);
    assert.equal(isValidSegment(".."), false);
    assert.equal(isValidSegment(""), false);
    assert.equal(isValidSegment("a/b"), false);

    assert.equal(isValidNamespacedIdent("desktop.window"), true);
    assert.equal(isValidNamespacedIdent("aep.robotics.joint"), true);
    assert.equal(isValidNamespacedIdent("single"), true);
    assert.equal(isValidNamespacedIdent(".leading"), false);
    assert.equal(isValidNamespacedIdent("trailing."), false);
    assert.equal(isValidNamespacedIdent("double..dot"), false);

    assert.equal(isValidPath("/"), true);
    assert.equal(isValidPath("/robot/head/left-eye"), true);
    assert.equal(isValidPath("/robot/"), false);
    assert.equal(isValidPath("robot/head"), false);
    assert.equal(isValidPath("/robot/../etc"), false);
    assert.equal(isValidPath("/robot/./head"), false);
  });

  it("parses, joins, splits, and rebases paths", () => {
    assert.deepEqual(parsePath("/"), []);
    assert.deepEqual(parsePath("/a/b/c"), ["a", "b", "c"]);
    assert.throws(() => parsePath("/a//b"), (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_PATH);

    assert.equal(formatPath([]), "/");
    assert.equal(formatPath(["robot", "head"]), "/robot/head");

    assert.equal(joinPath("/", "robot"), "/robot");
    assert.equal(joinPath("/robot", "head/left-eye"), "/robot/head/left-eye");
    assert.equal(joinPath("/robot", "/"), "/robot");

    assert.deepEqual(splitParentPath("/robot/head"), { parentPath: "/robot", id: "head" });
    assert.deepEqual(splitParentPath("/robot"), { parentPath: "/", id: "robot" });
    assert.throws(() => splitParentPath("/"), (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_PATH);

    assert.equal(isPathWithin("/robot/head/left-eye", "/robot"), true);
    assert.equal(isPathWithin("/robot", "/robot"), true);
    assert.equal(isPathWithin("/robotics", "/robot"), false);

    assert.equal(stripPathPrefix("/robot/head", "/robot"), "/head");
    assert.equal(stripPathPrefix("/robot", "/robot"), "/");
    assert.equal(rebasePath("/head/left-eye", "/", "/robot"), "/robot/head/left-eye");
    assert.equal(rebasePath("/preview/dom", "/preview", "/ide/layout/preview"), "/ide/layout/preview/dom");
    assert.equal(rebasePath("/other/node", "/preview", "/ide/layout/preview"), null);
  });
});

describe("Formal Grammar Invariants", () => {
  it("accepts valid nested nodes across all 9 NodeKinds including Component-owned Channels, Documents, and Tables", () => {
    const body: BodyChild[] = [
      {
        id: "workstation",
        kind: "ou",
        type: "desktop.host",
        children: [
          {
            id: "sys-audio",
            kind: "channel",
            type: "desktop.audio",
            mediaType: "audio/opus",
            direction: "sense",
            deliveryMode: "stream",
            streamRef: { refId: "audio-0", mediaType: "audio/opus", sampleRate: 48000, channelCount: 2 },
          },
          {
            id: "ide",
            kind: "interface",
            type: "window",
            properties: {
              title: "IDE",
              bounds: { x: 0, y: 0, width: 1280, height: 800, coordSpace: "pixel" },
            },
            state: { windowState: "normal", focused: true },
            children: [
              {
                id: "layout",
                kind: "structure",
                type: "grid",
                properties: { columns: 2 },
                children: [
                  {
                    id: "term",
                    kind: "interface",
                    type: "desktop.terminal",
                    children: [
                      {
                        id: "scrollback",
                        kind: "view",
                        type: "desktop.textLog",
                        properties: { mediaType: "text/plain", temporalMode: "dynamic" },
                        state: { value: "ready" },
                      },
                    ],
                  },
                  {
                    id: "player",
                    kind: "component",
                    type: "media.videoPlayer",
                    state: { playbackState: "paused", positionMs: 0 },
                    children: [
                      {
                        id: "video-out",
                        kind: "channel",
                        mediaType: "video/h264",
                        direction: "sense",
                        deliveryMode: "stream+seek",
                      },
                      {
                        id: "viewport",
                        kind: "view",
                        type: "videoSurface",
                        state: { channelRef: "/workstation/ide/layout/player/video-out" },
                      },
                      {
                        id: "play-btn",
                        kind: "control",
                        type: "button",
                        properties: { label: "Play" },
                        state: { pressed: false, focused: false },
                        methods: [{ name: "invoke", sideEffects: "write" }],
                      },
                      {
                        id: "embedded-hud",
                        kind: "interface",
                        type: "dialog",
                        properties: { modal: false },
                      },
                    ],
                  },
                  {
                    id: "guide",
                    kind: "document",
                    properties: { title: "Guide", editable: false },
                    children: [
                      {
                        id: "metrics",
                        kind: "structure",
                        type: "table",
                        children: [
                          {
                            id: "col-1",
                            kind: "structure",
                            type: "column",
                            properties: { label: "Metric" },
                          },
                          {
                            id: "row-1",
                            kind: "structure",
                            type: "row",
                            state: { selected: false },
                            children: [
                              {
                                id: "cell-1",
                                kind: "structure",
                                type: "cell",
                                children: [
                                  {
                                    id: "cell-text",
                                    kind: "view",
                                    type: "text",
                                    state: { value: "Nominal" },
                                  },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                      {
                        id: "mic-in",
                        kind: "editable",
                        type: "voiceInput",
                        properties: { mediaType: "audio/opus" },
                        state: { channelRef: "/workstation/sys-audio" },
                      },
                      {
                        id: "doc-slot",
                        kind: "interface",
                        type: "page",
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

    assert.doesNotThrow(() => validateBody(body, { strictChannelRefs: true }));
  });

  it("rejects containment violations and enforces Component/Document/Interface placement rules", () => {
    const ouInsideInterface: InterfaceNode = {
      id: "win",
      kind: "interface",
      children: [{ id: "bad", kind: "ou" } as unknown as InterfaceNode],
    };
    assert.throws(
      () => validateNode(ouInsideInterface, "body"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );

    const viewInsideOu: OUNode = {
      id: "host",
      kind: "ou",
      children: [
        {
          id: "lbl",
          kind: "view",
          properties: { mediaType: "text/plain", temporalMode: "static" },
        } as unknown as OUNode,
      ],
    };
    assert.throws(
      () => validateNode(viewInsideOu, "body"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );

    const channelInsideStructure: StructureElementNode = {
      id: "panel",
      kind: "structure",
      children: [
        {
          id: "cam",
          kind: "channel",
          mediaType: "video/h264",
          direction: "sense",
          deliveryMode: "stream",
        } as unknown as StructureElementNode,
      ],
    };
    assert.throws(
      () => validateNode(channelInsideStructure, "interface"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );

    const channelInsideDocument: DocumentElementNode = {
      id: "doc",
      kind: "document",
      children: [
        {
          id: "cam",
          kind: "channel",
          mediaType: "video/h264",
          direction: "sense",
          deliveryMode: "stream",
        } as unknown as DocumentElementNode,
      ],
    };
    assert.throws(
      () => validateNode(channelInsideDocument, "interface"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );

    for (const primitiveKind of ["view", "editable", "control"] as const) {
      const channelInsidePrimitive = {
        id: "prim",
        kind: primitiveKind,
        children: [
          {
            id: "cam",
            kind: "channel",
            mediaType: "video/h264",
            direction: "sense",
            deliveryMode: "stream",
          },
        ],
      } as unknown as ViewElementNode;
      assert.throws(
        () => validateNode(channelInsidePrimitive, "interface"),
        (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
      );

      const ifaceInsidePrimitive = {
        id: "prim",
        kind: primitiveKind,
        children: [{ id: "sub", kind: "interface" }],
      } as unknown as ViewElementNode;
      assert.throws(
        () => validateNode(ifaceInsidePrimitive, "interface"),
        (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
      );
    }

    const validComponent: ComponentElementNode = {
      id: "comp",
      kind: "component",
      children: [
        {
          id: "ch",
          kind: "channel",
          mediaType: "video/h264",
          direction: "sense",
          deliveryMode: "stream",
        },
        { id: "slot", kind: "interface", type: "page" },
      ],
    };
    assert.doesNotThrow(() => validateNode(validComponent, "interface"));
  });

  it("enforces Channel leaf invariant, sibling uniqueness, acyclicity, View exclusivity, Control statelessness, Properties/State validation, and Invariant 9", () => {
    const lazyChannel: ChannelNode = {
      id: "cam",
      kind: "channel",
      mediaType: "video/h264",
      direction: "sense",
      deliveryMode: "stream",
      hasChildren: true,
    };
    assert.throws(
      () => validateNode(lazyChannel, "body"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );

    const channelWithChildren = {
      id: "cam",
      kind: "channel",
      mediaType: "video/h264",
      direction: "sense",
      deliveryMode: "stream",
      children: [],
    } as unknown as ChannelNode;
    assert.throws(
      () => validateNode(channelWithChildren, "body"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );

    const duplicateSiblings: BodyChild[] = [
      { id: "dup", kind: "ou" },
      { id: "dup", kind: "interface" },
    ];
    assert.throws(
      () => validateBody(duplicateSiblings),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );

    const multiBoundView: ViewElementNode = {
      id: "img",
      kind: "view",
      properties: { mediaType: "image/png", temporalMode: "static" },
      state: {
        value: "inline",
        binaryRef: { refId: "b-1", mediaType: "image/png" },
      },
    };
    assert.throws(
      () => validateNode(multiBoundView, "interface"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );

    const viewValueAndChannel: ViewElementNode = {
      id: "vid",
      kind: "view",
      state: {
        value: "frame",
        channelRef: "/cam",
      },
    };
    assert.throws(
      () => validateNode(viewValueAndChannel, "interface"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );

    const statefulControl: ControlElementNode = {
      id: "btn",
      kind: "control",
      type: "button",
      state: { value: "should-fail" },
    };
    assert.throws(
      () => validateNode(statefulControl, "interface"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );

    const transientControl: ControlElementNode = {
      id: "btn",
      kind: "control",
      type: "button",
      state: { focused: true, pressed: false },
    };
    assert.doesNotThrow(() => validateNode(transientControl, "interface"));

    assert.throws(
      () =>
        validateNode(
          {
            id: "v",
            kind: "view",
            properties: { temporalMode: "invalid-mode" },
          },
          "interface",
        ),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );

    assert.throws(
      () =>
        validateNode(
          {
            id: "v",
            kind: "view",
            properties: { bounds: { x: 0, y: 0, width: -1, height: 10 } },
          },
          "interface",
        ),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );

    assert.throws(
      () =>
        validateNode(
          {
            id: "v",
            kind: "view",
            properties: { "invalid key!": true },
          },
          "interface",
        ),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );

    // Invariant 9: table children must be structure column|row; row children must be structure cell
    const badTableChild: StructureElementNode = {
      id: "tbl",
      kind: "structure",
      type: "table",
      children: [{ id: "bad-cell", kind: "structure", type: "cell" }],
    };
    assert.throws(
      () => validateNode(badTableChild, "interface"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );

    const badTableViewChild: StructureElementNode = {
      id: "tbl",
      kind: "structure",
      type: "table",
      children: [{ id: "txt", kind: "view", type: "text" }],
    };
    assert.throws(
      () => validateNode(badTableViewChild, "interface"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );

    const badRowChild: StructureElementNode = {
      id: "tbl",
      kind: "structure",
      type: "table",
      children: [
        {
          id: "r1",
          kind: "structure",
          type: "row",
          children: [{ id: "txt", kind: "view", type: "text" }],
        },
      ],
    };
    assert.throws(
      () => validateNode(badRowChild, "interface"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );

    const cyclicOu: OUNode = { id: "loop", kind: "ou", children: [] };
    cyclicOu.children!.push(cyclicOu);
    assert.throws(
      () => validateNode(cyclicOu, "body"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );
  });

  it("validates state.channelRef resolution and mount containment rules", () => {
    const badTargetBody: BodyChild[] = [
      {
        id: "win",
        kind: "interface",
        children: [
          {
            id: "display",
            kind: "view",
            properties: { mediaType: "text/plain", temporalMode: "dynamic" },
            state: { channelRef: "/win" }, // points to Interface, not Channel
          },
        ],
      },
    ];
    assert.throws(
      () => validateChannelRefs(badTargetBody, true),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_REFERENCE,
    );

    const lazyBody: BodyChild[] = [
      {
        id: "lazy-host",
        kind: "ou",
        hasChildren: true,
      },
      {
        id: "win",
        kind: "interface",
        children: [
          {
            id: "feed",
            kind: "view",
            properties: { mediaType: "video/h264", temporalMode: "dynamic" },
            state: { channelRef: "/lazy-host/cam" },
          },
        ],
      },
    ];
    assert.doesNotThrow(() => validateChannelRefs(lazyBody, false));
    assert.throws(
      () => validateChannelRefs(lazyBody, true),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_REFERENCE,
    );

    // Mount containment checks
    assert.doesNotThrow(() =>
      validateMountContainment("interface", {
        path: "/",
        kind: "body",
        children: [{ id: "term", kind: "interface" }],
      }),
    );
    assert.doesNotThrow(() =>
      validateMountContainment("component", {
        path: "/",
        kind: "body",
        children: [
          {
            id: "cam",
            kind: "channel",
            mediaType: "video/h264",
            direction: "sense",
            deliveryMode: "stream",
          },
        ],
      }),
    );
    assert.throws(
      () =>
        validateMountContainment("component", {
          path: "/",
          kind: "body",
          children: [{ id: "sub-ou", kind: "ou" }],
        }),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );
    assert.throws(
      () =>
        validateMountContainment("interface", {
          path: "/",
          kind: "body",
          children: [{ id: "sub-ou", kind: "ou" }],
        }),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );
    assert.doesNotThrow(() => validateMountContainment("structure", { id: "iframe", kind: "interface" }));
    assert.doesNotThrow(() => validateMountContainment("structure", { id: "player", kind: "component" }));
    assert.doesNotThrow(() => validateMountContainment("document", { id: "guide-form", kind: "structure", type: "form" }));
    assert.doesNotThrow(() =>
      validateMountContainment("component", {
        id: "ch",
        kind: "channel",
        mediaType: "audio/opus",
        direction: "sense",
        deliveryMode: "stream",
      }),
    );
    assert.throws(
      () =>
        validateMountContainment(
          "structure",
          { id: "bad", kind: "view", type: "text" },
          "table",
        ),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );
    assert.throws(
      () => validateMountContainment("interface", { id: "sub-ou", kind: "ou" }),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );
  });
});
