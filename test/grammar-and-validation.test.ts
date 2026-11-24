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
  type ContentElementNode,
  type InterfaceNode,
  type OUNode,
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
  it("accepts valid nested OU, Interface, Structure, Content, Input, and Channel nodes", () => {
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
            type: "desktop.window",
            children: [
              {
                id: "layout",
                kind: "structure",
                type: "desktop.panel",
                children: [
                  {
                    id: "term",
                    kind: "interface",
                    type: "desktop.terminal",
                    children: [
                      {
                        id: "scrollback",
                        kind: "content",
                        mediaType: "text/plain",
                        temporalMode: "dynamic",
                        value: "ready",
                      },
                    ],
                  },
                  {
                    id: "mic-in",
                    kind: "input",
                    mediaType: "audio/opus",
                    channelRef: "/workstation/sys-audio",
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

  it("rejects containment violations and disjoint NodeKind errors", () => {
    const ouInsideInterface: InterfaceNode = {
      id: "win",
      kind: "interface",
      children: [{ id: "bad", kind: "ou" } as unknown as InterfaceNode],
    };
    assert.throws(
      () => validateNode(ouInsideInterface, "body"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );

    const elementInsideOu: OUNode = {
      id: "host",
      kind: "ou",
      children: [
        {
          id: "lbl",
          kind: "content",
          mediaType: "text/plain",
          temporalMode: "static",
        } as unknown as OUNode,
      ],
    };
    assert.throws(
      () => validateNode(elementInsideOu, "body"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );

    const channelInsideStructure: InterfaceNode = {
      id: "win",
      kind: "interface",
      children: [
        {
          id: "panel",
          kind: "structure",
          children: [
            {
              id: "cam",
              kind: "channel",
              mediaType: "video/h264",
              direction: "sense",
              deliveryMode: "stream",
            } as unknown as InterfaceNode,
          ],
        },
      ],
    };
    assert.throws(
      () => validateNode(channelInsideStructure, "body"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );
  });

  it("enforces Channel leaf invariant, sibling uniqueness, acyclicity, and Content exclusivity", () => {
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

    const multiBoundContent: ContentElementNode = {
      id: "img",
      kind: "content",
      mediaType: "image/png",
      temporalMode: "static",
      value: "inline",
      binaryRef: { refId: "b-1", mediaType: "image/png" },
    };
    assert.throws(
      () => validateNode(multiBoundContent, "interface"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );

    const cyclicOu: OUNode = { id: "loop", kind: "ou", children: [] };
    cyclicOu.children!.push(cyclicOu);
    assert.throws(
      () => validateNode(cyclicOu, "body"),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );
  });

  it("validates ChannelRef resolution and mount containment rules", () => {
    const badTargetBody: BodyChild[] = [
      {
        id: "win",
        kind: "interface",
        children: [
          {
            id: "display",
            kind: "content",
            mediaType: "text/plain",
            temporalMode: "dynamic",
            channelRef: "/win", // points to Interface, not Channel
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
            kind: "content",
            mediaType: "video/h264",
            temporalMode: "dynamic",
            channelRef: "/lazy-host/cam",
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
    assert.throws(
      () => validateMountContainment("interface", { id: "sub-ou", kind: "ou" }),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INVALID_MESSAGE,
    );
  });
});
