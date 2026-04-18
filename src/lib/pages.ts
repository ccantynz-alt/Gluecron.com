/**
 * Block C3 — Pages / static hosting helpers.
 *
 * Exposes:
 *   - onPagesPush()       — called from post-receive after a gh-pages push
 *   - resolvePagesPath()  — URL-rest -> list of blob paths to probe
 *   - contentTypeFor()    — extension -> mime string
 *
 * Deployment model: every accepted push to the configured source branch
 * (default "gh-pages") records a row in pages_deployments. Serving reads the
 * most recent deployment's commit sha and pulls blobs directly out of the
 * bare repo — there is no on-disk export step.
 */

import { db } from "../db";
import { pagesDeployments } from "../db/schema";

/**
 * Minimal extension -> MIME lookup used by the pages server. Returns
 * "application/octet-stream" for anything not in the map so the browser
 * will at least offer the bytes as a download instead of mis-rendering.
 */
export function contentTypeFor(filename: string): string {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = lower.slice(dot + 1);
  switch (ext) {
    case "html":
    case "htm":
      return "text/html; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "js":
    case "mjs":
      return "application/javascript; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "ico":
      return "image/x-icon";
    case "txt":
    case "md":
      return "text/plain; charset=utf-8";
    case "pdf":
      return "application/pdf";
    case "xml":
      return "application/xml; charset=utf-8";
    case "wasm":
      return "application/wasm";
    case "woff":
      return "font/woff";
    case "woff2":
      return "font/woff2";
    case "ttf":
      return "font/ttf";
    case "otf":
      return "font/otf";
    case "map":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

/**
 * Normalise a source-dir setting to a plain prefix with no leading/trailing
 * slashes (empty string for root).
 */
function normaliseSourceDir(sourceDir: string): string {
  let d = (sourceDir || "/").trim();
  d = d.replace(/^\/+/, "").replace(/\/+$/, "");
  return d;
}

/**
 * Normalise a URL-rest component. Keeps internal slashes but drops leading
 * ones and any `..` path-traversal attempts. Returns "" for empty / pure "/".
 */
function normaliseUrlRest(urlRest: string): string {
  let r = (urlRest || "").trim();
  r = r.replace(/^\/+/, "");
  // Strip ../ segments — cheap sanity, not a full path resolver.
  const parts = r
    .split("/")
    .filter((p) => p.length > 0 && p !== "." && p !== "..");
  return parts.join("/");
}

/**
 * Given a URL rest-path (e.g. "", "about", "blog/first/", "assets/x.png"),
 * return the ordered list of repo paths to try in the pages blob store.
 * The first existing blob wins.
 *
 *   ""             -> ["index.html"]
 *   "about"        -> ["about.html", "about/index.html"]
 *   "about/"       -> ["about/index.html"]
 *   "a/b.css"      -> ["a/b.css"]
 *   sourceDir="docs" prefixes every entry with "docs/".
 */
export function resolvePagesPath(
  urlRest: string,
  sourceDir: string,
  indexHtml = "index.html"
): string[] {
  const prefix = normaliseSourceDir(sourceDir);
  const rest = normaliseUrlRest(urlRest);
  const endsWithSlash = /\/$/.test(urlRest || "") || urlRest === "";

  const join = (p: string) => (prefix ? `${prefix}/${p}` : p);

  // Root / directory-style URL -> serve the index.
  if (rest === "") {
    return [join(indexHtml)];
  }

  // Trailing slash or explicit dir -> only try the index inside it.
  if (endsWithSlash) {
    return [join(`${rest}/${indexHtml}`)];
  }

  // Has a file extension -> serve exactly that path.
  const base = rest.split("/").pop() || "";
  if (base.includes(".")) {
    return [join(rest)];
  }

  // Extensionless -> pretty URL. Try foo.html first, then foo/index.html.
  return [join(`${rest}.html`), join(`${rest}/${indexHtml}`)];
}

/**
 * Record a pages deployment. Never throws — post-receive calls this and must
 * not have its primary push path broken by pages bookkeeping.
 */
export async function onPagesPush(opts: {
  ownerLogin: string;
  repoName: string;
  repositoryId: string;
  ref: string;
  newSha: string;
  triggeredByUserId: string | null;
}): Promise<void> {
  try {
    await db.insert(pagesDeployments).values({
      repositoryId: opts.repositoryId,
      ref: opts.ref,
      commitSha: opts.newSha,
      status: "success",
      triggeredBy: opts.triggeredByUserId,
    });
    console.log(
      `[pages] deployed ${opts.ownerLogin}/${opts.repoName} ${opts.ref}@${opts.newSha.slice(0, 7)}`
    );
  } catch (err) {
    console.error(
      `[pages] failed to record deployment for ${opts.ownerLogin}/${opts.repoName}:`,
      err
    );
    // Try to record a failure row so the settings UI can surface it.
    try {
      await db.insert(pagesDeployments).values({
        repositoryId: opts.repositoryId,
        ref: opts.ref,
        commitSha: opts.newSha,
        status: "failed",
        triggeredBy: opts.triggeredByUserId,
      });
    } catch {
      /* swallow */
    }
  }
}
