import { Effect, Schema } from "effect"
import { Task } from "@backpine/task-v2"
import { createTasks } from "@backpine/task-v2/cloudflare"

const CounterState = Schema.Struct({
  count: Schema.Number,
})

const StartEvent = Schema.Struct({
  _tag: Schema.Literal("Start"),
})

const counter = Task.define({
  state: CounterState,
  event: StartEvent,
  onEvent: (ctx, _event) =>
    Effect.gen(function* () {
      yield* Effect.log(`[${ctx.name}:${ctx.id}] Starting counter`)
      yield* ctx.save({ count: 0 })
      yield* ctx.scheduleIn("2 seconds")
      yield* Effect.log(`[${ctx.name}:${ctx.id}] Alarm scheduled in 2s`)
    }),
  onAlarm: (ctx) =>
    Effect.gen(function* () {
      const current = yield* ctx.recall()
      const count = (current?.count ?? 0) + 1
      yield* ctx.save({ count })
      yield* Effect.log(`[${ctx.name}:${ctx.id}] Alarm fired — count=${count}`)

      if (count >= 10) {
        yield* Effect.log(`[${ctx.name}:${ctx.id}] Reached 10, purging`)
        yield* ctx.purge()
      }

      yield* ctx.scheduleIn("2 seconds")
      yield* Effect.log(`[${ctx.name}:${ctx.id}] Next alarm in 2s`)
    }),
})

export const { TasksDO, tasks } = createTasks({ counter })
