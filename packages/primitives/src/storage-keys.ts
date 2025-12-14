// packages/jobs/src/storage-keys.ts

/**
 * Centralized storage key constants for all jobs.
 * Using a single namespace ensures no collisions and makes debugging easier.
 */
export const KEYS = {
  // Metadata (all jobs)
  META: "meta",

  // User state (schema-validated)
  STATE: "state",

  // Continuous-specific
  CONTINUOUS: {
    RUN_COUNT: "cont:runCount",
    LAST_EXECUTED_AT: "cont:lastAt",
  },

  // Debounce-specific
  DEBOUNCE: {
    EVENT_COUNT: "deb:count",
    STARTED_AT: "deb:startedAt",
  },

  // WorkerPool-specific
  WORKER_POOL: {
    EVENTS: "wp:events:", // prefix: wp:events:{eventId}
    PENDING: "wp:pending", // array of pending event IDs
    PROCESSED: "wp:processed",
    CURRENT: "wp:current",
    ATTEMPT: "wp:attempt",
    PAUSED: "wp:paused",
  },

  // Idempotency
  IDEMPOTENCY: "idem:", // prefix: idem:{eventId}
} as const;
