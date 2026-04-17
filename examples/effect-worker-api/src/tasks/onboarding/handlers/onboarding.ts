import { Effect, Layer, Context } from "effect";
import { withServices } from "@durable-effect/task";
import { registry } from "../registry.js";

// ── Service ──────────────────────────────────────────────

class OnboardingAnalytics extends Context.Service<
  OnboardingAnalytics,
  {
    readonly track: (event: string, userId: string) => Effect.Effect<void>;
  }
>()("@app/OnboardingAnalytics") {}

const OnboardingAnalyticsLive = Layer.succeed(OnboardingAnalytics, {
  track: (event, userId) =>
    Effect.log(`[analytics] ${event} for user ${userId}`),
});

// ── Typed helpers from the registry ──────────────────────

const o = registry.for("onboarding");

// ── Event handler ────────────────────────────────────────

const onEvent = o.onEvent((ctx, event) =>
  Effect.gen(function* () {
    const analytics = yield* OnboardingAnalytics;
    yield* analytics.track("onboarding.started", event.userId);

    yield* ctx.save({
      userId: event.userId,
      email: event.email,
      step: "welcome_email_queued",
    });

    // String-based sibling access — no tag import needed
    yield* ctx.task("welcomeEmail").send(event.userId, {
      _tag: "Send",
      to: event.email,
      userId: event.userId,
    });

    yield* ctx.scheduleIn("10 seconds");
  }),
);

// ── Alarm handler ────────────────────────────────────────

const onAlarm = o.onAlarm((ctx) =>
  Effect.gen(function* () {
    const state = yield* ctx.recall();
    if (!state) return;

    const analytics = yield* OnboardingAnalytics;
    yield* analytics.track("onboarding.followup", state.userId);

    yield* ctx.save({
      ...state,
      step: "completed",
      completedAt: Date.now(),
    });
  }),
);

// ── Register ─────────────────────────────────────────────

export const onboardingHandler = registry.handler(
  "onboarding",
  withServices(
    {
      onEvent: { handler: onEvent, onError: (ctx, error) => Effect.void },
      onAlarm: { handler: onAlarm, onError: (ctx, error) => Effect.void },
    },
    OnboardingAnalyticsLive,
  ),
);
