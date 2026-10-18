import { Schema as S, Context } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/http-api"
import { Counter } from "@/tasks/counter"
import { Invoice, Receipt } from "@/tasks/billing/registry"
import { Onboarding, WelcomeEmail } from "@/tasks/onboarding/registry"

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException(): void
}

export class CloudflareBindings extends Context.Service<
  CloudflareBindings,
  { readonly env: Env; readonly ctx: WorkerExecutionContext }
>()("@app/CloudflareBindings") {}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CloudflareBindingsError extends S.TaggedError<CloudflareBindingsError>()(
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
  .add(
    HttpApiEndpoint.get("status", "/status/:counterId", {
      params: S.Struct({ counterId: S.String }),
      success: S.Struct({ counter: S.NullOr(Counter.state) }),
    }),
  )
  .prefix("/counter")

// Onboarding group — demonstrates task-group with sibling dispatch

export const OnboardingStartResponseSchema = S.Struct({
  status: S.Literal("ok"),
  userId: S.String,
})

export const OnboardingStateResponseSchema = S.Struct({
  onboarding: S.NullOr(Onboarding.state),
  welcomeEmail: S.NullOr(WelcomeEmail.state),
})

export const OnboardingGroup = HttpApiGroup.make("onboarding")
  .add(
    HttpApiEndpoint.post("start", "/start", {
      payload: S.Struct({ userId: S.String, email: S.String }),
      success: OnboardingStartResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.get("status", "/status/:userId", {
      params: S.Struct({ userId: S.String }),
      success: OnboardingStateResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post("complete", "/complete/:userId", {
      params: S.Struct({ userId: S.String }),
      success: OnboardingStateResponseSchema,
    }),
  )
  .prefix("/onboarding")

// Billing group — demonstrates CF DO adapter with sibling dispatch + getState

export const BillingCreateResponseSchema = S.Struct({
  status: S.Literal("ok"),
  invoiceId: S.String,
})

export const BillingStateResponseSchema = S.Struct({
  invoice: S.NullOr(Invoice.state),
  receipt: S.NullOr(Receipt.state),
})

export const BillingGroup = HttpApiGroup.make("billing")
  .add(
    HttpApiEndpoint.post("create", "/create", {
      payload: S.Struct({ userId: S.String, amount: S.Number }),
      success: BillingCreateResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.get("status", "/status/:invoiceId", {
      params: S.Struct({ invoiceId: S.String }),
      success: BillingStateResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post("finalize", "/finalize/:invoiceId", {
      params: S.Struct({ invoiceId: S.String }),
      success: BillingStateResponseSchema,
    }),
  )
  .prefix("/billing")

// ---------------------------------------------------------------------------
// API definition
// ---------------------------------------------------------------------------

export class WorkerApi extends HttpApi.make("WorkerApi")
  .add(HealthGroup)
  .add(CounterGroup)
  .add(OnboardingGroup)
  .add(BillingGroup)
  .middleware(CloudflareBindingsMiddleware)
  .prefix("/api") {}
