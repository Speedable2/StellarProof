# Webhooks

Webhook registrations are available at `/api/v1/developer/webhooks`. They are
scoped to the authenticated user. The plain `secret` is returned only when a
registration is created; save it securely. It is encrypted in MongoDB with
`WEBHOOK_SECRET_ENCRYPTION_KEY`, which must be a 32-byte key encoded as 64 hex
characters.

Create a registration with `POST /api/v1/developer/webhooks` and a JSON body
containing `url` and a non-empty `events` array. The supported event names are
`job.created`, `verification.completed`, `verification.failed`,
`certificate.minted`, and `kms.key_rotated`. The response includes the secret
once; subsequent list and update responses omit it. All registration endpoints
require an authenticated bearer token and are scoped to that account.

Each delivery is a JSON event envelope with an `id`, `type`, `occurredAt`, and
typed `data`. The sender serializes the envelope once and signs the exact bytes
sent. The `X-StellarProof-Signature` header is formatted as
`t=<unix-seconds>,v1=<hex-hmac>`. The HMAC-SHA256
input is `<timestamp>.<raw-request-body>`, keyed by the registration secret.

## Verify a delivery in Node.js

Capture the raw request bytes before JSON parsing, then validate the timestamp
and compare the digest in constant time:

```ts
import crypto from "node:crypto";
import express from "express";

const app = express();
app.post("/webhooks/stellarproof", express.raw({ type: "application/json" }), (req, res) => {
  const rawBody = req.body as Buffer;
  const header = req.header("X-StellarProof-Signature") ?? "";
  const match = /^t=(\d+),v1=([a-f0-9]{64})$/i.exec(header);
  if (!match) return res.sendStatus(401);

  const [, timestamp, receivedHex] = match;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return res.sendStatus(401);

  const expected = crypto
    .createHmac("sha256", process.env.STELLARPROOF_WEBHOOK_SECRET ?? "")
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest();
  const received = Buffer.from(receivedHex, "hex");
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    return res.sendStatus(401);
  }

  const event = JSON.parse(rawBody.toString("utf8"));
  // Process event.id idempotently; return a 2xx response after accepting it.
  return res.sendStatus(204);
});
```

Register the raw-body route before a global `express.json()` parser. A receiver
should deduplicate by event `id`, since retries can repeat the same event with a
fresh timestamp and signature. Delivery attempts use exponential backoff and
move to `dead_letter` after the configured attempt limit.

## Delivery history

`GET /api/v1/developer/webhooks/:id/deliveries?limit=20&skip=0` returns the
registration's stored delivery status, attempt count, response code, latency,
and a bounded payload preview. The endpoint only returns records owned by the
authenticated user.
