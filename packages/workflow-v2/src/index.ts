import { Effect } from "effect";

/**
 * A simple hello world effect.
 *
 * @example
 * ```typescript
 * import { helloWorld } from "@durable-effect/workflow-v2";
 *
 * const result = Effect.runSync(helloWorld);
 * // => "Hello, World!"
 * ```
 */
export const helloWorld: Effect.Effect<string> = Effect.succeed("Hello, World!");

/**
 * A hello world effect that greets a specific name.
 *
 * @param name - The name to greet
 * @returns An Effect that produces a greeting string
 *
 * @example
 * ```typescript
 * import { hello } from "@durable-effect/workflow-v2";
 *
 * const result = Effect.runSync(hello("Effect"));
 * // => "Hello, Effect!"
 * ```
 */
export const hello = (name: string): Effect.Effect<string> =>
  Effect.succeed(`Hello, ${name}!`);
