This project implements a fetch handler that setups effectfull data processing like:

```ts
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // Create the application layer with Cloudflare bindings
    const bindingsLayer = CloudflareBindings.layer(env, ctx);
    const appLayer = AppCoreLive.pipe(Layer.provide(bindingsLayer));

    // Create managed runtime for this request
    const managedRuntime = ManagedRuntime.make(appLayer);

    try {
      // Get the runtime and create handler
      const rt = await managedRuntime.runtime();
      const handler = HttpApp.toWebHandlerRuntime(rt)(appRouter);
      return await handler(request);
    } finally {
      // Cleanup runtime after request
      ctx.waitUntil(managedRuntime.dispose());
    }
  },
};
```

The core issue here it that the fetch can be called for multiple request. This means we risk setting up layers and the runtime more than once which is overhead and bad design.

We need an effectfull implmention that is able to setup the core services when the worker is initilized so it doesn't happen at the fetch level.

### Important things to note
`env` is provided at the fetch handler level, but it can also be imported:
`import { env } from "cloudflare:workers";`

`ctx` is provided at the request level, along with the `request` so it deson't make sense for this to be a service.

we will somehow need to pass that down to:
```ts
      const handler = HttpApp.toWebHandlerRuntime(rt)(appRouter);
      return await handler(request);
```

We need an effectful way of doing this.

I need a new report talking about how to design a setup to correctly use toWebHandlerRuntime will not setting up layers a the fetch level, but sill providing access to ctx.
