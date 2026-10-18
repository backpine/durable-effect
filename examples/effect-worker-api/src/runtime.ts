import { Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { WorkerApi } from "@/api"
import { HttpGroupsLive } from "@/handlers"
import { MiddlewareLive } from "@/services"

const ApiRoutes = HttpApiBuilder.layer(WorkerApi, {
  openapiPath: "/api/openapi.json",
}).pipe(
  Layer.provide(HttpGroupsLive),
  Layer.provide(MiddlewareLive),
)

export const { handler, dispose } = HttpRouter.toWebHandler(
  ApiRoutes.pipe(Layer.provide(HttpServer.layerServices)),
)
