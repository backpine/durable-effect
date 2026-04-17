import { Schema } from "effect";
import { Task, TaskRegistry } from "@durable-effect/task";

// ── Task Declarations ────────────────────────────────────

export const Invoice = Task.make("invoice", {
  state: Schema.Struct({
    userId: Schema.String,
    amount: Schema.Number,
    status: Schema.String,
    receiptSent: Schema.Boolean,
  }),
  event: Schema.Struct({
    _tag: Schema.Literal("Create"),
    userId: Schema.String,
    amount: Schema.Number,
  }),
});

export const Receipt = Task.make("receipt", {
  state: Schema.Struct({
    invoiceId: Schema.String,
    userId: Schema.String,
    sentAt: Schema.Number,
  }),
  event: Schema.Struct({
    _tag: Schema.Literal("Send"),
    invoiceId: Schema.String,
    userId: Schema.String,
  }),
});

// ── Registry ─────────────────────────────────────────────

export const registry = TaskRegistry.make(Invoice, Receipt);
