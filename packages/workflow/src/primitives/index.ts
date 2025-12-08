// packages/workflow-v2/src/primitives/index.ts

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

// Workflow.step
export { step, StepCancelledError } from "./step";

// Workflow.sleep
export { sleep, sleepUntil } from "./sleep";

// Workflow.retry (pipeable operator)
export {
  retry,
  Backoff,
  RetryExhaustedError,
  type RetryOptions,
  type DelayConfig,
} from "./retry";

// Workflow.timeout (pipeable operator)
export { timeout, WorkflowTimeoutError } from "./timeout";

// Backoff utilities
export {
  type BackoffStrategy,
  BackoffStrategies,
  calculateBackoffDelay,
  addJitter,
  parseDuration,
} from "./backoff";
