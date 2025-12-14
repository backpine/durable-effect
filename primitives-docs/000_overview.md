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
