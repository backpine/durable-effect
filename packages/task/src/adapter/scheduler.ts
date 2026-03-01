import { Effect, ServiceMap } from "effect";
import type { SchedulerError } from "../errors.js";

export class Scheduler extends ServiceMap.Service<Scheduler, {
  readonly schedule: (timestamp: number) => Effect.Effect<void, SchedulerError>;
  readonly cancel: () => Effect.Effect<void, SchedulerError>;
  readonly getNext: () => Effect.Effect<number | null, SchedulerError>;
}>()("@task/Scheduler") {}
