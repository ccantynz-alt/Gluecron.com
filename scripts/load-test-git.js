/**
 * Gluecron git Smart HTTP load test
 *
 * Tests the git Smart HTTP endpoints under concurrent load, simulating
 * the discovery and pack-negotiation phases of git clone and git fetch.
 *
 * Covered endpoints:
 *   GET  /:owner/:repo.git/info/refs?service=git-upload-pack
 *   GET  /:owner/:repo.git/info/refs?service=git-receive-pack
 *   POST /:owner/:repo.git/git-upload-pack (upload-pack capability advertisement)
 *
 * Usage:
 *   k6 run scripts/load-test-git.js
 *
 * Required env vars:
 *   BASE_URL      — server base URL (default: http://localhost:3000)
 *   GIT_OWNER     — git repo owner username (default: testowner)
 *   GIT_REPO      — git repo name (default: testrepo)
 *   GIT_PAT       — personal access token for authenticated push simulation
 *                   (optional; unauthenticated read tests still run without it)
 *
 * Example with a real public repo:
 *   BASE_URL=https://gluecron.com GIT_OWNER=ccantynz GIT_REPO=Gluecron.com \
 *     k6 run scripts/load-test-git.js
 *
 * Requirements: k6 >= 0.46  (https://k6.io/docs/get-started/installation/)
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const errorRate        = new Rate('git_errors');
const uploadPackRefs   = new Trend('upload_pack_refs_duration');
const receivePackRefs  = new Trend('receive_pack_refs_duration');
const uploadPackPost   = new Trend('upload_pack_post_duration');
const gitRequests      = new Counter('git_requests_total');

// ---------------------------------------------------------------------------
// Test options
// ---------------------------------------------------------------------------

export const options = {
  stages: [
    { duration: '20s', target: 50  },  // ramp: simulate developers starting their day
    { duration: '1m',  target: 50  },  // steady state: 50 concurrent git clients
    { duration: '20s', target: 150 },  // spike: CI farm wakes up and clones in bulk
    { duration: '30s', target: 150 },  // sustained spike
    { duration: '30s', target: 0   },  // ramp down
  ],
  thresholds: {
    // git-upload-pack/info/refs should be fast — it's just a capability advertisement
    upload_pack_refs_duration: ['p(95)<300', 'p(99)<800'],
    // receive-pack refs can be a touch slower (auth check + lock)
    receive_pack_refs_duration: ['p(95)<400', 'p(99)<1000'],
    // POST upload-pack: streaming body, allow more headroom
    upload_pack_post_duration: ['p(95)<1000', 'p(99)<3000'],
    // Overall HTTP failure rate
    http_req_failed: ['rate<0.01'],
    // Our own error tracking
    git_errors: ['rate<0.02'],
  },
};

// ---------------------------------------------------------------------------
// Configuration from env
// ---------------------------------------------------------------------------

const BASE_URL   = __ENV.BASE_URL   || 'http://localhost:3000';
const GIT_OWNER  = __ENV.GIT_OWNER  || 'testowner';
const GIT_REPO   = __ENV.GIT_REPO   || 'testrepo';
const GIT_PAT    = __ENV.GIT_PAT    || '';

// Derived
const REPO_PATH  = `/${GIT_OWNER}/${GIT_REPO}.git`;

// Auth header — only included when a PAT is available
const authHeaders = GIT_PAT
  ? { Authorization: `Basic ${btoa(`token:${GIT_PAT}`)}` }
  : {};

// git-upload-pack POST capability advertisement body.
// This is the pkt-line framing for a minimal ls-refs request — exactly what
// `git fetch` sends after it reads /info/refs and wants to negotiate a pack.
//
// Format: 4-char hex length prefix + payload, terminated with "0000" flush.
// "0011command=ls-refs" = 0x11 bytes of payload = 17 + 4 = 21 total → "0015"
// We keep it minimal so the server returns quickly without sending a full pack.
const GIT_UPLOAD_PACK_BODY = [
  '0014command=ls-refs\n',  // pkt-line: ls-refs command
  '0000',                   // flush pkt
  '0000',                   // end of capability list
].join('');

// ---------------------------------------------------------------------------
// Default function — executed once per VU per iteration
// ---------------------------------------------------------------------------

export default function () {
  // ---- 1. git-upload-pack info/refs (git clone / git fetch discovery) ----
  group('upload-pack info/refs', function () {
    const url = `${BASE_URL}${REPO_PATH}/info/refs?service=git-upload-pack`;
    const r = http.get(url, {
      headers: {
        ...authHeaders,
        'Git-Protocol': 'version=2',
        'User-Agent': 'git/2.44.0',
      },
    });
    gitRequests.add(1);

    const ok = check(r, {
      'upload-pack refs: 200 or 401': (res) =>
        res.status === 200 || res.status === 401,
      'upload-pack refs: correct content-type': (res) =>
        // Public repos return 200 with the git content-type.
        // Private repos behind auth return 401 — both are correct behaviour.
        res.status === 401 ||
        (res.headers['Content-Type'] || '').includes(
          'application/x-git-upload-pack-advertisement'
        ),
    });
    errorRate.add(!ok);
    uploadPackRefs.add(r.timings.duration);
  });

  sleep(0.2);

  // ---- 2. git-receive-pack info/refs (git push discovery) ----
  group('receive-pack info/refs', function () {
    const url = `${BASE_URL}${REPO_PATH}/info/refs?service=git-receive-pack`;
    const r = http.get(url, {
      headers: {
        ...authHeaders,
        'Git-Protocol': 'version=2',
        'User-Agent': 'git/2.44.0',
      },
    });
    gitRequests.add(1);

    const ok = check(r, {
      // receive-pack always requires auth; 401 is the expected response for
      // unauthenticated requests. 200 is correct for authenticated pushers.
      'receive-pack refs: 200 or 401': (res) =>
        res.status === 200 || res.status === 401,
      'receive-pack refs: not 500': (res) => res.status !== 500,
    });
    errorRate.add(!ok);
    receivePackRefs.add(r.timings.duration);
  });

  sleep(0.3);

  // ---- 3. git-upload-pack POST (minimal ls-refs — no actual pack download) ----
  //
  // Only run when a PAT is set so we don't spam unauthenticated POST 401s
  // which would skew the POST timing metrics with auth-rejection noise.
  if (GIT_PAT) {
    group('upload-pack POST (ls-refs)', function () {
      const url = `${BASE_URL}${REPO_PATH}/git-upload-pack`;
      const r = http.post(url, GIT_UPLOAD_PACK_BODY, {
        headers: {
          ...authHeaders,
          'Content-Type': 'application/x-git-upload-pack-request',
          'Accept':        'application/x-git-upload-pack-result',
          'Git-Protocol':  'version=2',
          'User-Agent':    'git/2.44.0',
        },
      });
      gitRequests.add(1);

      const ok = check(r, {
        'upload-pack POST: 200': (res) => res.status === 200,
        'upload-pack POST: git content-type': (res) =>
          (res.headers['Content-Type'] || '').includes(
            'application/x-git-upload-pack-result'
          ),
        'upload-pack POST: not empty': (res) =>
          res.body !== null && res.body.length > 0,
      });
      errorRate.add(!ok);
      uploadPackPost.add(r.timings.duration);
    });
  }

  // ---- 4. Raw blob fetch (simulates `git archive` or web raw downloads) ----
  group('raw file fetch (HEAD README)', function () {
    // Fetches the raw README from the default branch.
    // Non-existent paths 404 cleanly; the check accepts both 200 and 404
    // so the test passes even when the test repo doesn't exist yet.
    const url = `${BASE_URL}/${GIT_OWNER}/${GIT_REPO}/raw/HEAD/README.md`;
    const r = http.get(url, {
      headers: { ...authHeaders },
    });
    gitRequests.add(1);

    const ok = check(r, {
      'raw: 200 or 404': (res) => res.status === 200 || res.status === 404,
      'raw: not 500': (res) => res.status !== 500,
    });
    errorRate.add(!ok);
  });

  sleep(1);
}

// ---------------------------------------------------------------------------
// Setup — print configuration once before the test starts
// ---------------------------------------------------------------------------

export function setup() {
  console.log(`[load-test-git] Target:  ${BASE_URL}${REPO_PATH}`);
  console.log(`[load-test-git] Auth:    ${GIT_PAT ? 'PAT set (POST tests enabled)' : 'no PAT (read-only tests)'}`);
  return { baseUrl: BASE_URL, repo: REPO_PATH };
}
