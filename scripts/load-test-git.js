/**
 * Gluecron git Smart HTTP load test
 *
 * Tests the git Smart HTTP endpoints under concurrent load, simulating
 * the discovery and pack-negotiation phases of git clone and git fetch.
 *
 * THIS FILE RUNS UNDER k6 — do not run with node or bun directly.
 * k6 provides its own built-in modules (k6/http, k6/metrics, etc.) at runtime.
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

/* global __ENV */

// k6 built-in modules — loaded via k6's module system at runtime
var http    = require('k6/http');
var k6      = require('k6');
var metrics = require('k6/metrics');

var check   = k6.check;
var sleep   = k6.sleep;
var group   = k6.group;
var Rate    = metrics.Rate;
var Trend   = metrics.Trend;
var Counter = metrics.Counter;

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

var errorRate       = new Rate('git_errors');
var uploadPackRefs  = new Trend('upload_pack_refs_duration');
var receivePackRefs = new Trend('receive_pack_refs_duration');
var uploadPackPost  = new Trend('upload_pack_post_duration');
var gitRequests     = new Counter('git_requests_total');

// ---------------------------------------------------------------------------
// Test options — exported so k6 reads them before starting VUs
// ---------------------------------------------------------------------------

module.exports.options = {
  stages: [
    { duration: '20s', target: 50  },  // ramp: simulate developers starting their day
    { duration: '1m',  target: 50  },  // steady state: 50 concurrent git clients
    { duration: '20s', target: 150 },  // spike: CI farm wakes up and clones in bulk
    { duration: '30s', target: 150 },  // sustained spike
    { duration: '30s', target: 0   },  // ramp down
  ],
  thresholds: {
    // git-upload-pack/info/refs should be fast — capability advertisement only
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

var BASE_URL  = (typeof __ENV !== 'undefined' && __ENV.BASE_URL)  || 'http://localhost:3000';
var GIT_OWNER = (typeof __ENV !== 'undefined' && __ENV.GIT_OWNER) || 'testowner';
var GIT_REPO  = (typeof __ENV !== 'undefined' && __ENV.GIT_REPO)  || 'testrepo';
var GIT_PAT   = (typeof __ENV !== 'undefined' && __ENV.GIT_PAT)   || '';

// Derived
var REPO_PATH = '/' + GIT_OWNER + '/' + GIT_REPO + '.git';

// Auth header — only included when a PAT is available
var authHeaders = GIT_PAT
  ? { Authorization: 'Basic ' + btoa('token:' + GIT_PAT) }
  : {};

// git-upload-pack POST capability advertisement body.
// pkt-line framing for a minimal ls-refs request — what `git fetch` sends
// after reading /info/refs to negotiate a pack. Kept minimal so the server
// returns quickly without sending a full pack.
var GIT_UPLOAD_PACK_BODY = [
  '0014command=ls-refs\n',  // pkt-line: ls-refs command
  '0000',                   // flush pkt
  '0000',                   // end of capability list
].join('');

// ---------------------------------------------------------------------------
// Setup — printed once before the test starts
// ---------------------------------------------------------------------------

module.exports.setup = function () {
  console.log('[load-test-git] Target:  ' + BASE_URL + REPO_PATH);
  console.log('[load-test-git] Auth:    ' + (GIT_PAT ? 'PAT set (POST tests enabled)' : 'no PAT (read-only tests)'));
  return { baseUrl: BASE_URL, repo: REPO_PATH };
};

// ---------------------------------------------------------------------------
// Default export — executed once per VU per iteration
// ---------------------------------------------------------------------------

module.exports.default = function () {
  // ---- 1. git-upload-pack info/refs (git clone / git fetch discovery) ----
  group('upload-pack info/refs', function () {
    var url = BASE_URL + REPO_PATH + '/info/refs?service=git-upload-pack';
    var headers = {};
    Object.assign(headers, authHeaders, {
      'Git-Protocol': 'version=2',
      'User-Agent': 'git/2.44.0',
    });
    var r = http.get(url, { headers: headers });
    gitRequests.add(1);

    var ok = check(r, {
      'upload-pack refs: 200 or 401': function (res) {
        return res.status === 200 || res.status === 401;
      },
      'upload-pack refs: correct content-type': function (res) {
        return res.status === 401 ||
          (res.headers['Content-Type'] || '').indexOf(
            'application/x-git-upload-pack-advertisement'
          ) !== -1;
      },
    });
    errorRate.add(!ok);
    uploadPackRefs.add(r.timings.duration);
  });

  sleep(0.2);

  // ---- 2. git-receive-pack info/refs (git push discovery) ----
  group('receive-pack info/refs', function () {
    var url = BASE_URL + REPO_PATH + '/info/refs?service=git-receive-pack';
    var headers = {};
    Object.assign(headers, authHeaders, {
      'Git-Protocol': 'version=2',
      'User-Agent': 'git/2.44.0',
    });
    var r = http.get(url, { headers: headers });
    gitRequests.add(1);

    var ok = check(r, {
      // receive-pack always requires auth; 401 is expected for unauthed requests
      'receive-pack refs: 200 or 401': function (res) {
        return res.status === 200 || res.status === 401;
      },
      'receive-pack refs: not 500': function (res) { return res.status !== 500; },
    });
    errorRate.add(!ok);
    receivePackRefs.add(r.timings.duration);
  });

  sleep(0.3);

  // ---- 3. git-upload-pack POST (minimal ls-refs — no actual pack download) ----
  //
  // Only run when a PAT is set so we don't measure auth-rejection latency.
  if (GIT_PAT) {
    group('upload-pack POST (ls-refs)', function () {
      var url = BASE_URL + REPO_PATH + '/git-upload-pack';
      var headers = {};
      Object.assign(headers, authHeaders, {
        'Content-Type': 'application/x-git-upload-pack-request',
        'Accept':       'application/x-git-upload-pack-result',
        'Git-Protocol': 'version=2',
        'User-Agent':   'git/2.44.0',
      });
      var r = http.post(url, GIT_UPLOAD_PACK_BODY, { headers: headers });
      gitRequests.add(1);

      var ok = check(r, {
        'upload-pack POST: 200': function (res) { return res.status === 200; },
        'upload-pack POST: git content-type': function (res) {
          return (res.headers['Content-Type'] || '').indexOf(
            'application/x-git-upload-pack-result'
          ) !== -1;
        },
        'upload-pack POST: not empty': function (res) {
          return res.body !== null && res.body.length > 0;
        },
      });
      errorRate.add(!ok);
      uploadPackPost.add(r.timings.duration);
    });
  }

  // ---- 4. Raw blob fetch (simulates web raw file downloads) ----
  group('raw file fetch (HEAD README)', function () {
    var url = BASE_URL + '/' + GIT_OWNER + '/' + GIT_REPO + '/raw/HEAD/README.md';
    var r = http.get(url, { headers: authHeaders });
    gitRequests.add(1);

    var ok = check(r, {
      'raw: 200 or 404': function (res) { return res.status === 200 || res.status === 404; },
      'raw: not 500': function (res) { return res.status !== 500; },
    });
    errorRate.add(!ok);
  });

  sleep(1);
};
