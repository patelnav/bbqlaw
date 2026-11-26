import { handleRequest } from "./app";

export interface Env {
  UPDATES: R2Bucket;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env.UPDATES);
  },
};
