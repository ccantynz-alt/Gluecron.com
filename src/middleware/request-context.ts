/**
 * Request context middleware — attaches a request ID and start time to every
 * request. Adds the ID to the response headers for correlation + to c.get()
 * so downstream handlers and loggers can reference it.
 */

import { createMiddleware } from "hono/factory";

export type RequestContextEnv = {
  Variables: {
    requestId: string;
    requestStart: number;
  };
};

function genId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  const ts = Date.now().toString(36);
  return `${ts}-${rand}`;
}

export const requestContext = createMiddleware<RequestContextEnv>(
  async (c, next) => {
    const existing = c.req.header("x-request-id");
    const id = existing && existing.length < 100 ? existing : genId();
    c.set("requestId", id);
    c.set("requestStart", Date.now());
    c.header("X-Request-Id", id);
    await next();
  }
);
