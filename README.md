# durable-effect

Effectful abstractions for durable runtimes.

---

## The Problem

After using Cloudflare Durable Objects to solve various problems—event buffering, throttling, notification scheduling, queueing, DAG-like task management, workflows, and more—I kept falling into the same trap: too much business logic living inside each Durable Object.

Durable Objects are powerful, but their API is imperative. You're managing state, handling alarms, coordinating storage operations. The business logic gets tangled up with the infrastructure concerns.

When I picked up [Effect](https://effect.website/), everything clicked. Composable programs. Type-safe error handling. Dependency injection. But bridging the gap between effectful programs and the Durable Object API wasn't straightforward. Effect wants to own the world, and Durable Objects have their own opinions about how things should work.

## The Vision

This repo contains open-source abstractions on top of durable runtimes, aimed at making durable concepts more effectful.

The goal: write your business logic as pure Effect programs, and let the abstractions handle the durability concerns—persistence, retries, scheduling, resumption.

## Projects

### [@durable-effect/workflow](./packages/workflow)

The first project in this repo. Workflows are the most common way of structuring simple durable programs, so it made sense to start here.

This is also the first pass at making Durable Objects effectful. Things will change and evolve as more experience is gained. The patterns that work, the patterns that don't—it's all part of figuring out what "effectful durability" really means.

```typescript
const orderWorkflow = Workflow.make((orderId: string) =>
  Effect.gen(function* () {
    const order = yield* Workflow.step("Fetch", fetchOrder(orderId));
    yield* Workflow.sleep("24 hours");
    yield* Workflow.step("Charge", chargeCard(order));
  })
);
```

[Read the workflow docs →](./packages/workflow/README.md)

---

## Status

Experimental. APIs may change. Currently only supports Cloudflare Durable Objects as the execution engine.

More abstractions coming as patterns emerge from real-world usage.

---

Built by [Matthew Sessions](https://github.com/matthew-sessions) at [Backpine Labs](https://github.com/backpine)
