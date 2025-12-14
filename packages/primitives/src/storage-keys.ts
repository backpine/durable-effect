// packages/primitives/src/storage-keys.ts

/**
 * Centralized storage key constants for all primitives.
 * Using a single namespace ensures no collisions and makes debugging easier.
 */
export const KEYS = {
  // Metadata (all primitives)
  META: "meta",

  // User state (schema-validated)
  STATE: "state",

  // Continuous-specific
  CONTINUOUS: {
    RUN_COUNT: "cont:runCount",
    LAST_EXECUTED_AT: "cont:lastAt",
  },

  // Buffer-specific
  BUFFER: {
    EVENT_COUNT: "buf:count",
    STARTED_AT: "buf:startedAt",
  },

  // Queue-specific
  QUEUE: {
    EVENTS: "q:events:", // prefix: q:events:{eventId}
    PENDING: "q:pending", // array of pending event IDs
    PROCESSED: "q:processed",
    CURRENT: "q:current",
    ATTEMPT: "q:attempt",
    PAUSED: "q:paused",
  },

  // Idempotency
  IDEMPOTENCY: "idem:", // prefix: idem:{eventId}
} as const;
