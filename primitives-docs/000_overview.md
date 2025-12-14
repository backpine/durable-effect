## Durable Effect Primitives

As a follow-up to durable-effect/workflows, primatives are designed to help solve general durable compute use cases.

The backstory here is that I often create a DurableObject,

Build out the state at the top level.
Create a constructor that blocks cucurrenty and pull states from storage.

Has rpc methods to trigger actions or save data, or set alarms.
Then alarms fire to run some compute.

### Example 1
We have google oath tokens. We have a rpc method saveTokens that take in the tokens and set an alarm for 59 minutes into the future.

When the alarm fires it calls logic that refreshes the tokens, and sets another alarm for 59 minutes into the future.

The core alarm logic is wrapped in a try catch that will always set a future alarm.

The only way we can stop is to call an rpc method, kill that deletes all the storage.

### Example 2
Durable object with a method to syncContact.

many contact update events flow into this method, and the method saves the most recent event. first event it sets an alarm of 8 seconds into the future.

When the alarm fires it calls logic that processes the contact and deletes all state.

This acts as a buffer to eat many unneeded transations in a system.

### Problem, I have many Durable Objects with their own custom logic and I am very locked into Durable Objects.


I want to create a new package called durable-effect/primatives

that handle the core durable lifecycle, so I can just focus on writing effectful business logic.

Here is an example API for this library (not the real think, just an example. it is missing features):
```ts
const { Primitives, PrimitiveClient } = createDurablePrimitives({
  // Continuous processes
  tokenRefresher: Continuous.make({
    interval: "30 minutes",
    execute: () => refreshAccessToken(),
    shouldStop: (state) => state.revoked,
  }),
  // Buffers
  eventBuffer: Buffer.make({
    maxItems: 100,
    maxWait: "5 minutes",
    flush: (items) => sendToAnalytics(items),
  }),
  // Queues
   webhookQueue: Queue.make({
    process: (webhook) => deliverWebhook(webhook),
    concurrency: 10,
    retry: { maxAttempts: 5, delay: Backoff.exponential({ base: "1 second" }) },
  }),
  // Semaphores / Rate Limiters
  apiRateLimiter: Semaphore.make({
    permits: 100,
    window: "1 minute",
  })
}, {
  tracker: { endpoint: "https://events.example.com/ingest" },
});
```

### Simplification audit (current primitives package)

1. **Trim unimplemented buffer/queue surface area** — the runtime only routes continuous requests but the public API still exposes buffer/queue clients, request/response types, registry slots, and storage keys (`packages/primitives/src/runtime/dispatcher.ts:68-121`, `packages/primitives/src/client/client.ts:186-507`, `packages/primitives/src/runtime/types.ts`, `packages/primitives/src/storage-keys.ts`). This overpromises working features and bloats the bundle. Either hide these until handlers exist or gate them behind an explicit “experimental” flag.
2. **[DONE] Remove or wire the unused tracker plumbing** — removed the unused tracker config path from the factory/engine/runtime to avoid dead options and confusion.
3. **[DONE] Collapse continuous execution to one path** — dropped the deprecated executor file/exports so only the inline handler path remains.
4. **[DONE] Fail fast when registry/config is missing** — runtime now requires a registry and throws if absent; the engine guards env injection accordingly.
5. **[DONE] Make schedule semantics explicit** — cron schedules now fail immediately instead of silently defaulting; Duration-based intervals remain validated by Effect.
6. **[DONE] Tighten status/metadata to active primitives** — pared the status union down to the continuous lifecycle values in use.
7. **[DONE] Remove minor unused/duplicated pieces** — removed unused imports/exports (e.g., `Ref`, tracker options, primitive executor helper) to keep the surface lean while only continuous is implemented.
