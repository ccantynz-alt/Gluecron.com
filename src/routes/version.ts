/**
 * /api/version — public build-info endpoint.
 *
 * Returns the running process's commit SHA, branch, boot time, and uptime
 * as a tiny JSON payload. Used by:
 *   - The client-side auto-update banner (polls every 15s, prompts reload
 *     when sha changes)
 *   - Operators sanity-checking 'did my push actually deploy?'
 *   - Monitoring (latency to seeing a new sha = end-to-end deploy time)
 *
 * Cache-control: no-store. Must be live, never cached.
 */

import { Hono } from "hono";
import { getBuildInfo } from "../lib/build-info";

const version = new Hono();

version.get("/api/version", (c) => {
  c.header("cache-control", "no-store, no-cache, must-revalidate");
  c.header("pragma", "no-cache");
  return c.json(getBuildInfo());
});

export default version;
