/// <reference path="../worker-configuration.d.ts" />

import { handleRequest } from "./router";
import { Workflows } from "./workflows";
import { PulseTracker } from "./pulse-tracker";

// Export the Durable Object classes
export { Workflows, PulseTracker };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
