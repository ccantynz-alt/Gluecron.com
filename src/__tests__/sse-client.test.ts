import { describe, it, expect } from "bun:test";
import {
  liveSubscribeScript,
  liveCommentBannerScript,
} from "../lib/sse-client";

describe("liveSubscribeScript", () => {
  it("returns a string containing EventSource and the topic path", () => {
    const js = liveSubscribeScript({
      topic: "repo:abc",
      targetElementId: "live-feed",
    });

    expect(typeof js).toBe("string");
    expect(js).toContain("EventSource");
    // topic is JSON-encoded then concatenated with the /live-events/ prefix
    // at runtime, so both must appear in the emitted script.
    expect(js).toContain("/live-events/");
    expect(js).toContain('"repo:abc"');
    // targetElementId must also be JSON-escaped into the snippet.
    expect(js).toContain('"live-feed"');
  });

  it("JSON-escapes bad topic strings to prevent </script> injection", () => {
    const malicious = '</script><script>alert(1)</script>';
    const js = liveSubscribeScript({
      topic: malicious,
      targetElementId: "feed",
    });

    // Raw closing-tag sequence MUST NOT appear anywhere in the output —
    // JSON.stringify escapes `<` when emitted for HTML, but we additionally
    // verify the literal bad sequence is absent.
    expect(js).not.toContain("</script>");
    // Unescaped alert call (in the exact bad form) must not appear.
    expect(js).not.toContain("<script>alert(1)");
    // The topic should still be represented (escaped) so the subscription
    // remains functional — at minimum the inner `alert(1)` literal is there
    // as an escaped JSON string, but the HTML-breakout is gone.
    expect(js).toContain("EventSource");
  });
});

describe("liveCommentBannerScript", () => {
  it("emits a self-invoking IIFE that opens an EventSource", () => {
    const js = liveCommentBannerScript({
      topic: "repo:r1:issue:7",
      bannerElementId: "live-comment-banner",
    });
    expect(typeof js).toBe("string");
    expect(js).toContain("EventSource");
    expect(js).toContain("/live-events/");
    expect(js).toContain('"repo:r1:issue:7"');
    expect(js).toContain('"live-comment-banner"');
    // Counter increment + show contract.
    expect(js).toContain("n++");
    expect(js).toContain("js-live-count");
    expect(js).toContain("js-live-link");
  });

  it("escapes topic strings to prevent </script> injection", () => {
    const malicious = '</script><script>alert(1)</script>';
    const js = liveCommentBannerScript({
      topic: malicious,
      bannerElementId: "banner",
    });
    expect(js).not.toContain("</script>");
    expect(js).not.toContain("<script>alert(1)");
    expect(js).toContain("EventSource");
  });

  it("uses the current location for the reload link", () => {
    const js = liveCommentBannerScript({
      topic: "repo:r1:pr:9",
      bannerElementId: "banner",
    });
    // Must reference window.location so a click reloads the same page.
    expect(js).toContain("window.location");
  });
});
