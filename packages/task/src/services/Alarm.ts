import { Data, Effect, ServiceMap } from "effect"

export class AlarmError extends Data.TaggedError("AlarmError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class Alarm extends ServiceMap.Service<Alarm, {
  readonly set: (timestamp: number) => Effect.Effect<void, AlarmError>
  readonly cancel: () => Effect.Effect<void, AlarmError>
  readonly next: () => Effect.Effect<number | null, AlarmError>
}>()("@task/Alarm") {}
