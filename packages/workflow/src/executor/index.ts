// packages/workflow-v2/src/executor/index.ts

// Types
export type {
  ExecutionMode,
  ExecutionResult,
  ExecutionContext,
} from "./types";

export { resultToTransition } from "./types";

// Executor service
export {
  WorkflowExecutor,
  WorkflowExecutorLayer,
  createWorkflowExecutor,
  type WorkflowExecutorService,
} from "./executor";
