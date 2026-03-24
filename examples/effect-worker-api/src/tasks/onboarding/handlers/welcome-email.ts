import { Effect } from "effect";
import { registry } from "../registry.js";

export const welcomeEmailHandler = registry.handler("welcomeEmail", {
  onEvent: (ctx, event) =>
    Effect.gen(function* () {
      yield* Effect.log(`[email] Sending welcome to ${event.to}`);

      yield* ctx.save({
        to: event.to,
        sentAt: Date.now(),
        userId: event.userId,
      });
    }),

  onAlarm: (ctx) => Effect.void,
});
