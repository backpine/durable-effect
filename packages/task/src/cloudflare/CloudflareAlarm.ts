import { Effect, Layer } from "effect"
import { Alarm, AlarmError } from "../services/Alarm.js"

// ---------------------------------------------------------------------------
// Minimal structural interface — compatible with CF DurableObjectStorage
// ---------------------------------------------------------------------------

export interface DurableObjectAlarmMethods {
  setAlarm(scheduledTime: number | Date): Promise<void>
  deleteAlarm(): Promise<void>
  getAlarm(): Promise<number | Date | null>
}

// ---------------------------------------------------------------------------
// CloudflareAlarm — wraps CF alarm methods into the Alarm service
// ---------------------------------------------------------------------------

export function makeCloudflareAlarm(
  doStorage: DurableObjectAlarmMethods,
): Layer.Layer<Alarm> {
  return Layer.succeed(Alarm, {
    set: (timestamp) =>
      Effect.tryPromise({
        try: () => doStorage.setAlarm(timestamp),
        catch: (cause) =>
          new AlarmError({ message: "Failed to set alarm", cause }),
      }),

    cancel: () =>
      Effect.tryPromise({
        try: () => doStorage.deleteAlarm(),
        catch: (cause) =>
          new AlarmError({ message: "Failed to cancel alarm", cause }),
      }),

    next: () =>
      Effect.tryPromise({
        try: () => doStorage.getAlarm(),
        catch: (cause) =>
          new AlarmError({ message: "Failed to get next alarm", cause }),
      }).pipe(
        Effect.map((v): number | null => {
          if (v == null) return null
          if (v instanceof Date) return v.getTime()
          if (typeof v === "number") return v
          return null
        }),
      ),
  })
}
