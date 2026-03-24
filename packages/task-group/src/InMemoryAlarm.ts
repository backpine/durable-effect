import { Effect, Layer } from "effect"
import { Alarm } from "./services/Alarm.js"

// ---------------------------------------------------------------------------
// InMemoryAlarm — test/dev implementation of Alarm
// ---------------------------------------------------------------------------

export interface InMemoryAlarmHandle {
  readonly getScheduledTime: () => number | null
  readonly isScheduled: () => boolean
  readonly clear: () => void
}

export function makeInMemoryAlarm(): {
  layer: Layer.Layer<Alarm>
  handle: InMemoryAlarmHandle
} {
  let scheduledTime: number | null = null

  const handle: InMemoryAlarmHandle = {
    getScheduledTime: () => scheduledTime,
    isScheduled: () => scheduledTime !== null,
    clear: () => { scheduledTime = null },
  }

  const layer = Layer.succeed(Alarm, {
    set: (timestamp) => Effect.sync(() => { scheduledTime = timestamp }),
    cancel: () => Effect.sync(() => { scheduledTime = null }),
    next: () => Effect.sync(() => scheduledTime),
  })

  return { layer, handle }
}
