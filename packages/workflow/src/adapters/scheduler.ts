// packages/workflow/src/adapters/scheduler.ts

import { Context, Effect } from "effect";
import type { SchedulerError } from "../errors";

/**
 * Abstract scheduler interface for delayed execution.
 *
 * Implementations provide runtime-specific scheduling:
 * - Durable Objects: storage.setAlarm()
 * - Testing: In-memory timer simulation
 * - Future: Redis queues, database polling, etc.
 */
export interface SchedulerAdapterService {
  /**
   * Schedule execution at a specific timestamp (ms since epoch).
   * Only one alarm can be scheduled at a time - overwrites previous.
   */
  readonly schedule: (time: number) => Effect.Effect<void, SchedulerError>;

  /**
   * Cancel any scheduled execution.
   * No-op if nothing scheduled.
   */
  readonly cancel: () => Effect.Effect<void, SchedulerError>;

  /**
   * Get the currently scheduled time (if any).
   * Returns undefined if nothing scheduled.
   */
  readonly getScheduled: () => Effect.Effect<
    number | undefined,
    SchedulerError
  >;
}

/**
 * Effect service tag for SchedulerAdapter.
 */
export class SchedulerAdapter extends Context.Tag(
  "@durable-effect/SchedulerAdapter",
)<SchedulerAdapter, SchedulerAdapterService>() {}
