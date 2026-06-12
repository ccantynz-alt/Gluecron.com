/**
 * SSRF guard tests — P1 security hardening (BUILD_BIBLE §7).
 *
 * Pins down `src/lib/ssrf-guard.ts`:
 *   - isPrivateAddress(): every reserved IPv4 range (incl. the
 *     decimal/hex/octal single-integer encodings), IPv6 private forms,
 *     and the localhost/.local/.internal hostname conventions
 *   - assertPublicUrl(): scheme allow-list, private-host rejection, and
 *     the SSRF_ALLOW_PRIVATE / test-env escape hatches
 *   - resolvesToPrivate(): injectable resolver, best-effort on failure
 *   - mirrors wiring: validateUpstreamUrl() rejects private upstreams
 *
 * The guard default-allows private addresses when NODE_ENV=test, so the
 * env-dependent suites set SSRF_ENFORCE_IN_TEST=1 up front and restore
 * the original env afterwards. isPrivateAddress() itself is pure and
 * needs no env handling.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  assertPublicUrl,
  isPrivateAddress,
  parseIpv4,
  resolvesToPrivate,
  ssrfPrivateAllowed,
} from "../lib/ssrf-guard";
import { validateUpstreamUrl } from "../lib/mirrors";

// ---------------------------------------------------------------------------
// Env bookkeeping — enforce blocking for this file, restore on exit.
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = {
  enforce: process.env.SSRF_ENFORCE_IN_TEST,
  allow: process.env.SSRF_ALLOW_PRIVATE,
};

beforeAll(() => {
  process.env.SSRF_ENFORCE_IN_TEST = "1";
  delete process.env.SSRF_ALLOW_PRIVATE;
});

afterAll(() => {
  if (ORIGINAL_ENV.enforce === undefined) {
    delete process.env.SSRF_ENFORCE_IN_TEST;
  } else {
    process.env.SSRF_ENFORCE_IN_TEST = ORIGINAL_ENV.enforce;
  }
  if (ORIGINAL_ENV.allow === undefined) {
    delete process.env.SSRF_ALLOW_PRIVATE;
  } else {
    process.env.SSRF_ALLOW_PRIVATE = ORIGINAL_ENV.allow;
  }
});

// ---------------------------------------------------------------------------
// isPrivateAddress — hostname conventions
// ---------------------------------------------------------------------------

describe("ssrf-guard — isPrivateAddress hostnames", () => {
  it("blocks localhost and *.localhost", () => {
    expect(isPrivateAddress("localhost")).toBe(true);
    expect(isPrivateAddress("LOCALHOST")).toBe(true);
    expect(isPrivateAddress("foo.localhost")).toBe(true);
    expect(isPrivateAddress("a.b.localhost")).toBe(true);
    expect(isPrivateAddress("localhost.")).toBe(true); // trailing-dot FQDN
  });

  it("blocks .local and .internal TLDs", () => {
    expect(isPrivateAddress("printer.local")).toBe(true);
    expect(isPrivateAddress("db.prod.internal")).toBe(true);
    expect(isPrivateAddress("metadata.google.internal")).toBe(true);
  });

  it("does not block lookalike hostnames", () => {
    expect(isPrivateAddress("localhost.example.com")).toBe(false);
    expect(isPrivateAddress("notlocalhost")).toBe(false);
    expect(isPrivateAddress("internal.example.com")).toBe(false);
    expect(isPrivateAddress("locality.example.org")).toBe(false);
  });

  it("blocks the empty host", () => {
    expect(isPrivateAddress("")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isPrivateAddress — IPv4 ranges
// ---------------------------------------------------------------------------

describe("ssrf-guard — isPrivateAddress IPv4 ranges", () => {
  it("blocks 127.0.0.0/8 loopback", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("127.255.255.255")).toBe(true);
    expect(isPrivateAddress("127.1.2.3")).toBe(true);
  });

  it("blocks 10.0.0.0/8", () => {
    expect(isPrivateAddress("10.0.0.1")).toBe(true);
    expect(isPrivateAddress("10.255.255.255")).toBe(true);
  });

  it("blocks 172.16.0.0/12 (and only that slice of 172/8)", () => {
    expect(isPrivateAddress("172.16.0.1")).toBe(true);
    expect(isPrivateAddress("172.31.255.255")).toBe(true);
    expect(isPrivateAddress("172.15.0.1")).toBe(false);
    expect(isPrivateAddress("172.32.0.1")).toBe(false);
  });

  it("blocks 192.168.0.0/16", () => {
    expect(isPrivateAddress("192.168.0.1")).toBe(true);
    expect(isPrivateAddress("192.168.255.255")).toBe(true);
    expect(isPrivateAddress("192.169.0.1")).toBe(false);
  });

  it("blocks 169.254.0.0/16 link-local (cloud metadata)", () => {
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("169.254.0.1")).toBe(true);
    expect(isPrivateAddress("169.253.0.1")).toBe(false);
  });

  it("blocks 100.64.0.0/10 CGNAT (and only that slice of 100/8)", () => {
    expect(isPrivateAddress("100.64.0.1")).toBe(true);
    expect(isPrivateAddress("100.127.255.255")).toBe(true);
    expect(isPrivateAddress("100.63.255.255")).toBe(false);
    expect(isPrivateAddress("100.128.0.1")).toBe(false);
  });

  it("blocks 0.0.0.0/8 and the broadcast address", () => {
    expect(isPrivateAddress("0.0.0.0")).toBe(true);
    expect(isPrivateAddress("0.1.2.3")).toBe(true);
    expect(isPrivateAddress("255.255.255.255")).toBe(true);
  });

  it("allows public IPv4", () => {
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("1.1.1.1")).toBe(false);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(isPrivateAddress("255.255.255.254")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPrivateAddress — integer/hex/octal IPv4 encodings
// ---------------------------------------------------------------------------

describe("ssrf-guard — IPv4 integer encodings", () => {
  it("parses single-integer forms (parseIpv4)", () => {
    expect(parseIpv4("2130706433")).toBe(0x7f000001); // 127.0.0.1
    expect(parseIpv4("0x7f000001")).toBe(0x7f000001);
    expect(parseIpv4("017700000001")).toBe(0x7f000001); // octal
    expect(parseIpv4("example.com")).toBeNull();
    expect(parseIpv4("4294967296")).toBeNull(); // > 0xffffffff
  });

  it("blocks decimal-integer loopback (http://2130706433/)", () => {
    expect(isPrivateAddress("2130706433")).toBe(true);
  });

  it("blocks hex-integer loopback (0x7f000001)", () => {
    expect(isPrivateAddress("0x7f000001")).toBe(true);
  });

  it("blocks octal-integer loopback (017700000001)", () => {
    expect(isPrivateAddress("017700000001")).toBe(true);
  });

  it("blocks mixed-radix dotted forms", () => {
    expect(isPrivateAddress("0177.0.0.1")).toBe(true); // octal octet
    expect(isPrivateAddress("0xa.0.0.1")).toBe(true); // hex octet → 10.0.0.1
    expect(isPrivateAddress("0x7f.1")).toBe(true); // 2-part → 127.0.0.1
    expect(isPrivateAddress("127.1")).toBe(true); // inet_aton short form
    expect(isPrivateAddress("169.254.43518")).toBe(true); // 3-part link-local
  });

  it("allows public integer encodings", () => {
    expect(isPrivateAddress("134744072")).toBe(false); // 8.8.8.8
    expect(isPrivateAddress("0x08080808")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPrivateAddress — IPv6 forms
// ---------------------------------------------------------------------------

describe("ssrf-guard — isPrivateAddress IPv6", () => {
  it("blocks ::1 loopback and :: unspecified", () => {
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("::")).toBe(true);
    expect(isPrivateAddress("0:0:0:0:0:0:0:1")).toBe(true);
  });

  it("handles the URL bracket form", () => {
    expect(isPrivateAddress("[::1]")).toBe(true);
    expect(isPrivateAddress("[fe80::1]")).toBe(true);
    expect(isPrivateAddress("[2606:4700::1111]")).toBe(false);
  });

  it("blocks fc00::/7 unique-local", () => {
    expect(isPrivateAddress("fc00::1")).toBe(true);
    expect(isPrivateAddress("fd12:3456:789a::1")).toBe(true);
    expect(isPrivateAddress("fdff:ffff::1")).toBe(true);
    expect(isPrivateAddress("fbff::1")).toBe(false); // just below fc00::/7
    expect(isPrivateAddress("fe00::1")).toBe(false); // just above
  });

  it("blocks fe80::/10 link-local (incl. zone ids)", () => {
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("febf::1")).toBe(true); // top of /10
    expect(isPrivateAddress("fe80::1%eth0")).toBe(true);
    expect(isPrivateAddress("fec0::1")).toBe(false); // above the /10
  });

  it("blocks IPv4-mapped private addresses", () => {
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:192.168.1.1")).toBe(true);
    expect(isPrivateAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateAddress("::ffff:7f00:1")).toBe(true); // hex-word mapped 127.0.0.1
  });

  it("allows IPv4-mapped public addresses and public IPv6", () => {
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
    expect(isPrivateAddress("2001:4860:4860::8888")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assertPublicUrl
// ---------------------------------------------------------------------------

describe("ssrf-guard — assertPublicUrl", () => {
  it("accepts public http/https URLs", () => {
    const r1 = assertPublicUrl("https://example.com/webhook");
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.url.hostname).toBe("example.com");
    expect(assertPublicUrl("http://api.example.org:8080/x").ok).toBe(true);
    expect(assertPublicUrl("https://user:pw@example.com/x").ok).toBe(true); // creds allowed
  });

  it("rejects non-http(s) schemes by default", () => {
    for (const raw of [
      "ftp://example.com/x",
      "file:///etc/passwd",
      "gopher://example.com/x",
      "git://example.com/x.git",
    ]) {
      const r = assertPublicUrl(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("scheme");
    }
  });

  it("accepts widened schemes via opts.schemes", () => {
    const r = assertPublicUrl("git://kernel.org/linux.git", {
      schemes: ["http:", "https:", "git:"],
    });
    expect(r.ok).toBe(true);
  });

  it("rejects unparseable URLs", () => {
    const r = assertPublicUrl("not a url");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("invalid");
  });

  it("rejects private hosts in every encoding", () => {
    for (const raw of [
      "http://localhost:3000/hook",
      "http://127.0.0.1/hook",
      "http://10.1.2.3/hook",
      "http://172.16.0.1/hook",
      "http://192.168.1.1/hook",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/hook",
      "http://0.0.0.0/hook",
      "http://2130706433/hook", // decimal 127.0.0.1 (URL normalizes it)
      "http://0x7f000001/hook", // hex 127.0.0.1
      "http://[::1]/hook",
      "http://[fd00::1]/hook",
      "http://[fe80::1]/hook",
      "http://[::ffff:10.0.0.1]/hook",
      "http://internal-db.local/hook",
      "http://svc.cluster.internal/hook",
    ]) {
      const r = assertPublicUrl(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("private");
    }
  });

  it("opts.allowPrivate=true bypasses the private-host check", () => {
    expect(
      assertPublicUrl("http://127.0.0.1/hook", { allowPrivate: true }).ok
    ).toBe(true);
    // ...but not the scheme check.
    expect(
      assertPublicUrl("file:///etc/passwd", { allowPrivate: true }).ok
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Escape hatches — env read at call time
// ---------------------------------------------------------------------------

describe("ssrf-guard — env escape hatches", () => {
  it("SSRF_ALLOW_PRIVATE=1 allows private hosts (read at call time)", () => {
    expect(assertPublicUrl("http://127.0.0.1/hook").ok).toBe(false);
    process.env.SSRF_ALLOW_PRIVATE = "1";
    try {
      expect(ssrfPrivateAllowed()).toBe(true);
      expect(assertPublicUrl("http://127.0.0.1/hook").ok).toBe(true);
      expect(assertPublicUrl("http://192.168.1.1/hook").ok).toBe(true);
    } finally {
      delete process.env.SSRF_ALLOW_PRIVATE;
    }
    expect(assertPublicUrl("http://127.0.0.1/hook").ok).toBe(false);
  });

  it("test env default-allows unless SSRF_ENFORCE_IN_TEST=1", () => {
    // This file sets SSRF_ENFORCE_IN_TEST=1 in beforeAll; lifting it while
    // NODE_ENV=test (bun test sets it) must default to allow, so existing
    // suites that POST to localhost keep passing untouched.
    delete process.env.SSRF_ENFORCE_IN_TEST;
    try {
      expect(ssrfPrivateAllowed()).toBe(true);
      expect(assertPublicUrl("http://localhost:1234/hook").ok).toBe(true);
    } finally {
      process.env.SSRF_ENFORCE_IN_TEST = "1";
    }
    expect(ssrfPrivateAllowed()).toBe(false);
    expect(assertPublicUrl("http://localhost:1234/hook").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolvesToPrivate — injectable DNS layer
// ---------------------------------------------------------------------------

describe("ssrf-guard — resolvesToPrivate", () => {
  it("short-circuits on private literals without resolving", async () => {
    let called = false;
    const resolver = async () => {
      called = true;
      return [{ address: "8.8.8.8" }];
    };
    expect(await resolvesToPrivate("127.0.0.1", resolver)).toBe(true);
    expect(called).toBe(false);
  });

  it("flags hostnames that resolve to private addresses", async () => {
    const resolver = async () => [{ address: "10.0.0.5" }];
    expect(await resolvesToPrivate("evil.example.com", resolver)).toBe(true);
  });

  it("flags when any of several records is private", async () => {
    const resolver = async () => [
      { address: "93.184.216.34" },
      { address: "169.254.169.254" },
    ];
    expect(await resolvesToPrivate("dual.example.com", resolver)).toBe(true);
  });

  it("passes hostnames that resolve publicly", async () => {
    const resolver = async () => [{ address: "93.184.216.34" }];
    expect(await resolvesToPrivate("example.com", resolver)).toBe(false);
  });

  it("is best-effort: resolution failure does not block", async () => {
    const resolver = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await resolvesToPrivate("nx.example.com", resolver)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wiring — mirrors.validateUpstreamUrl uses the guard
// ---------------------------------------------------------------------------

describe("ssrf-guard — mirrors wiring", () => {
  it("validateUpstreamUrl rejects private upstreams when enforced", () => {
    for (const raw of [
      "http://127.0.0.1/x.git",
      "http://localhost:3000/x.git",
      "https://169.254.169.254/x.git",
      "git://10.0.0.1/x.git",
      "http://2130706433/x.git",
    ]) {
      const r = validateUpstreamUrl(raw);
      expect(r.ok).toBe(false);
      expect(r.error).toContain("SSRF");
    }
  });

  it("validateUpstreamUrl still accepts public upstreams", () => {
    expect(validateUpstreamUrl("https://github.com/foo/bar.git").ok).toBe(true);
    expect(validateUpstreamUrl("git://kernel.org/linux.git").ok).toBe(true);
  });
});
