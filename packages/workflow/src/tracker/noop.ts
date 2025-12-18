// packages/workflow/src/tracker/noop.ts

/**
 * Re-export NoopTracker from core.
 * The core implementation works for any event type including workflow events.
 */
export { noopTracker, NoopTrackerLayer } from "@durable-effect/core";
