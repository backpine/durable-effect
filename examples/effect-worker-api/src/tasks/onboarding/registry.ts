import { Schema } from "effect";
import { Task, TaskRegistry } from "@durable-effect/task";

// ── Task Declarations ────────────────────────────────────

export const Onboarding = Task.make("onboarding", {
  state: Schema.Struct({
    userId: Schema.String,
    email: Schema.String,
    step: Schema.String,
    completedAt: Schema.optionalKey(Schema.Number),
  }),
  event: Schema.Struct({
    _tag: Schema.Literal("Start"),
    userId: Schema.String,
    email: Schema.String,
  }),
});

export const WelcomeEmail = Task.make("welcomeEmail", {
  state: Schema.Struct({
    to: Schema.String,
    sentAt: Schema.Number,
    userId: Schema.String,
  }),
  event: Schema.Struct({
    _tag: Schema.Literal("Send"),
    to: Schema.String,
    userId: Schema.String,
  }),
});

// ── Registry ─────────────────────────────────────────────

export const registry = TaskRegistry.make(Onboarding, WelcomeEmail);
