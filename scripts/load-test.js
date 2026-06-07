/**
 * Gluecron core flow load test
 *
 * Tests the main public-facing pages under sustained load.
 *
 * THIS FILE RUNS UNDER k6 — do not run with node or bun directly.
 * k6 provides its own built-in modules (k6/http, k6/metrics, etc.) at runtime.
 *
 * Usage:
 *   k6 run scripts/load-test.js
 *
 * Override base URL:
 *   BASE_URL=https://gluecron.com k6 run scripts/load-test.js
 *
 * Staged run against staging:
 *   BASE_URL=https://staging.gluecron.com k6 run scripts/load-test.js
 *
 * Requirements: k6 >= 0.46  (https://k6.io/docs/get-started/installation/)
 */

/* global __ENV */

// k6 built-in modules — loaded via k6's module system at runtime
var http    = require('k6/http');
var k6      = require('k6');
var metrics = require('k6/metrics');

var check  = k6.check;
var sleep  = k6.sleep;
var group  = k6.group;
var Rate   = metrics.Rate;
var Trend  = metrics.Trend;

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

var errorRate      = new Rate('errors');
var landingDuration  = new Trend('landing_duration');
var exploreDuration  = new Trend('explore_duration');
var blogDuration     = new Trend('blog_duration');
var pricingDuration  = new Trend('pricing_duration');

// ---------------------------------------------------------------------------
// Test options — exported so k6 reads them before starting VUs
// ---------------------------------------------------------------------------

module.exports.options = {
  stages: [
    { duration: '30s', target: 100 },   // ramp up to 100 VUs
    { duration: '1m',  target: 100 },   // steady state
    { duration: '30s', target: 0 },     // ramp down
  ],
  thresholds: {
    // 95th-percentile response time under 500ms across all requests
    http_req_duration: ['p(95)<500'],
    // Less than 1% of requests may fail
    http_req_failed: ['rate<0.01'],
    // Custom error rate mirrors http_req_failed but allows per-check tracking
    errors: ['rate<0.01'],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

var BASE_URL = (typeof __ENV !== 'undefined' && __ENV.BASE_URL) || 'http://localhost:3000';

function get(path, params) {
  return http.get(BASE_URL + path, params || {});
}

// ---------------------------------------------------------------------------
// Default export — executed once per VU per iteration
// ---------------------------------------------------------------------------

module.exports.default = function () {
  group('landing page', function () {
    var r = get('/');
    var ok = check(r, {
      'landing 200': function (res) { return res.status === 200; },
      'landing has content': function (res) { return res.body && res.body.length > 500; },
    });
    errorRate.add(!ok);
    landingDuration.add(r.timings.duration);
  });

  sleep(0.5);

  group('explore page', function () {
    var r = get('/explore');
    var ok = check(r, {
      'explore 200': function (res) { return res.status === 200; },
    });
    errorRate.add(!ok);
    exploreDuration.add(r.timings.duration);
  });

  sleep(0.5);

  group('blog index', function () {
    var r = get('/blog');
    var ok = check(r, {
      'blog 200': function (res) { return res.status === 200; },
      'blog has devlog header': function (res) {
        return res.body && res.body.indexOf('Gluecron Devlog') !== -1;
      },
    });
    errorRate.add(!ok);
    blogDuration.add(r.timings.duration);
  });

  sleep(0.3);

  group('blog post', function () {
    var r = get('/blog/spec-to-pr-in-90-seconds');
    var ok = check(r, {
      'blog post 200': function (res) { return res.status === 200; },
      'blog post has title': function (res) {
        return res.body && res.body.indexOf('Spec to PR') !== -1;
      },
    });
    errorRate.add(!ok);
    blogDuration.add(r.timings.duration);
  });

  sleep(0.3);

  group('pricing page', function () {
    var r = get('/pricing');
    var ok = check(r, {
      'pricing 200': function (res) { return res.status === 200; },
    });
    errorRate.add(!ok);
    pricingDuration.add(r.timings.duration);
  });

  sleep(1);
};
