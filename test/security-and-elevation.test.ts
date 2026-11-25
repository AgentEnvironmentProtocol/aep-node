import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AEP_ERROR_CODES,
  AepError,
  type ElevationAuditRecord,
  type ElevationChallengeData,
} from "aep-node";
import { AepClient } from "aep-node/client";
import { AepServer } from "aep-node/server";
import { MemoryTransport, createMemoryTransportPair } from "aep-node/transport";

describe("Security, Authentication, and Privilege Elevation", () => {
  it("supports two-step challenge-response authentication, in-session refresh, token expiry, and insecure transport checks", async () => {
    let activeToken = "jwt-v1";
    const server = new AepServer({
      security: {
        allowedModes: ["bearer", "challenge-response"],
        issueChallenge: (sec) => ({
          challenge: {
            challengeId: "chg-1",
            algorithm: "ed25519",
            nonce: "nonce-abc",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
          verify: (authParams) => {
            if (authParams.signature !== "sig:nonce-abc") {
              return null;
            }
            return {
              mode: "challenge-response",
              keyId: sec?.keyId ?? "agent-key-1",
              principal: { id: "agent-01", kind: "agent", scopes: ["tree.read"] },
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            };
          },
        }),
        authenticateRefresh: (params) => {
          if (params.mode === "bearer" && params.token === "jwt-v2") {
            activeToken = "jwt-v2";
            return {
              mode: "bearer",
              token: params.token,
              principal: { id: "agent-01", kind: "agent", scopes: ["tree.read"] },
              expiresAt: new Date(Date.now() + 120_000).toISOString(),
            };
          }
          return null;
        },
      },
      body: [
        {
          id: "svc",
          kind: "api",
          type: "service",
          methods: [{ name: "ping", sideEffects: "read" }],
        },
      ],
    });
    server.registerMethod("/svc", "ping", () => ({ pong: activeToken }));

    // 1. Reject insecure non-loopback bearer attempt
    const insecureClient = new MemoryTransport({
      peerIdentity: { nonLoopbackPlaintext: true },
    });
    const insecureServer = new MemoryTransport({
      peerIdentity: { nonLoopbackPlaintext: true },
    });
    insecureClient.attachPeer(insecureServer);
    insecureServer.attachPeer(insecureClient);
    server.accept(insecureServer);
    const badTransportClient = new AepClient(insecureClient);
    await assert.rejects(
      () => badTransportClient.initialize({ security: { mode: "bearer", token: "secret" } }),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.INSECURE_TRANSPORT,
    );
    await badTransportClient.close();

    // 2. Two-step challenge-response handshake
    const [ct, st] = createMemoryTransportPair();
    const handle = server.accept(st);
    const client = new AepClient(ct);

    const initRes = await client.initialize({
      security: { mode: "challenge-response", keyId: "agent-key-1" },
    });
    assert.equal(initRes.authRequired, true);
    assert.equal(initRes.challenge?.challengeId, "chg-1");
    assert.equal(client.isInitialized, false);

    // Pre-auth RPC fails with AUTHENTICATION_REQUIRED
    await assert.rejects(
      () => client.getTree({ path: "/" }),
      (err: unknown) =>
        err instanceof AepError && err.code === AEP_ERROR_CODES.AUTHENTICATION_REQUIRED,
    );

    // Bad signature fails with AUTHENTICATION_FAILED
    await assert.rejects(
      () =>
        client.authenticate({
          mode: "challenge-response",
          challengeId: "chg-1",
          signature: "wrong-sig",
        }),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.AUTHENTICATION_FAILED,
    );

    // Valid signature completes authentication
    const authRes = await client.authenticate({
      mode: "challenge-response",
      challengeId: "chg-1",
      signature: "sig:nonce-abc",
    });
    assert.equal(authRes.authenticated, true);
    assert.equal(client.isInitialized, true);
    assert.equal(client.security?.principal?.id, "agent-01");

    // 3. authExpiring notification & in-session token rotation
    const warnings: Array<{ expiresAt: string; remainingMs: number }> = [];
    client.onAuthExpiring((ev) => warnings.push(ev));
    await server.emitAuthExpiring(handle.sessionId, "2026-11-25T13:00:00.000Z", 30_000);
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.remainingMs, 30_000);

    const refreshed = await client.authenticate({ mode: "bearer", token: "jwt-v2" });
    assert.equal(refreshed.authenticated, true);
    const pingRes = await client.invoke<{ pong: string }>("/svc", "ping");
    assert.equal(pingRes.result.pong, "jwt-v2");

    // 4. Hard expiry -> TOKEN_EXPIRED
    const [ctExp, stExp] = createMemoryTransportPair();
    const expServer = new AepServer({
      security: {
        allowedModes: ["bearer"],
        authenticate: () => ({
          mode: "bearer",
          principal: { id: "agent-exp", kind: "agent" },
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
        authenticateRefresh: (p) => ({
          mode: p.mode,
          token: p.token,
          principal: { id: "agent-exp", kind: "agent" },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      },
      body: [{ id: "svc", kind: "api", type: "service" }],
    });
    expServer.accept(stExp);
    const expClient = await AepClient.connect(ctExp, {
      security: { mode: "bearer", token: "expired-jwt" },
    });
    await assert.rejects(
      () => expClient.getTree({ path: "/" }),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.TOKEN_EXPIRED,
    );
    await expClient.authenticate({ mode: "bearer", token: "fresh-jwt" });
    const treeOk = await expClient.getTree({ path: "/" });
    assert.equal(treeOk.node.kind, "body");

    await expClient.close();
    await expServer.close();
    await client.close();
    await server.close();
  });

  it("enforces privilege elevation challenges, singleUse grants, async human-approval, dropElevation, audit logs, and mount boundaries", async () => {
    const audits: ElevationAuditRecord[] = [];

    const billingServer = new AepServer({
      capabilities: {
        sessions: { policy: "multi-controller" },
      },
      security: {
        allowedModes: ["unauthenticated"],
        elevation: {
          enabled: true,
          maxDurationMs: 60_000,
          onAudit: (rec) => audits.push(rec),
        },
      },
      body: [
        {
          id: "billing",
          kind: "api",
          type: "rest",
          properties: {
            elevation: {
              level: "confirm",
              scopes: ["billing.read"],
            },
          },
          children: [
            {
              id: "inv-42",
              kind: "endpoint",
              type: "resource",
              methods: [
                {
                  name: "refund",
                  sideEffects: "write",
                  elevation: {
                    level: "elevated",
                    scopes: ["billing.refund.execute"],
                    allowedFactors: ["human-approval", "token"],
                    requireReason: true,
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    billingServer.registerMethod("/billing/inv-42", "refund", (params) => ({
      refundId: "ref-901",
      amount: (params as { amount: number }).amount,
    }));

    const [ct, st] = createMemoryTransportPair();
    billingServer.accept(st);
    const client = await AepClient.connect(ct);

    // 1. Calling elevated method without grantId triggers ELEVATION_REQUIRED
    let challengeData: ElevationChallengeData | undefined;
    await assert.rejects(
      () => client.invoke("/billing/inv-42", "refund", { amount: 250 }),
      (err: unknown) => {
        if (err instanceof AepError && err.code === AEP_ERROR_CODES.ELEVATION_REQUIRED) {
          challengeData = err.data as ElevationChallengeData;
          return true;
        }
        return false;
      },
    );
    assert.equal(challengeData?.targetPath, "/billing/inv-42");
    assert.equal(challengeData?.level, "elevated");
    assert.deepEqual(challengeData?.requiredScopes, ["billing.read", "billing.refund.execute"]);
    assert.ok(challengeData?.instructions.includes("/billing/inv-42"));

    // 2. Request async human-approval -> pending -> resolveElevation -> session.elevationUpdated
    const updates: Array<{ grantId: string; status: string }> = [];
    client.onElevationUpdated((ev) => updates.push({ grantId: ev.grantId, status: ev.status }));

    const pendingGrant = await client.elevate({
      challengeId: challengeData!.challengeId,
      targetPath: "/billing/inv-42",
      level: "elevated",
      scopes: ["billing.read", "billing.refund.execute"],
      reason: "User approved USD 250 refund for inv-42",
      singleUse: true,
      factor: { type: "human-approval" },
    });
    assert.equal(pendingGrant.status, "pending");

    await billingServer.resolveElevation(pendingGrant.grantId, "granted", "Operator approved");
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(updates[0]?.status, "granted");

    // 3. Execute with singleUse grantId -> succeeds once, then second call fails with ELEVATION_EXPIRED
    const refundRes = await client.invoke<{ refundId: string; amount: number }>(
      "/billing/inv-42",
      "refund",
      { amount: 250 },
      { grantId: pendingGrant.grantId },
    );
    assert.equal(refundRes.result.refundId, "ref-901");

    await assert.rejects(
      () =>
        client.invoke(
          "/billing/inv-42",
          "refund",
          { amount: 250 },
          { grantId: pendingGrant.grantId },
        ),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.ELEVATION_EXPIRED,
    );

    // 4. Token-factor grant & dropElevation
    const tokenGrant = await client.elevate({
      targetPath: "/billing/inv-42",
      level: "elevated",
      scopes: ["billing.read", "billing.refund.execute"],
      reason: "Automated policy token",
      singleUse: false,
      factor: { type: "token", proof: "step-up-tok" },
    });
    assert.equal(tokenGrant.status, "granted");
    const dropRes = await client.dropElevation(tokenGrant.grantId);
    assert.deepEqual(dropRes.dropped, [tokenGrant.grantId]);

    assert.ok(audits.some((a) => a.outcome === "executed" && a.grantId === pendingGrant.grantId));
    assert.ok(audits.some((a) => a.outcome === "dropped" && a.grantId === tokenGrant.grantId));

    // 5. Passthrough mount boundary: allowElevation=false blocks downstream ELEVATION_REQUIRED; allowElevation=true forwards & rebases
    const hostBlocked = new AepServer();
    const [m1c, m1s] = createMemoryTransportPair();
    billingServer.accept(m1s);
    await hostBlocked.mount({
      anchorPath: "/services",
      client: new AepClient(m1c),
      allowElevation: false,
    });
    const [h1c, h1s] = createMemoryTransportPair();
    hostBlocked.accept(h1s);
    const blockedClient = await AepClient.connect(h1c);
    await assert.rejects(
      () => blockedClient.invoke("/services/billing/inv-42", "refund", { amount: 10 }),
      (err: unknown) => err instanceof AepError && err.code === AEP_ERROR_CODES.ELEVATION_DENIED,
    );

    const hostAllowed = new AepServer();
    const [m2c, m2s] = createMemoryTransportPair();
    billingServer.accept(m2s);
    await hostAllowed.mount({
      anchorPath: "/services",
      client: new AepClient(m2c),
      allowElevation: true,
    });
    const [h2c, h2s] = createMemoryTransportPair();
    hostAllowed.accept(h2s);
    const allowedClient = await AepClient.connect(h2c);
    await assert.rejects(
      () => allowedClient.invoke("/services/billing/inv-42", "refund", { amount: 10 }),
      (err: unknown) =>
        err instanceof AepError &&
        err.code === AEP_ERROR_CODES.ELEVATION_REQUIRED &&
        (err.data as ElevationChallengeData).targetPath === "/services/billing/inv-42",
    );

    await allowedClient.close();
    await hostAllowed.close();
    await blockedClient.close();
    await hostBlocked.close();
    await client.close();
    await billingServer.close();
  });
});
