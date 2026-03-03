import { Schema as S, ServiceMap } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/unstable/httpapi"

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException(): void
}

export class CloudflareBindings extends ServiceMap.Service<
  CloudflareBindings,
  { readonly env: unknown; readonly ctx: WorkerExecutionContext }
>()("@app/CloudflareBindings") {}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CloudflareBindingsError extends S.TaggedErrorClass<CloudflareBindingsError>()(
  "CloudflareBindingsError",
  { message: S.String },
  { httpApiStatus: 500 }
) {}

// ---------------------------------------------------------------------------
// Middleware tags
// ---------------------------------------------------------------------------

export class CloudflareBindingsMiddleware extends HttpApiMiddleware.Service<
  CloudflareBindingsMiddleware,
  { provides: CloudflareBindings }
>()("@app/CloudflareBindingsMiddleware", {
  error: CloudflareBindingsError,
}) {}

// ---------------------------------------------------------------------------
// Endpoint groups
// ---------------------------------------------------------------------------

export const HealthResponseSchema = S.Struct({
  status: S.Literal("ok"),
  timestamp: S.DateTimeUtc,
})

export const HealthGroup = HttpApiGroup.make("health")
  .add(HttpApiEndpoint.get("check", "/", { success: HealthResponseSchema }))
  .prefix("/health")

// Counter group — starts a self-incrementing counter task

export const CounterResponseSchema = S.Struct({
  status: S.Literal("ok"),
  counterId: S.String,
})

export const CounterGroup = HttpApiGroup.make("counter")
  .add(
    HttpApiEndpoint.get("start", "/start/:counterId", {
      params: S.Struct({ counterId: S.String }),
      success: CounterResponseSchema,
    }),
  )
  .prefix("/counter")

// ---------------------------------------------------------------------------
// API definition
// ---------------------------------------------------------------------------

export class WorkerApi extends HttpApi.make("WorkerApi")
  .add(HealthGroup)
  .add(CounterGroup)
  .middleware(CloudflareBindingsMiddleware)
  .prefix("/api") {}
