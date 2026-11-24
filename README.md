# aep-node

Node.js / TypeScript implementation of the **Agent Environment Protocol (AEP)** (`1.0.0-draft`), providing:

- **Core Protocol Model & Validation** (`.`) — Formal EBNF tree node types across all 9 `NodeKind`s (`ou`, `interface`, `channel`, `structure`, `component`, `document`, `view`, `editable`, `control`), unified node object anatomy (`properties`, `state`, `methods`, `events`, `meta`), core built-in `TypeTag`s, canonical `Path` addressing, static/semantic invariant validators, `aep-core-static` / `aep-core-streaming` capability negotiation, and composable `tree.query` filtering.
- **Server Runtime** (`aep-node/server`) — `AepServer` with session lifecycle & concurrency policies (`single-controller`, `multi-controller`, `isolated`), `controller`/`observer` role enforcement, `node.invoke`, lazy `node.loadChildren`, discrete `data.getBinary`, `channel.*` streaming with `stream+seek` and fan-out, and transparent passthrough mounting (`server.mount(...)`).
- **Client Runtime** (`aep-node/client`) — `AepClient` with optional live `syncTree` mirroring, `ClientChannelSubscription` (`AsyncIterable` + callbacks), and `AepCompositeClient` for multi-server "Body of Senses" assembly.
- **Transport & Codec Layer** (`aep-node/transport`) — Pluggable `Codec` and `Transport` / `TransportServer` interfaces with built-in In-Memory (`MemoryTransport`, `MemoryTransportHub`), Node Stream / IPC (`StreamTransport`, `NetStreamServer`, `connectNetStream`), and RFC 6455 WebSocket (`WebSocketTransport`, `WebSocketTransportServer`, `connectWebSocket`) bindings.

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
