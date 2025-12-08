// packages/workflow-v2/src/context/index.ts

// Workflow Context
export {
  WorkflowContext,
  WorkflowContextLayer,
  createWorkflowContext,
  type WorkflowContextService,
} from "./workflow-context";

// Step Context
export {
  StepContext,
  StepContextLayer,
  createStepContext,
  type StepContextService,
  type StepResultMeta,
  type CachedStepResult,
} from "./step-context";

// Workflow Scope
export {
  WorkflowScope,
  WorkflowScopeLayer,
  isInWorkflowScope,
  requireWorkflowScope,
  WorkflowScopeError,
  type WorkflowScopeService,
} from "./workflow-scope";

// Step Scope
export {
  StepScope,
  StepScopeLayer,
  isInStepScope,
  guardWorkflowOperation,
  rejectInsideStep,
  StepScopeError,
  type StepScopeService,
} from "./step-scope";
