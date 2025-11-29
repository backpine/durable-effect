/// <reference path="../worker-configuration.d.ts" />

import { handleRequest } from "./router";
import { Workflows } from "./workflows";

// Export the Durable Object class
export { Workflows };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
