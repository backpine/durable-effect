// packages/workflow/src/primitives/backoff.ts
//
// Re-export from @durable-effect/core for backward compatibility.
// The backoff utilities are now shared across workflow and jobs packages.

export {
  type BackoffStrategy,
  BackoffStrategies,
  Backoff,
  calculateBackoffDelay,
  addJitter,
  parseDuration,
  resolveDelay,
} from "@durable-effect/core";
