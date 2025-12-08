// packages/workflow-v2/src/state/index.ts

// Types
export type {
  WorkflowStatus,
  WorkflowTransition,
  WorkflowState,
  WorkflowError,
  TransitionTag,
  StatusTag,
} from "./types";

export { initialWorkflowState } from "./types";

// Transition validation
export {
  VALID_TRANSITIONS,
  isValidTransition,
  getValidTransitions,
  isTerminalStatus,
  isRecoverableStatus,
} from "./transitions";

// State machine service
export {
  WorkflowStateMachine,
  WorkflowStateMachineLayer,
  createWorkflowStateMachine,
  type WorkflowStateMachineService,
  type RecoverabilityInfo,
} from "./machine";
