/**
 * Pure unit tests for the git-remote parser.
 *
 * Run with:  node --test out/__tests__/extension.test.js
 * (i.e. after `tsc -p .`) — keeps the test runner zero-dependency, matches
 * the rest of the extension's "no extra dev deps" stance.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildBlobUrl,
  isGluecronRemote,
  parseGitRemote,
} from "../git";

test("parseGitRemote: https remote with .git suffix", () => {
  const r = parseGitRemote("https://gluecron.com/ccantynz/Gluecron.com.git");
  assert.deepEqual(r, {
    owner: "ccantynz",
    repo: "Gluecron.com",
    host: "gluecron.com",
  });
});

test("parseGitRemote: https remote without .git suffix", () => {
  const r = parseGitRemote("https://gluecron.com/acme/widgets");
  assert.deepEqual(r, { owner: "acme", repo: "widgets", host: "gluecron.com" });
});

test("parseGitRemote: scp-style git@host:owner/repo.git", () => {
  const r = parseGitRemote("git@gluecron.com:ccantynz/Gluecron.com.git");
  assert.deepEqual(r, {
    owner: "ccantynz",
    repo: "Gluecron.com",
    host: "gluecron.com",
  });
});

test("parseGitRemote: ssh:// URL with port", () => {
  const r = parseGitRemote("ssh://git@gluecron.com:2222/acme/widgets.git");
  assert.deepEqual(r, { owner: "acme", repo: "widgets", host: "gluecron.com" });
});

test("parseGitRemote: http localhost with port", () => {
  const r = parseGitRemote("http://localhost:3000/me/repo.git");
  assert.deepEqual(r, { owner: "me", repo: "repo", host: "localhost" });
});

test("parseGitRemote: URL with embedded credentials", () => {
  const r = parseGitRemote("https://user:pat@gluecron.com/acme/widgets.git");
  assert.deepEqual(r, { owner: "acme", repo: "widgets", host: "gluecron.com" });
});

test("parseGitRemote: nested path prefix takes the last two segments", () => {
  const r = parseGitRemote("https://example.com/git/acme/widgets.git");
  assert.deepEqual(r, { owner: "acme", repo: "widgets", host: "example.com" });
});

test("parseGitRemote: empty + garbage inputs return null", () => {
  assert.equal(parseGitRemote(""), null);
  assert.equal(parseGitRemote("   "), null);
  assert.equal(parseGitRemote("not-a-url"), null);
  assert.equal(parseGitRemote("https://gluecron.com/justowner"), null);
  // @ts-expect-error — runtime guard for callers that lose types.
  assert.equal(parseGitRemote(null), null);
  // @ts-expect-error
  assert.equal(parseGitRemote(undefined), null);
});

test("isGluecronRemote: matches plain hostname", () => {
  assert.equal(isGluecronRemote("gluecron.com", "https://gluecron.com"), true);
  assert.equal(isGluecronRemote("Gluecron.com", "https://gluecron.com"), true);
  assert.equal(isGluecronRemote("gluecron.com", "https://example.com"), false);
});

test("isGluecronRemote: ignores port + path on the configured host", () => {
  assert.equal(
    isGluecronRemote("localhost", "http://localhost:3000/some/path"),
    true
  );
});

test("isGluecronRemote: handles a bare hostname (no scheme) config value", () => {
  assert.equal(isGluecronRemote("gluecron.com", "gluecron.com"), true);
});

test("buildBlobUrl: composes owner/repo/branch/path", () => {
  const u = buildBlobUrl(
    "https://gluecron.com",
    "acme",
    "widgets",
    "main",
    "src/index.ts"
  );
  assert.equal(u, "https://gluecron.com/acme/widgets/blob/main/src/index.ts");
});

test("buildBlobUrl: appends 1-indexed line anchor", () => {
  const u = buildBlobUrl(
    "https://gluecron.com",
    "acme",
    "widgets",
    "main",
    "src/index.ts",
    41
  );
  assert.equal(
    u,
    "https://gluecron.com/acme/widgets/blob/main/src/index.ts#L42"
  );
});

test("buildBlobUrl: strips trailing slashes from host + leading slashes from path", () => {
  const u = buildBlobUrl(
    "https://gluecron.com/",
    "acme",
    "widgets",
    "main",
    "/src/index.ts"
  );
  assert.equal(u, "https://gluecron.com/acme/widgets/blob/main/src/index.ts");
});
