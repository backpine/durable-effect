import * as HttpRouter from "@effect/platform/HttpRouter";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import { Effect } from "effect";
import { Config } from "@/services";
let n = 0;
export const healthRoutes = HttpRouter.empty.pipe(
  // ---------------------------------------------------------------------------
  // GET /health - Basic health check
  // ---------------------------------------------------------------------------
  HttpRouter.get(
    "/",
    Effect.gen(function* () {
      const timestamp = new Date().toISOString();
      n++;
      return yield* HttpServerResponse.json({
        status: "healthy",
        timestamp,
        count: n,
      });
    }),
  ),

  // ---------------------------------------------------------------------------
  // GET /health/config - Config health check
  // ---------------------------------------------------------------------------
  HttpRouter.get(
    "/config",
    Effect.gen(function* () {
      const config = yield* Config;
      const env = yield* config.getOrElse("ENVIRONMENT", "unknown");
      return yield* HttpServerResponse.json({ environment: env });
    }),
  ),
);
