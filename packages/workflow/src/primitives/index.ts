// packages/workflow/src/primitives/index.ts

// PauseSignal
export { PauseSignal, isPauseSignal, type PauseReason } from "./pause-signal";

// Workflow.make
export {
  make,
  type WorkflowDefinition,
  type WorkflowEffect,
  type WorkflowInput,
  type WorkflowOutput,
  type WorkflowError,
  type WorkflowRequirements,
} from "./make";

// Workflow.step (with integrated retry/timeout)
export {
  step,
  StepCancelledError,
  RetryExhaustedError,
  WorkflowTimeoutError,
  type StepConfig,
  type RetryConfig,
  type DurationInput,
} from "./step";

// Workflow.sleep
export { sleep, sleepUntil } from "./sleep";

// Backoff utilities
export {
  Backoff,
  type BackoffStrategy,
  BackoffStrategies,
  calculateBackoffDelay,
  addJitter,
  parseDuration,
} from "./backoff";
