import { Schema } from "effect"

// ---------------------------------------------------------------------------
// Path Parameters
// ---------------------------------------------------------------------------

export const UserIdParams = Schema.Struct({
  id: Schema.String,
})

// ---------------------------------------------------------------------------
// Request Bodies
// ---------------------------------------------------------------------------

export const CreateUserBody = Schema.Struct({
  email: Schema.String.pipe(
    Schema.pattern(/@/, { message: () => "Invalid email format" })
  ),
  name: Schema.String.pipe(
    Schema.minLength(1, { message: () => "Name is required" })
  ),
  age: Schema.optional(Schema.Number.pipe(Schema.positive())),
})

export const UpdateUserBody = Schema.Struct({
  email: Schema.optional(Schema.String.pipe(Schema.pattern(/@/))),
  name: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  age: Schema.optional(Schema.Number.pipe(Schema.positive())),
})

// ---------------------------------------------------------------------------
// Response Schemas
// ---------------------------------------------------------------------------

export const UserResponse = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.String,
  createdAt: Schema.String,
})

export const UsersListResponse = Schema.Struct({
  users: Schema.Array(UserResponse),
  total: Schema.Number,
})
