import { ServiceMap } from "effect";

export class Instance extends ServiceMap.Service<Instance, {
  readonly id: string;
  readonly name: string;
}>()("@task/Instance") {}
