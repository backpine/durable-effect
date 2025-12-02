/**
 * Event tracker configuration types.
 */

/**
 * Configuration for the HTTP batch event tracker.
 */
export interface EventTrackerConfig {
  /**
   * HTTP endpoint to POST events to.
   * e.g., "https://tracker.example.com/api/events"
   */
  readonly url: string;

  /**
   * Access token for authentication.
   * Sent as Bearer token in Authorization header.
   */
  readonly accessToken: string;

  /**
   * Environment identifier.
   * Included in all emitted events for filtering/routing.
   * e.g., "production", "staging", "development"
   */
  readonly env: string;

  /**
   * User-defined service key.
   * Identifies this service across all workflows.
   * e.g., "order-service", "payment-processor"
   */
  readonly serviceKey: string;

  /**
   * Batching configuration.
   */
  readonly batch?: {
    /**
     * Maximum number of events per batch.
     * When reached, batch is sent immediately.
     * @default 50
     */
    readonly maxSize?: number;

    /**
     * Maximum time to wait before sending a batch (ms).
     * Events are sent when this time elapses, even if batch isn't full.
     * @default 1000
     */
    readonly maxWaitMs?: number;
  };

  /**
   * Retry configuration for failed HTTP requests.
   */
  readonly retry?: {
    /**
     * Maximum retry attempts.
     * @default 3
     */
    readonly maxAttempts?: number;

    /**
     * Initial delay between retries (ms).
     * Uses exponential backoff.
     * @default 100
     */
    readonly initialDelayMs?: number;

    /**
     * Maximum delay between retries (ms).
     * @default 5000
     */
    readonly maxDelayMs?: number;
  };

  /**
   * HTTP request timeout (ms).
   * @default 10000
   */
  readonly timeoutMs?: number;
}
