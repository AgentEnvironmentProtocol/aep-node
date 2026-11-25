# aep-node

Node.js / TypeScript implementation of the **Agent Environment Protocol (AEP)** (`1.0.0-beta.0`), providing:

- **Core Protocol Model, Validation & Version Negotiation** (`.`) — Formal EBNF tree node types across all 11 `NodeKind`s (`ou`, `interface`, `api`, `endpoint`, `channel`, `structure`, `component`, `document`, `view`, `editable`, `control`), unified node object anatomy (`uid`, `revision`, `properties`, `state`, `methods`, `events`, `meta`, `ElevationSpec`), core built-in `TypeTag`s, canonical `Path` addressing, static/semantic invariant validators, SemVer protocol version negotiation & adaptation (`negotiateProtocolVersion`, `ProtocolVersionAdapter`, `createLegacyVersionAliasAdapter`), `aep-core-static` / `aep-core-streaming` capability negotiation, composable `tree.query` filtering, client-side `renderMinimal` synthesis (`synthesizeRenderMinimal`), and `aep.config.json` manifest loading/validation/secret interpolation (`loadAepConfig`, `validateAepConfig`, `interpolateSecrets`, `redactConfig`).
- **Server Runtime** (`aep-node/server`) — `AepServer` with SemVer version negotiation & `versionAdapters`, post-handshake envelope version enforcement, session lifecycle, `session.authenticate` (including two-step `challenge-response` and in-session token rotation), `session.resume` with `seq` replay, cooperative subtree leases (`session.acquireLease` / `session.releaseLease`), privilege elevation (`session.elevate` / `session.dropElevation` + audit hook), optimistic concurrency (`expectedRevision`), `moveNode` (`node.moved` + `uid` tracking), concurrency policies (`single-controller`, `multi-controller`, `isolated`), `controller`/`observer` role enforcement, `node.invoke`, lazy `node.loadChildren`, discrete `data.getBinary`, multi-tier `data.render`, `channel.*` binary and structured `event` streaming with `stream+seek` and fan-out, and transparent passthrough mounting (`server.mount(...)`).
- **Client Runtime** (`aep-node/client`) — `AepClient` with automatic `UNSUPPORTED_VERSION` adaptation & `versionAdapters`, optional live `syncTree` mirroring, authentication/resumption/lease/elevation helpers, local `renderMinimal` synthesis, `ClientChannelSubscription` (`AsyncIterable` + callbacks for binary and event frames), and `AepCompositeClient` for multi-server "Body of Senses" assembly.
- **Transport & Codec Layer** (`aep-node/transport`) — Pluggable `Codec` and `Transport` / `TransportServer` interfaces with built-in In-Memory (`MemoryTransport`, `MemoryTransportHub`), Node Stream / IPC (`StreamTransport`, `NetStreamServer`, `connectNetStream`), and RFC 6455 WebSocket (`WebSocketTransport`, `WebSocketTransportServer`, `connectWebSocket` with `aep.v1` subprotocol negotiation) bindings.

## Scripts

```bash
npm run build
npm run typecheck
npm test
```

## Quick Example

```ts
import { AepServer } from "aep-node/server";
import { AepClient } from "aep-node/client";
import { createMemoryTransportPair } from "aep-node/transport";

const server = new AepServer({
  body: [
    {
      id: "workstation",
      kind: "ou",
      type: "desktop.host",
      children: [
        {
          id: "main",
          kind: "interface",
          type: "window",
          children: [
            {
              id: "hello",
              kind: "view",
              type: "text",
              properties: {
                mediaType: "text/plain",
                temporalMode: "static",
              },
              state: {
                value: "Hello AEP",
              },
            },
          ],
        },
      ],
    },
  ],
});

const [clientTransport, serverTransport] = createMemoryTransportPair();
server.accept(serverTransport);

const client = await AepClient.connect(clientTransport);
const { node } = await client.getTree({ path: "/" });
console.log(node);
await client.close();
await server.close();
```
