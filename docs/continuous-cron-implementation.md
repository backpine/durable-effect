# Implementing Cron Support for Continuous Jobs

## Current State

Cron schedules are defined but not implemented. In `handler.ts:80-97`:

```typescript
const scheduleNext = (def: StoredContinuousDefinition<any, any>) => {
  const schedule = def.schedule;
  switch (schedule._tag) {
    case "Every":
      return alarm.schedule(schedule.interval);
    case "Cron":
      return Effect.fail(new ExecutionError({...}));  // Not implemented
  }
};
```

## Solution

Effect has a built-in `Cron` module. Use `Cron.next(cron, after)` to get the next execution time.

---

## Implementation

### Step 1: Update ContinuousSchedule Type

Store the parsed `Cron` instance instead of just the expression string.

In `registry/types.ts`:

```typescript
import { Cron } from "effect";

export type ContinuousSchedule =
  | { readonly _tag: "Every"; readonly interval: Duration.DurationInput }
  | { readonly _tag: "Cron"; readonly cron: Cron.Cron };
```

### Step 2: Update Definition Factory

In `definitions/continuous.ts`:

```typescript
import { Cron, DateTime } from "effect";

export const Continuous = {
  // ... make stays the same

  every: (interval: Duration.DurationInput): ContinuousSchedule => ({
    _tag: "Every",
    interval,
  }),

  /**
   * Create a cron schedule.
   *
   * @example
   * ```ts
   * Continuous.cron("0 0 4 * * *")           // 4am daily
   * Continuous.cron("0 0 9 * * 1", "UTC")    // 9am every Monday UTC
   * ```
   */
  cron: (expression: string, tz?: string): ContinuousSchedule => {
    const timezone = tz ? DateTime.zoneUnsafeMakeNamed(tz) : undefined;
    const cron = Cron.unsafeParse(expression, timezone);
    return {
      _tag: "Cron",
      cron,
    };
  },
};
```

### Step 3: Update scheduleNext in handler.ts

```typescript
import { Cron } from "effect";

const scheduleNext = (
  def: StoredContinuousDefinition<any, any>,
): Effect.Effect<void, SchedulerError | ExecutionError> => {
  const schedule = def.schedule;
  switch (schedule._tag) {
    case "Every":
      return alarm.schedule(schedule.interval);
    case "Cron":
      return Effect.gen(function* () {
        const now = yield* runtime.now();
        const nextDate = Cron.next(schedule.cron, new Date(now));
        yield* alarm.schedule(nextDate);
      });
  }
};
```

---

## File Changes

| File | Change |
|------|--------|
| `src/registry/types.ts` | Change `ContinuousSchedule` Cron variant to store `Cron.Cron` |
| `src/definitions/continuous.ts` | Update `cron()` to parse expression into `Cron.Cron` |
| `src/handlers/continuous/handler.ts` | Update `scheduleNext` to use `Cron.next()` |

---

## Usage

```typescript
const dailyReport = Continuous.make({
  stateSchema: Schema.Struct({ count: Schema.Number }),
  schedule: Continuous.cron("0 0 9 * * *"),  // 9am daily
  execute: (ctx) => Effect.gen(function* () {
    yield* ctx.updateState((s) => ({ count: s.count + 1 }));
  }),
});

// With timezone
const weeklySync = Continuous.make({
  stateSchema: Schema.Struct({ cursor: Schema.NullOr(Schema.String) }),
  schedule: Continuous.cron("0 0 9 * * 1", "America/New_York"),  // 9am Monday EST
  execute: (ctx) => Effect.succeed(void 0),
});
```

---

## Notes

- `Cron.next(cron, after)` returns a `Date` - pass directly to `alarm.schedule()`
- `Cron.unsafeParse()` throws on invalid expression - fails fast at job definition time
- Timezone support via `DateTime.zoneUnsafeMakeNamed()`
- No external dependencies needed
