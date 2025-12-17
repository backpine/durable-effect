import { CloudflareEnv, HonoCtx, RouteEffect } from "@/adapter";
import { JobsClient } from "@/jobs";
import { Effect } from "effect";

export const startRefreshTokens: RouteEffect<Response> = Effect.gen(
  function* () {
    const c = yield* HonoCtx;
    const env = yield* CloudflareEnv;

    const orderId = c.req.query("orderId") ?? `order-${Date.now()}`;
    const client = JobsClient.fromBinding(env.JOBS);

    yield* Effect.log(`Starting workflow for order ${orderId}`);

    const res = yield* client.continuous("tokenRefresher").start({
      id: orderId,
      input: {
        accessToken: "example_access_token",
        refreshToken: "example_refresh_token",
        expiresAt: Date.now() + 3600000,
        count: 0,
      },
    });

    return c.json({
      success: true,
      workflowId: res.instanceId,
      orderId,
    });
  },
);

export const stopRefreshTokens: RouteEffect<Response> = Effect.gen(
  function* () {
    const c = yield* HonoCtx;
    const env = yield* CloudflareEnv;

    const id = c.req.query("id");
    if (!id) {
      return c.json({
        success: false,
        error: "orderId is required",
      });
    }
    const client = JobsClient.fromBinding(env.JOBS);

    yield* Effect.log(`Starting workflow for order ${id}`);

    const res = yield* client.continuous("tokenRefresher").stop(id);

    return c.json({
      success: true,
      workflowId: res.stopped,
    });
  },
);

export const addWebhookEvent: RouteEffect<Response> = Effect.gen(function* () {
  const c = yield* HonoCtx;
  const env = yield* CloudflareEnv;

  const contactId = c.req.query("contactId") ?? "contact-1";
  const webhookId = c.req.query("id") ?? `evt-${Date.now()}`;
  const type = c.req.query("type") ?? "order.updated";

  const client = JobsClient.fromBinding(env.JOBS);

  const res = yield* client.debounce("webhookDebounce").add({
    id: contactId,
    event: {
      contactId,
      type,
      payload: { demo: true },
      occurredAt: Math.floor(Math.random() * 1000) + 1,
    },
  });

  return c.json({
    success: true,
    instanceId: res.instanceId,
    eventCount: res.eventCount,
    willFlushAt: res.willFlushAt,
  });
});

export const flushWebhookDebounce: RouteEffect<Response> = Effect.gen(
  function* () {
    const c = yield* HonoCtx;
    const env = yield* CloudflareEnv;

    const contactId = c.req.query("contactId");
    if (!contactId) {
      return c.json({ success: false, error: "contactId required" }, 400);
    }

    const client = JobsClient.fromBinding(env.JOBS);
    const res = yield* client.debounce("webhookDebounce").flush(contactId);

    return c.json(res);
  },
);

// =============================================================================
// Task Routes - Countdown Timer
// =============================================================================

/**
 * Start a countdown timer
 * GET /jobs/countdown/start?id=timer-1&name=MyTimer&duration=30&message=Hello
 */
export const startCountdown: RouteEffect<Response> = Effect.gen(function* () {
  const c = yield* HonoCtx;
  const env = yield* CloudflareEnv;

  const id = c.req.query("id") ?? `timer-${Date.now()}`;
  const name = c.req.query("name") ?? "Countdown";
  const duration = parseInt(c.req.query("duration") ?? "10", 10);
  const message = c.req.query("message") ?? "";

  const client = JobsClient.fromBinding(env.JOBS);

  yield* Effect.log(`Starting countdown timer: ${name} (${duration}s)`);

  const res = yield* client.task("countdownTimer").send({
    id,
    event: {
      _tag: "Start" as const,
      name,
      durationSeconds: duration,
      message,
    },
  });

  return c.json({
    success: true,
    timerId: id,
    instanceId: res.instanceId,
    created: res.created,
    scheduledAt: res.scheduledAt,
    completesAt: res.scheduledAt
      ? new Date(res.scheduledAt).toISOString()
      : null,
  });
});

/**
 * Pause a countdown timer
 * GET /jobs/countdown/pause?id=timer-1
 */
export const pauseCountdown: RouteEffect<Response> = Effect.gen(function* () {
  const c = yield* HonoCtx;
  const env = yield* CloudflareEnv;

  const id = c.req.query("id");
  if (!id) {
    return c.json({ success: false, error: "id is required" }, 400);
  }

  const client = JobsClient.fromBinding(env.JOBS);

  const res = yield* client.task("countdownTimer").send({
    id,
    event: { _tag: "Pause" as const },
  });

  return c.json({
    success: true,
    timerId: id,
    paused: true,
    scheduledAt: res.scheduledAt,
  });
});

