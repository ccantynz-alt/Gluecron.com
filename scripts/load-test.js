/**
 * Gluecron core flow load test
 *
 * Tests the main public-facing pages under sustained load.
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

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const errorRate = new Rate('errors');
const landingDuration = new Trend('landing_duration');
const exploreDuration = new Trend('explore_duration');
const blogDuration = new Trend('blog_duration');
const pricingDuration = new Trend('pricing_duration');

// ---------------------------------------------------------------------------
// Test options
// ---------------------------------------------------------------------------

export const options = {
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

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

function get(path, params) {
  return http.get(`${BASE_URL}${path}`, params || {});
}

// ---------------------------------------------------------------------------
// Default function — executed once per VU per iteration
// ---------------------------------------------------------------------------

export default function () {
  group('landing page', function () {
    const r = get('/');
    const ok = check(r, {
      'landing 200': (res) => res.status === 200,
      'landing has content': (res) => res.body && res.body.length > 500,
    });
    errorRate.add(!ok);
    landingDuration.add(r.timings.duration);
  });

  sleep(0.5);

  group('explore page', function () {
    const r = get('/explore');
    const ok = check(r, {
      'explore 200': (res) => res.status === 200,
    });
    errorRate.add(!ok);
    exploreDuration.add(r.timings.duration);
  });

  sleep(0.5);

  group('blog index', function () {
    const r = get('/blog');
    const ok = check(r, {
      'blog 200': (res) => res.status === 200,
      'blog has devlog header': (res) =>
        res.body && res.body.includes('Gluecron Devlog'),
    });
    errorRate.add(!ok);
    blogDuration.add(r.timings.duration);
  });

  sleep(0.3);

  group('blog post', function () {
    const r = get('/blog/spec-to-pr-in-90-seconds');
    const ok = check(r, {
      'blog post 200': (res) => res.status === 200,
      'blog post has title': (res) =>
        res.body && res.body.includes('Spec to PR'),
    });
    errorRate.add(!ok);
    blogDuration.add(r.timings.duration);
  });

  sleep(0.3);

  group('pricing page', function () {
    const r = get('/pricing');
    const ok = check(r, {
      'pricing 200': (res) => res.status === 200,
    });
    errorRate.add(!ok);
    pricingDuration.add(r.timings.duration);
  });

  sleep(1);
}
