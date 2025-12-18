/**
 * Type utilities for extracting binding names from Env
 */

/**
 * Extract keys from Env where the value extends type T
 */
export type BindingsOfType<T> = {
  [K in keyof Env]: Env[K] extends T ? K : never
}[keyof Env]

/**
 * KV Namespace binding names from Env
 */
export type KVBindingName = BindingsOfType<KVNamespace>

/**
 * R2 Bucket binding names from Env
 */
export type R2BindingName = BindingsOfType<R2Bucket>

/**
 * Hyperdrive binding names from Env
 */
export type HyperdriveBindingName = BindingsOfType<Hyperdrive>
