import { describe, it, expect } from "vitest"
import * as HttpApp from "@effect/platform/HttpApp"
import { Effect, Layer, ManagedRuntime } from "effect"
import { healthRoutes } from "@/routes/health"
import { Config } from "@/services"
import { ConfigError } from "@/errors"
import { TestLayer, MockCloudflareEnv, MockCloudflareCtx } from "../../fixtures/mock-services"

/**
 * HTTP Route Testing Pattern
 *
 * This test demonstrates the correct pattern for testing @effect/platform HttpRouter routes:
 *
 * 1. Create a test layer with mock services (TestLayer from fixtures)
 * 2. Create a ManagedRuntime from the test layer
 * 3. Get the Runtime and create a web handler using HttpApp.toWebHandlerRuntime
 * 4. Make HTTP requests using standard Request objects
 * 5. Assert on the Response
 * 6. Dispose of the runtime after tests
 */
describe("Health Routes", () => {
  /**
   * Helper to create a test handler from a router
   *
   * This pattern:
   * - Creates a ManagedRuntime with your test layer
   * - Extracts the Runtime
   * - Creates a web handler that can process Request -> Response
   */
  const createTestHandler = async <R>(
    router: Parameters<ReturnType<typeof HttpApp.toWebHandlerRuntime<R>>>[0],
    layer: Layer.Layer<R, never, never>
  ) => {
    const managedRuntime = ManagedRuntime.make(layer)
    const runtime = await managedRuntime.runtime()
    const handler = HttpApp.toWebHandlerRuntime(runtime)(router)

    return {
      handler,
      dispose: () => managedRuntime.dispose(),
    }
  }

  describe("GET /health", () => {
    it("should return healthy status", async () => {
      // Arrange: Create the test handler with mock services
      const { handler, dispose } = await createTestHandler(healthRoutes, TestLayer)

      try {
        // Act: Make a request to the health endpoint
        const request = new Request("http://localhost/", {
          method: "GET",
        })
        const response = await handler(request)

        // Assert: Check the response
        expect(response.status).toBe(200)

        const body = (await response.json()) as { status: string; timestamp: string }
        expect(body).toMatchObject({
          status: "healthy",
        })
        expect(body.timestamp).toBeDefined()
      } finally {
        // Cleanup: Always dispose of the runtime
        await dispose()
      }
    })
  })

  describe("GET /health/config", () => {
    it("should return environment from config service", async () => {
      // Arrange
      const { handler, dispose } = await createTestHandler(healthRoutes, TestLayer)

      try {
        // Act
        const request = new Request("http://localhost/config", {
          method: "GET",
        })
        const response = await handler(request)

        // Assert
        expect(response.status).toBe(200)

        const body = await response.json()
        // MockConfig returns "test" for ENVIRONMENT
        expect(body).toEqual({
          environment: "test",
        })
      } finally {
        await dispose()
      }
    })

    it("should return default value when config key not found", async () => {
      // Arrange: Create a custom config layer that doesn't have ENVIRONMENT
      const CustomConfigLayer = Layer.mergeAll(
        MockCloudflareEnv,
        MockCloudflareCtx,
        Layer.succeed(Config, {
          get: () =>
            Effect.fail(
              new ConfigError({ key: "ENVIRONMENT", message: "Not found" })
            ),
          getSecret: () =>
            Effect.fail(
              new ConfigError({ key: "ENVIRONMENT", message: "Not found" })
            ),
          getNumber: () =>
            Effect.fail(
              new ConfigError({ key: "ENVIRONMENT", message: "Not found" })
            ),
          getBoolean: () =>
            Effect.fail(
              new ConfigError({ key: "ENVIRONMENT", message: "Not found" })
            ),
          getJson: () =>
            Effect.fail(
              new ConfigError({ key: "ENVIRONMENT", message: "Not found" })
            ),
          getOrElse: (_key: string, defaultValue: string) =>
            Effect.succeed(defaultValue),
          getAll: () => Effect.succeed({}),
        })
      )

      const { handler, dispose } = await createTestHandler(
        healthRoutes,
        CustomConfigLayer
      )

      try {
        // Act
        const request = new Request("http://localhost/config", {
          method: "GET",
        })
        const response = await handler(request)

        // Assert
        expect(response.status).toBe(200)

        const body = await response.json()
        // getOrElse returns "unknown" as the default
        expect(body).toEqual({
          environment: "unknown",
        })
      } finally {
        await dispose()
      }
    })
  })
})
