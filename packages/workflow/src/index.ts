// packages/workflow/src/index.ts

// Errors
export {
  StorageError,
  SchedulerError,
  InvalidTransitionError,
  RecoveryError,
  OrchestratorError,
} from "./errors";

// Adapters
export {
  // Core adapters
  StorageAdapter,
  SchedulerAdapter,
  RuntimeAdapter,
  // Types
  type StorageAdapterService,
  type SchedulerAdapterService,
  type RuntimeAdapterService,
  type RuntimeLayer,
  type LifecycleEvent,
  // In-memory (testing)
  createInMemoryRuntime,
  createInMemoryStorage,
  createInMemoryStorageWithErrors,
  createInMemoryScheduler,
  shouldAlarmFire,
  type TestRuntimeHandle,
  type InMemoryStorageState,
  type InMemorySchedulerState,
  type InMemoryRuntimeState,
} from "./adapters";

// State
export {
  // Types
  type WorkflowStatus,
  type WorkflowTransition,
  type WorkflowState,
  type WorkflowError,
  type TransitionTag,
  type StatusTag,
  initialWorkflowState,
  // Transition validation
  VALID_TRANSITIONS,
  isValidTransition,
  getValidTransitions,
  isTerminalStatus,
  isRecoverableStatus,
  // State machine
  WorkflowStateMachine,
  WorkflowStateMachineLayer,
  createWorkflowStateMachine,
  type WorkflowStateMachineService,
  type RecoverabilityInfo,
} from "./state";

// Recovery
export {
  // Config
  type RecoveryConfig,
  defaultRecoveryConfig,
  createRecoveryConfig,
  validateRecoveryConfig,
  // Manager
  RecoveryManager,
  RecoveryManagerLayer,
  DefaultRecoveryManagerLayer,
  createRecoveryManager,
  type RecoveryManagerService,
  type RecoveryCheckResult,
  type RecoveryExecuteResult,
  type RecoveryStats,
} from "./recovery";

// Purge
export {
  // Config
  type PurgeConfig,
  type ParsedPurgeConfig,
  defaultPurgeDelayMs,
  parsePurgeConfig,
  // Manager
  PurgeManager,
  PurgeManagerLayer,
  DisabledPurgeManagerLayer,
  createPurgeManager,
  type PurgeManagerService,
  type PurgeExecutionResult,
  type TerminalState,
} from "./purge";

// Context
export {
  // Workflow Context
  WorkflowContext,
  WorkflowContextLayer,
  createWorkflowContext,
  type WorkflowContextService,
  // Step Context
  StepContext,
  StepContextLayer,
  createStepContext,
  type StepContextService,
  type StepResultMeta,
  type CachedStepResult,
  // Workflow Scope
  WorkflowScope,
  WorkflowScopeLayer,
  isInWorkflowScope,
  requireWorkflowScope,
  WorkflowScopeError,
  type WorkflowScopeService,
  // Step Scope
  StepScope,
  StepScopeLayer,
  isInStepScope,
  guardWorkflowOperation,
  rejectInsideStep,
  StepScopeError,
  type StepScopeService,
  // Workflow Level (compile-time guard)
  WorkflowLevel,
  WorkflowLevelLayer,
  type WorkflowLevelService,
} from "./context";

// Primitives
export {
  // PauseSignal
  PauseSignal,
  isPauseSignal,
  type PauseReason,
  // Workflow.make
  make,
  type WorkflowDefinition,
  type WorkflowEffect,
  type WorkflowInput,
  type WorkflowOutput,
  type WorkflowError as WorkflowErrorType,
  type WorkflowRequirements,
  // Workflow.step (with integrated retry/timeout)
  step,
  StepCancelledError,
  RetryExhaustedError,
  WorkflowTimeoutError,
  type StepConfig,
  type RetryConfig,
  type DurationInput,
  // Workflow.sleep
  sleep,
  sleepUntil,
  // Backoff utilities
  Backoff,
  type BackoffStrategy,
  BackoffStrategies,
  calculateBackoffDelay,
  addJitter,
  parseDuration,
} from "./primitives";

// Executor
export {
  WorkflowExecutor,
  WorkflowExecutorLayer,
  createWorkflowExecutor,
  type WorkflowExecutorService,
  type ExecutionMode,
  type ExecutionResult,
  type ExecutionContext,
  resultToTransition,
} from "./executor";

// Orchestrator
export {
  WorkflowOrchestrator,
  WorkflowOrchestratorLayer,
  createWorkflowOrchestrator,
  type WorkflowOrchestratorService,
  WorkflowRegistryTag,
  WorkflowRegistryLayer,
  createWorkflowRegistry,
  WorkflowNotFoundError,
  type WorkflowRegistryService,
  type WorkflowRegistry,
  type WorkflowCall,
  type StartResult,
  type CancelResult,
  type CancelOptions,
  type WorkflowStatusResult,
} from "./orchestrator";

// DO Adapter
export {
  createDurableObjectRuntime,
  createDOStorageAdapter,
  createDOSchedulerAdapter,
} from "./adapters/durable-object";

// Engine
export {
  createDurableWorkflows,
  type CreateDurableWorkflowsOptions,
  type CreateDurableWorkflowsResult,
  type DurableWorkflowEngineInterface,
} from "./engine";

// Client
export {
  createClientInstance,
  WorkflowClientError,
  type WorkflowClientFactory,
  type WorkflowClientInstance,
  type WorkflowRunResult,
  type WorkflowRunRequest,
  type ExecutionOptions,
  type CancelOptions as ClientCancelOptions,
  type CancelResult as ClientCancelResult,
} from "./client";

// Tracker (re-exported from @durable-effect/core)
export {
  // Service
  EventTracker,
  emitEvent,
  flushEvents,
  type EventTrackerService,
  // Event types
  createWorkflowBaseEvent,
  enrichWorkflowEvent,
  type InternalWorkflowEvent,
  type InternalBaseEvent,
  type InternalWorkflowStartedEvent,
  type InternalWorkflowCompletedEvent,
  type InternalWorkflowFailedEvent,
  type InternalWorkflowPausedEvent,
  type InternalStepStartedEvent,
  type InternalStepCompletedEvent,
  type WorkflowEvent,
  type WorkflowEventType,
  // Implementations
  HttpBatchTrackerLayer,
  HttpTrackerError,
  type HttpBatchTrackerConfig,
  NoopTrackerLayer,
  noopTracker,
  createInMemoryTracker,
  createInMemoryTrackerLayer,
  type InMemoryTrackerHandle,
} from "@durable-effect/core";

// Re-export as Workflow namespace for convenience
export * as Workflow from "./primitives";