/**
 * Resume a paused countdown timer
 * GET /jobs/countdown/resume?id=timer-1
 */
export const resumeCountdown: RouteEffect<Response> = Effect.gen(function* () {
  const c = yield* HonoCtx;
  const env = yield* CloudflareEnv;

  const id = c.req.query("id");
  if (!id) {
    return c.json({ success: false, error: "id is required" }, 400);
  }

  const client = JobsClient.fromBinding(env.JOBS);

  const res = yield* client.task("countdownTimer").send({
    id,
    event: { _tag: "Resume" as const },
  });

  return c.json({
    success: true,
    timerId: id,
    resumed: true,
    scheduledAt: res.scheduledAt,
  });
});

/**
 * Cancel a countdown timer
 * GET /jobs/countdown/cancel?id=timer-1
 */
export const cancelCountdown: RouteEffect<Response> = Effect.gen(function* () {
  const c = yield* HonoCtx;
  const env = yield* CloudflareEnv;

  const id = c.req.query("id");
  if (!id) {
    return c.json({ success: false, error: "id is required" }, 400);
  }

  const client = JobsClient.fromBinding(env.JOBS);

  const res = yield* client.task("countdownTimer").send({
    id,
    event: { _tag: "Cancel" as const },
  });

  return c.json({
    success: true,
    timerId: id,
    cancelled: true,
    scheduledAt: res.scheduledAt,
  });
});

/**
 * Add time to a countdown timer
 * GET /jobs/countdown/addTime?id=timer-1&seconds=30
 */
export const addTimeCountdown: RouteEffect<Response> = Effect.gen(function* () {
  const c = yield* HonoCtx;
  const env = yield* CloudflareEnv;

  const id = c.req.query("id");
  const seconds = parseInt(c.req.query("seconds") ?? "10", 10);

  if (!id) {
    return c.json({ success: false, error: "id is required" }, 400);
  }

  const client = JobsClient.fromBinding(env.JOBS);

  const res = yield* client.task("countdownTimer").send({
    id,
    event: { _tag: "AddTime" as const, seconds },
  });

  return c.json({
    success: true,
    timerId: id,
    addedSeconds: seconds,
    scheduledAt: res.scheduledAt,
    newCompletesAt: res.scheduledAt
      ? new Date(res.scheduledAt).toISOString()
      : null,
  });
});

/**
 * Get countdown timer status
 * GET /jobs/countdown/status?id=timer-1
 */
export const getCountdownStatus: RouteEffect<Response> = Effect.gen(
  function* () {
    const c = yield* HonoCtx;
    const env = yield* CloudflareEnv;

    const id = c.req.query("id");
    if (!id) {
      return c.json({ success: false, error: "id is required" }, 400);
    }

    const client = JobsClient.fromBinding(env.JOBS);

    const res = yield* client.task("countdownTimer").status(id);

    return c.json({
      success: true,
      timerId: id,
      ...res,
      scheduledAtFormatted: res.scheduledAt
        ? new Date(res.scheduledAt).toISOString()
        : null,
    });
  },
);

/**
 * Get countdown timer state
 * GET /jobs/countdown/state?id=timer-1
 */
export const getCountdownState: RouteEffect<Response> = Effect.gen(
  function* () {
    const c = yield* HonoCtx;
    const env = yield* CloudflareEnv;

    const id = c.req.query("id");
    if (!id) {
      return c.json({ success: false, error: "id is required" }, 400);
    }

    const client = JobsClient.fromBinding(env.JOBS);

    const res = yield* client.task("countdownTimer").getState(id);

    const state = res.state as {
      name: string;
      targetTime: number;
      status: string;
      message?: string;
    } | null;

    return c.json({
      success: true,
      timerId: id,
      state: state
        ? {
            ...state,
            targetTimeFormatted: new Date(state.targetTime).toISOString(),
            remainingMs: Math.max(0, state.targetTime - Date.now()),
            remainingSeconds: Math.max(
              0,
              Math.ceil((state.targetTime - Date.now()) / 1000),
            ),
          }
        : null,
      scheduledAt: res.scheduledAt,
    });
  },
);

/**
 * Clear a countdown timer immediately
 * GET /jobs/countdown/clear?id=timer-1
 */
export const clearCountdown: RouteEffect<Response> = Effect.gen(function* () {
  const c = yield* HonoCtx;
  const env = yield* CloudflareEnv;

  const id = c.req.query("id");
  if (!id) {
    return c.json({ success: false, error: "id is required" }, 400);
  }

  const client = JobsClient.fromBinding(env.JOBS);

  const res = yield* client.task("countdownTimer").clear(id);

  return c.json({
    success: true,
    timerId: id,
    cleared: res.cleared,
  });
});
