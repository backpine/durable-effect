import type { Schema } from "effect"

// ---------------------------------------------------------------------------
// PureSchema — a schema with no service requirements for encoding/decoding
// ---------------------------------------------------------------------------

export type PureSchema<T> = Schema.Top & {
  readonly Type: T
  readonly DecodingServices: never
  readonly EncodingServices: never
}

// ---------------------------------------------------------------------------
// TaskTag — a task declaration: name + state schema + event schema
// No handler code. Lightweight, importable anywhere.
// ---------------------------------------------------------------------------

export interface TaskTag<Name extends string, S, E> {
  readonly _tag: "TaskTag"
  readonly name: Name
  readonly state: PureSchema<S>
  readonly event: PureSchema<E>
}

// ---------------------------------------------------------------------------
// AnyTaskTag — existential shorthand
// ---------------------------------------------------------------------------

export type AnyTaskTag = TaskTag<string, any, any>

// ---------------------------------------------------------------------------
// Type helpers — extract S, E, Name from a tag or tag union
// ---------------------------------------------------------------------------

export type StateOf<T extends AnyTaskTag> =
  T extends TaskTag<any, infer S, any> ? S : never

export type EventOf<T extends AnyTaskTag> =
  T extends TaskTag<any, any, infer E> ? E : never

export type NameOf<T extends AnyTaskTag> =
  T extends TaskTag<infer N, any, any> ? N : never

/** Extract state type for a specific task name from a tag union */
export type StateFor<Tags extends AnyTaskTag, K extends string> =
  StateOf<Extract<Tags, { name: K }>>

/** Extract event type for a specific task name from a tag union */
export type EventFor<Tags extends AnyTaskTag, K extends string> =
  EventOf<Extract<Tags, { name: K }>>

// ---------------------------------------------------------------------------
// Task.make — creates a TaskTag from a name + schemas
// ---------------------------------------------------------------------------

export const Task = {
  make<const Name extends string, S, E>(
    name: Name,
    schemas: { readonly state: PureSchema<S>; readonly event: PureSchema<E> },
  ): TaskTag<Name, S, E> {
    return {
      _tag: "TaskTag",
      name,
      state: schemas.state,
      event: schemas.event,
    }
  },
}
