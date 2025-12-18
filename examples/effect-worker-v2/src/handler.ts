import { Effect } from "effect"
import * as HttpServerRequest from "@effect/platform/HttpServerRequest"
import * as HttpServerResponse from "@effect/platform/HttpServerResponse"
import { appRouter } from "./router"

/**
 * Handle a single HTTP request.
 *
 * This is an Effect that:
 * 1. Converts the web Request to a platform HttpServerRequest
 * 2. Runs the HttpRouter
 * 3. Converts the response back to a web Response
 *
 * The effect requires CloudflareEnv and CloudflareCtx to be provided
 * per-request by the worker entry point.
 */
export const handleRequest = (request: Request) =>
  Effect.gen(function* () {
    // Create platform request from web request
    const serverRequest = HttpServerRequest.fromWeb(request)

    // Run the router with the server request provided
    const response = yield* appRouter.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, serverRequest)
    )

    // Convert platform response to web response
    return HttpServerResponse.toWeb(response)
  })
