import * as HttpRouter from "@effect/platform/HttpRouter"
import * as HttpServerResponse from "@effect/platform/HttpServerResponse"
import { Effect, ParseResult } from "effect"
import { routes } from "./routes"

// Error response helper
const errorResponse = (status: number, error: string, message: string) =>
  HttpServerResponse.unsafeJson({ error, message }, { status })

// Main application router with error handling
export const appRouter = routes.pipe(
  HttpRouter.catchAll((error: unknown) => {
    // Handle errors based on _tag
    if (typeof error === "object" && error !== null && "_tag" in error) {
      const tag = (error as { _tag: string })._tag

      switch (tag) {
        case "ParseError":
          return Effect.succeed(
            errorResponse(
              400,
              "ValidationError",
              ParseResult.TreeFormatter.formatErrorSync(error as unknown as ParseResult.ParseError)
            )
          )

        case "NotFoundError": {
          const e = error as unknown as { resource: string; id: string }
          return Effect.succeed(
            errorResponse(
              404,
              "NotFoundError",
              `${e.resource} with id ${e.id} not found`
            )
          )
        }

        case "ValidationError": {
          const e = error as unknown as { message: string }
          return Effect.succeed(
            errorResponse(400, "ValidationError", e.message)
          )
        }

        case "DatabaseError":
          return Effect.succeed(
            errorResponse(500, "DatabaseError", "Database operation failed")
          )

        case "StorageError":
          return Effect.succeed(
            errorResponse(500, "StorageError", "Storage operation failed")
          )

        case "ConfigError": {
          const e = error as unknown as { key: string }
          return Effect.succeed(
            errorResponse(500, "ConfigError", `Configuration error: ${e.key}`)
          )
        }

        case "KVError":
          return Effect.succeed(
            errorResponse(500, "KVError", "KV operation failed")
          )

        case "RouteNotFound":
          return Effect.succeed(
            errorResponse(404, "NotFound", "Route not found")
          )

        case "RequestError": {
          const e = error as unknown as { reason?: string }
          return Effect.succeed(
            errorResponse(400, "RequestError", e.reason || "Bad request")
          )
        }

        case "HttpBodyError":
          return Effect.succeed(
            errorResponse(400, "BadRequest", "Invalid request body")
          )

        default:
          return Effect.succeed(
            errorResponse(500, "InternalError", "An unexpected error occurred")
          )
      }
    }

    // Fallback for unknown errors
    return Effect.succeed(
      errorResponse(500, "InternalError", "An unexpected error occurred")
    )
  })
)
