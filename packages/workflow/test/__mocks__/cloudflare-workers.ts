// Mock for cloudflare:workers used in testing
// The actual Cloudflare runtime provides this module

export class DurableObject {
  constructor(_state: unknown, _env: unknown) {}
}

export class DurableObjectState {
  id = { toString: () => "mock-id" };
  storage = {};
  blockConcurrencyWhile = async (fn: () => Promise<void>) => fn();
}
