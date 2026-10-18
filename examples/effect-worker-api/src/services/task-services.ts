import { Context } from "effect"

// Task services depend only on the bindings they use. Production provides the
// full Wrangler Env; in-memory tests provide this smaller structural shape.
export class AppEnv extends Context.Service<
  AppEnv,
  { readonly BILLING_CURRENCY: string }
>()("@app/Env") {}
