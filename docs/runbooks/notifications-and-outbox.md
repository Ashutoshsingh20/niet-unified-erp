# Notification centre and outbox runbook

## Notification privacy model

The NIET server stores the complete notification and returns it only through the authenticated notification API. External mobile push is disabled by default. A push event is created only when:

1. the active template explicitly allows external push; and
2. the recipient has explicitly enabled external push.

The event sent toward APNs or Android notification infrastructure contains one opaque `eventId` and nothing else. It contains no title, body, name, identifier, action path, result, fee, attendance, case, or other confidential data. After receiving the event, the app authenticates to NIET and refreshes the notification centre.

If NIET chooses zero external cloud operation, do not deploy an external push consumer. The in-app inbox continues to work through authenticated refresh and future foreground WebSocket synchronization.

## Template lifecycle

- Templates are text-only, versioned, and begin in `DRAFT`.
- Placeholders and required variables must match exactly.
- Variables are bounded strings and are substituted once; they are never evaluated as templates or HTML.
- Publishing retires the previous active version.
- Classification and scope are selected by the authorized sender for every notification.

## Recipient controls

- Inbox queries always bind to the authenticated subject and cannot request another recipient.
- Read state is idempotent.
- External-push preference changes use optimistic concurrency and immutable audit evidence.
- Expired and archived notifications are excluded from the active inbox.

## Transactional outbox

Business transactions write domain state, audit evidence, and outbox events in the same PostgreSQL transaction. The worker:

1. locks one eligible event using `FOR UPDATE SKIP LOCKED`;
2. publishes a persistent RabbitMQ message to a durable topic exchange;
3. waits for a publisher confirm;
4. records `published_at` and commits.

If the broker rejects or disconnects, the transaction records a sanitized error, increments attempts, and schedules bounded exponential retry. After the configured maximum attempts, `failed_at` is set for operator intervention.

Delivery is **at least once**, not exactly once. A worker can publish successfully and lose its database connection before committing. Every consumer must store the event ID in an inbox/idempotency table and make duplicate handling safe.

## Monitoring

Alert on:

- oldest publishable event age;
- unpublished event count;
- terminal `failed_at` events;
- repeated broker reconnects;
- opaque push failures and consent anomalies;
- notification creation spikes by actor, scope, or template.

Never include event payloads, AMQP URLs, credentials, notification text, or recipient identifiers in routine worker logs.

## Verification

```bash
npm run verify
DATABASE_URL='postgresql://.../niet_erp_test' npm run notifications:verify
DATABASE_URL='postgresql://.../niet_erp_test' \
AMQP_URL='amqp://test-user:test-password@127.0.0.1:5672' \
npm run outbox:verify
```

The notification verifier structurally asserts that `OpaquePushRequested.payload` has exactly one property: `eventId`.

