import { Effect } from "effect"
import type { Alarm } from "../services/Alarm.js"
import { AlarmError } from "../services/Alarm.js"
import type { DurableObjectStorageLike } from "./types.js"

// ---------------------------------------------------------------------------
// Wraps CF DurableObjectStorage alarm methods into the Alarm service.
// ---------------------------------------------------------------------------

export function makeCloudflareAlarm(doStorage: DurableObjectStorageLike): Alarm["Service"] {
  return {
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
          if (typeof v === "number") return v
          return null
        }),
      ),
  }
}
