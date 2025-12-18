I am not in love with this: `/docs/009-singleton-runtime-design.md`


I feel like this pattern is not effectful and not clean:
```ts
let handlerPromise: Promise<(request: Request) => Promise<Response>> | null = null;

const getHandler = async () => {
  if (!handlerPromise) {
    handlerPromise = (async () => {
      const rt = await runtime.runtime();
      return HttpApp.toWebHandlerRuntime(rt)(appRouter);
    })();
  }
  return handlerPromise;
};
```

It is probably work reading thie: http://developers.cloudflare.com/workers/reference/how-workers-works/

I'd like to use HttpApp.toWebHandlerRuntime, but ensure thinkgs are setup in an effectul way

## We should do more research and work on a new plan.

this is an index of all the effect docs: https://effect.website/llms.txt

When we need a new design doc focuing on the runtime. I don't want to get distracted worrying about ctx right now.
