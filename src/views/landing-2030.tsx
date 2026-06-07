/**
 * Landing2030 — the public marketing landing page.
 *
 * A fully self-contained light HTML document (its own <head>, fonts, and CSS)
 * rendered directly from the root route, bypassing the dark app Layout so the
 * marketing surface can be a pristine, Linear/Vercel-grade design without
 * fighting the application chrome. Theme: white, editorial, "site of the
 * future" (2030). Entrance motion is CSS-only and degrades to fully-visible
 * content when JS or animation is unavailable.
 */
import type { FC } from "hono/jsx";

export interface Landing2030Props {
  // Reserved for future use. The stat band intentionally shows
  // capability metrics rather than live counts so the page reads strong
  // at any scale.
  stats?: { publicRepos?: number; users?: number };
}

/* ---- small stroke icons (inherit currentColor) ---------------------- */
const IconReview: FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 3l2.2 4.6L19 8.3l-3.4 3.4.8 4.8L12 14.2 7.6 16.5l.8-4.8L5 8.3l4.8-.7z" />
  </svg>
);
const IconMerge: FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="6" cy="6" r="2.4" /><circle cx="6" cy="18" r="2.4" />
    <circle cx="18" cy="9" r="2.4" /><path d="M6 8.4v7.2M8.3 7.2C13 7.6 15.6 9 15.6 9" />
  </svg>
);
const IconGate: FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 3l7 3v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z" /><path d="M9 12l2 2 4-4" />
  </svg>
);
const IconGit: FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="6" cy="6" r="2.4" /><circle cx="6" cy="18" r="2.4" />
    <circle cx="18" cy="14" r="2.4" /><path d="M6 8.4v7.2M6 14a8 8 0 008-8h1.8" />
  </svg>
);
const IconCI: FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 3a9 9 0 109 9" /><path d="M12 7v5l3 2" /><path d="M21 3v4h-4" />
  </svg>
);
const IconIntel: FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 3a4 4 0 014 4c1.6.6 2.6 2 2.6 3.8 0 1-.4 2-1 2.7.3.5.4 1.1.4 1.7A3.8 3.8 0 0112 19a3.8 3.8 0 01-6-3.8c0-.6.1-1.2.4-1.7-.6-.7-1-1.7-1-2.7C5.4 9 6.4 7.6 8 7a4 4 0 014-4z" />
    <path d="M12 3v16" />
  </svg>
);

const FEATURES: { icon: FC; title: string; body: string }[] = [
  { icon: IconReview, title: "Claude code review",
    body: "Every pull request gets a senior-level review the moment it opens — line-level comments, risk flags, and a verdict, in seconds." },
  { icon: IconMerge, title: "Auto-merge the instant gates pass",
    body: "Gates green and review clean? Gluecron merges autonomously. Label an issue, get a shipped PR — no waiting." },
  { icon: IconGate, title: "Push-time gate enforcement",
    body: "Security and quality gates run at the moment of push — not minutes later in CI. Bad code never reaches your branch." },
  { icon: IconGit, title: "Git-native hosting",
    body: "Full Smart-HTTP git over the wire. Clone, push, fork, and browse — everything you expect from a host, self-owned." },
  { icon: IconCI, title: "CI that comes built-in",
    body: "No YAML archaeology. Checks, deploys, and post-receive automation are part of the platform, wired from first push." },
  { icon: IconIntel, title: "Semantic code intelligence",
    body: "A vector-indexed understanding of your whole repo powers search, review, and the agents that act on your behalf." },
];

const STEPS: { n: string; title: string; body: string }[] = [
  { n: "01", title: "Label an issue", body: "Drop a label on an issue — or just describe what you want. That's the whole input." },
  { n: "02", title: "Agents go to work", body: "Claude opens a branch, writes the change, and submits a pull request against your gates." },
  { n: "03", title: "Reviewed & gated", body: "The PR is reviewed line-by-line and run through push-time security and quality gates." },
  { n: "04", title: "Merged, autonomously", body: "Green across the board? It merges itself and deploys. Shipped while you were still in the same coding session." },
];

export const Landing2030Page: FC<Landing2030Props> = () => {
  const title = "Gluecron — The AI-native git host";
  const desc =
    "The AI-native git host. Spec to PR in 90 seconds. Auto-merge the instant gates pass. Ship faster than any team on GitHub.";
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="theme-color" content="#ffffff" />
        <title>{title}</title>
        <meta name="description" content={desc} />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={desc} />
        <meta property="og:type" content="website" />
        <meta name="twitter:card" content="summary_large_image" />
        <link rel="icon" type="image/svg+xml" href="/icon.svg" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Inter+Tight:wght@500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap"
        />
        <style dangerouslySetInnerHTML={{ __html: landing2030Css }} />
      </head>
      <body>
        {/* ---- nav ---- */}
        <header class="nv" id="nv">
          <div class="nv-in">
            <a href="/" class="nv-logo">
              <span class="nv-mark" aria-hidden="true" />
              gluecron
            </a>
            <nav class="nv-links" aria-label="Primary">
              <a href="#features">Product</a>
              <a href="#loop">How it works</a>
              <a href="/pricing">Pricing</a>
              <a href="/explore">Explore</a>
            </nav>
            <div class="nv-cta">
              <a href="/login" class="btn btn-ghost">Sign in</a>
              <a href="/register" class="btn btn-solid">Start building</a>
            </div>
          </div>
        </header>

        {/* ---- hero ---- */}
        <section class="hero">
          <div class="hero-glow" aria-hidden="true" />
          <div class="wrap hero-in">
            <a href="#loop" class="eyebrow rise" style="--d:0ms">
              <span class="eyebrow-dot" /> The AI-native git host · built for 2030
            </a>
            <h1 class="display rise" style="--d:60ms">
              The git host built for <span class="grad">2030</span>.
            </h1>
            <p class="lede rise" style="--d:120ms">
              Gluecron hosts your code, reviews every pull request with Claude,
              enforces gates at push time, and merges clean work the instant
              gates pass. Spec to PR in 90 seconds — ship faster than any team
              on GitHub.
            </p>
            <div class="hero-actions rise" style="--d:180ms">
              <a href="/register" class="btn btn-solid btn-lg">Start building →</a>
              <a href="#loop" class="btn btn-ghost btn-lg">See how it works</a>
            </div>
            <div class="hero-trust rise" style="--d:240ms">
              Self-hosted · Git-native · Claude-first
            </div>

            {/* product card mock */}
            <div class="hero-card rise" style="--d:320ms" aria-hidden="true">
              <div class="hc-bar">
                <span class="hc-dot" /><span class="hc-dot" /><span class="hc-dot" />
                <span class="hc-path">gluecron.com / your-org / api · #128</span>
              </div>
              <div class="hc-body">
                <div class="hc-pr">
                  <span class="hc-badge hc-merged">✓ Merged</span>
                  <span class="hc-prtitle">Fix race condition in token refresh</span>
                </div>
                <div class="hc-review">
                  <span class="hc-ava">C</span>
                  <div class="hc-rev-body">
                    <div class="hc-rev-head">Claude review · <em>approved</em></div>
                    <div class="hc-rev-text">
                      Mutex now guards the refresh path; the double-fetch under
                      contention is resolved. Gates green. Auto-merging.
                    </div>
                  </div>
                </div>
                <div class="hc-checks">
                  <span class="hc-check ok">● gate: security</span>
                  <span class="hc-check ok">● gate: tests</span>
                  <span class="hc-check ok">● review: Claude</span>
                  <span class="hc-check ok">● deploy: live</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ---- stat band ---- */}
        <section class="stats">
          <div class="wrap stats-in">
            <div class="stat"><div class="stat-n">&lt; 30s</div><div class="stat-l">to first AI review</div></div>
            <div class="stat"><div class="stat-n">24/7</div><div class="stat-l">autonomous merges</div></div>
            <div class="stat"><div class="stat-n">100%</div><div class="stat-l">push-time gate coverage</div></div>
            <div class="stat"><div class="stat-n">Self-owned</div><div class="stat-l">your code, your server</div></div>
          </div>
        </section>

        {/* ---- features ---- */}
        <section class="sec" id="features">
          <div class="wrap">
            <div class="sec-head">
              <span class="kicker">The platform</span>
              <h2 class="h2">Everything GitHub does. Then everything it doesn't.</h2>
              <p class="sub">A complete git host with code intelligence wired into every step — review, gates, CI, and autonomous merge, native to the platform.</p>
            </div>
            <div class="grid">
              {FEATURES.map((f) => {
                const Ic = f.icon;
                return (
                  <div class="card">
                    <div class="card-ic"><Ic /></div>
                    <h3 class="card-t">{f.title}</h3>
                    <p class="card-b">{f.body}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* ---- the loop ---- */}
        <section class="sec sec-alt" id="loop">
          <div class="wrap">
            <div class="sec-head">
              <span class="kicker">The closed loop</span>
              <h2 class="h2">From a label to a shipped PR — untouched by you.</h2>
              <p class="sub">Gluecron closes the loop between intent and production. You set direction; the platform does the round-trip.</p>
            </div>
            <div class="loop">
              {STEPS.map((s, i) => (
                <div class="step">
                  <div class="step-n">{s.n}</div>
                  <h3 class="step-t">{s.title}</h3>
                  <p class="step-b">{s.body}</p>
                  {i < STEPS.length - 1 && <span class="step-arrow" aria-hidden="true">→</span>}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ---- 2030 vision band ---- */}
        <section class="vision">
          <div class="vision-grid" aria-hidden="true" />
          <div class="wrap vision-in">
            <span class="kicker kicker-light">2030</span>
            <h2 class="vh">By 2030, code reviews itself,<br />gates itself, and ships itself.</h2>
            <p class="vsub">
              The era of babysitting pipelines is ending. Gluecron is built for the
              world that's coming — where engineers set intent and an autonomous
              platform carries it to production, safely, around the clock. We didn't
              bolt AI onto a git host. We rebuilt the git host around it.
            </p>
            <div class="vstats">
              <div class="vstat"><b>Autonomous</b><span>review → gate → merge → deploy</span></div>
              <div class="vstat"><b>Always on</b><span>your repo never sleeps</span></div>
              <div class="vstat"><b>Self-owned</b><span>your code, your server, your keys</span></div>
            </div>
          </div>
        </section>

        {/* ---- differentiator ---- */}
        <section class="sec">
          <div class="wrap quote-wrap">
            <p class="quote">
              “GitHub gives you a place to <em>store</em> code.
              Gluecron gives you a place where code <em>moves on its own.</em>”
            </p>
          </div>
        </section>

        {/* ---- final CTA ---- */}
        <section class="cta">
          <div class="wrap cta-in">
            <h2 class="cta-h">Start building on the future of git.</h2>
            <p class="cta-sub">Spin up a repository, push a commit, and watch the loop close.</p>
            <div class="hero-actions">
              <a href="/register" class="btn btn-solid btn-lg">Create your account →</a>
              <a href="/explore" class="btn btn-ghost btn-lg">Explore public repos</a>
            </div>
          </div>
        </section>

        {/* ---- footer ---- */}
        <footer class="ft">
          <div class="wrap ft-in">
            <div class="ft-brand">
              <a href="/" class="nv-logo"><span class="nv-mark" aria-hidden="true" />gluecron</a>
              <p class="ft-tag">The AI-native git host. Built for 2030.</p>
            </div>
            <div class="ft-cols">
              <div class="ft-col">
                <h4>Product</h4>
                <a href="#features">Features</a>
                <a href="/pricing">Pricing</a>
                <a href="/explore">Explore</a>
              </div>
              <div class="ft-col">
                <h4>Company</h4>
                <a href="/about">About</a>
                <a href="/login">Sign in</a>
                <a href="/register">Start building</a>
              </div>
              <div class="ft-col">
                <h4>Account</h4>
                <a href="/login">Log in</a>
                <a href="/register">Register</a>
                <a href="/settings">Settings</a>
              </div>
            </div>
          </div>
          <div class="wrap ft-bottom">
            <span>© {new Date().getFullYear()} Gluecron</span>
            <span>Self-hosted · Git-native · Claude-first</span>
          </div>
        </footer>

        <script dangerouslySetInnerHTML={{ __html: landing2030Js }} />
      </body>
    </html>
  );
};

export default Landing2030Page;

const landing2030Js = `
(function(){
  var nv = document.getElementById('nv');
  function onScroll(){ if(!nv) return; nv.classList.toggle('nv-stuck', window.scrollY > 8); }
  window.addEventListener('scroll', onScroll, {passive:true}); onScroll();
  // additive scroll-reveal: base state is already visible, this only enhances
  if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches){
    var io = new IntersectionObserver(function(es){
      es.forEach(function(e){ if(e.isIntersecting){ e.target.classList.add('seen'); io.unobserve(e.target); } });
    }, {threshold:0.12});
    document.querySelectorAll('.card,.step,.stat,.vstat').forEach(function(el){ el.classList.add('reveal'); io.observe(el); });
  }
})();
`;

const landing2030Css = `
:root{
  --bg:#ffffff; --bg-soft:#fafafb; --ink:#0a0b0d; --ink-2:#3a3d45;
  --muted:#676d78; --line:rgba(13,16,23,.08); --line-2:rgba(13,16,23,.12);
  --brand:#5b5bf6; --brand-2:#7c4dff; --brand-3:#2f6bff;
  --grad:linear-gradient(100deg,#7c4dff 0%,#5b5bf6 45%,#2f6bff 100%);
  --radius:16px; --shadow:0 1px 2px rgba(13,16,23,.04),0 12px 32px rgba(13,16,23,.06);
  --maxw:1140px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);
  font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  font-size:17px;line-height:1.6;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:inherit;text-decoration:none}
.wrap{max-width:var(--maxw);margin:0 auto;padding:0 24px}
.display,.h2,.vh,.cta-h{font-family:'Inter Tight','Inter',sans-serif;letter-spacing:-.02em;font-weight:700}
.grad{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}

/* nav */
.nv{position:sticky;top:0;z-index:50;backdrop-filter:saturate(180%) blur(12px);
  background:rgba(255,255,255,.72);border-bottom:1px solid transparent;transition:border-color .2s,box-shadow .2s,background .2s}
.nv-stuck{border-bottom-color:var(--line);box-shadow:0 1px 0 rgba(13,16,23,.02)}
.nv-in{max-width:var(--maxw);margin:0 auto;padding:14px 24px;display:flex;align-items:center;gap:24px}
.nv-logo{display:inline-flex;align-items:center;gap:9px;font-family:'Inter Tight',sans-serif;font-weight:700;font-size:19px;letter-spacing:-.02em}
.nv-mark{width:18px;height:18px;border-radius:6px;background:var(--grad);box-shadow:0 2px 8px rgba(92,91,246,.4);display:inline-block}
.nv-links{display:flex;gap:26px;margin-left:14px}
.nv-links a{color:var(--ink-2);font-size:15px;font-weight:500;transition:color .15s}
.nv-links a:hover{color:var(--ink)}
.nv-cta{margin-left:auto;display:flex;align-items:center;gap:10px}
.btn{display:inline-flex;align-items:center;gap:6px;border-radius:10px;font-weight:600;font-size:15px;
  padding:9px 16px;cursor:pointer;transition:transform .12s,box-shadow .2s,background .2s,border-color .2s;border:1px solid transparent;white-space:nowrap}
.btn:hover{transform:translateY(-1px)}
.btn-solid{background:var(--ink);color:#fff}
.btn-solid:hover{box-shadow:0 8px 22px rgba(13,16,23,.18)}
.btn-ghost{color:var(--ink);border-color:var(--line-2);background:rgba(255,255,255,.6)}
.btn-ghost:hover{border-color:var(--ink);background:#fff}
.btn-lg{padding:13px 22px;font-size:16px;border-radius:12px}

/* hero */
.hero{position:relative;overflow:hidden;padding:84px 0 40px;text-align:center}
.hero-glow{position:absolute;inset:-20% 0 auto 0;height:620px;z-index:0;pointer-events:none;
  background:radial-gradient(60% 60% at 50% 0%,rgba(124,77,255,.18),transparent 70%),
             radial-gradient(40% 50% at 75% 10%,rgba(47,107,255,.14),transparent 70%),
             radial-gradient(40% 50% at 25% 10%,rgba(91,91,246,.12),transparent 70%)}
.hero-in{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center}
.eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:13.5px;font-weight:600;color:var(--ink-2);
  background:#fff;border:1px solid var(--line-2);border-radius:999px;padding:7px 14px;box-shadow:var(--shadow)}
.eyebrow-dot{width:7px;height:7px;border-radius:50%;background:var(--grad)}
.display{font-size:clamp(40px,7vw,76px);line-height:1.02;margin:26px 0 0;max-width:14ch}
.lede{font-size:clamp(17px,2.2vw,21px);color:var(--muted);max-width:60ch;margin:22px auto 0;font-weight:450}
.hero-actions{display:flex;gap:12px;flex-wrap:wrap;justify-content:center;margin-top:30px}
.hero-trust{margin-top:18px;font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}

/* hero card */
.hero-card{margin:54px auto 0;max-width:760px;width:100%;text-align:left;background:#fff;
  border:1px solid var(--line);border-radius:18px;box-shadow:0 30px 70px -30px rgba(13,16,23,.28),var(--shadow);overflow:hidden}
.hc-bar{display:flex;align-items:center;gap:7px;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--bg-soft)}
.hc-dot{width:11px;height:11px;border-radius:50%;background:#dfe1e6}
.hc-path{margin-left:10px;font-family:'JetBrains Mono',monospace;font-size:12.5px;color:var(--muted)}
.hc-body{padding:20px}
.hc-pr{display:flex;align-items:center;gap:12px}
.hc-badge{font-size:12.5px;font-weight:700;padding:4px 10px;border-radius:999px}
.hc-merged{background:rgba(91,91,246,.1);color:#5b5bf6}
.hc-prtitle{font-weight:600;font-size:15.5px}
.hc-review{display:flex;gap:12px;margin-top:18px;padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--bg-soft)}
.hc-ava{flex:none;width:30px;height:30px;border-radius:8px;background:var(--grad);color:#fff;font-weight:700;
  display:grid;place-items:center;font-size:14px}
.hc-rev-head{font-size:13.5px;font-weight:600;color:var(--ink-2)}
.hc-rev-head em{color:#5b5bf6;font-style:normal}
.hc-rev-text{font-size:14px;color:var(--muted);margin-top:3px}
.hc-checks{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.hc-check{font-family:'JetBrains Mono',monospace;font-size:12px;padding:5px 10px;border-radius:8px;border:1px solid var(--line);color:var(--ink-2)}
.hc-check.ok{color:#2c8a52}.hc-check.ok::first-letter{color:#2c8a52}

/* stats */
.stats{border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:var(--bg-soft)}
.stats-in{display:grid;grid-template-columns:repeat(4,1fr);gap:24px;padding:40px 24px}
.stat{text-align:center}
.stat-n{font-family:'Inter Tight',sans-serif;font-weight:800;font-size:clamp(28px,4vw,40px);letter-spacing:-.02em}
.stat-l{font-size:13.5px;color:var(--muted);margin-top:4px}

/* sections */
.sec{padding:92px 0}
.sec-alt{background:var(--bg-soft);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.sec-head{max-width:680px;margin:0 auto 52px;text-align:center}
.kicker{display:inline-block;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;
  color:#5b5bf6;margin-bottom:14px}
.h2{font-size:clamp(28px,4.4vw,46px);line-height:1.08;margin:0}
.sub{color:var(--muted);font-size:18px;margin:16px auto 0;max-width:56ch}

/* feature grid */
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.card{background:#fff;border:1px solid var(--line);border-radius:var(--radius);padding:26px;transition:transform .18s,box-shadow .25s,border-color .2s}
.card:hover{transform:translateY(-3px);box-shadow:var(--shadow);border-color:var(--line-2)}
.card-ic{width:42px;height:42px;border-radius:11px;display:grid;place-items:center;color:#5b5bf6;
  background:rgba(91,91,246,.09);border:1px solid rgba(91,91,246,.14);margin-bottom:16px}
.card-ic svg{width:22px;height:22px}
.card-t{font-size:18px;font-weight:600;margin:0 0 7px;font-family:'Inter Tight',sans-serif;letter-spacing:-.01em}
.card-b{color:var(--muted);font-size:15px;margin:0;line-height:1.6}

/* loop */
.loop{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}
.step{position:relative;background:#fff;border:1px solid var(--line);border-radius:var(--radius);padding:24px}
.step-n{font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:600;color:#5b5bf6;margin-bottom:12px}
.step-t{font-size:17px;font-weight:600;margin:0 0 6px;font-family:'Inter Tight',sans-serif}
.step-b{color:var(--muted);font-size:14.5px;margin:0}
.step-arrow{position:absolute;right:-13px;top:50%;transform:translateY(-50%);color:var(--line-2);font-size:20px;z-index:2}

/* vision band */
.vision{position:relative;overflow:hidden;padding:104px 0;color:#fff;text-align:center;
  background:radial-gradient(120% 120% at 50% -10%,#2a2350 0%,#15122b 45%,#0a0913 100%)}
.vision-grid{position:absolute;inset:0;opacity:.5;
  background-image:linear-gradient(rgba(255,255,255,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.06) 1px,transparent 1px);
  background-size:54px 54px;mask-image:radial-gradient(80% 80% at 50% 0%,#000,transparent 75%)}
.vision-in{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center}
.kicker-light{color:#b7a8ff}
.vh{font-size:clamp(30px,5vw,54px);line-height:1.08;margin:0;letter-spacing:-.02em}
.vsub{color:rgba(255,255,255,.74);font-size:18px;max-width:62ch;margin:22px auto 0}
.vstats{display:flex;gap:40px;flex-wrap:wrap;justify-content:center;margin-top:42px}
.vstat{display:flex;flex-direction:column;gap:3px}
.vstat b{font-family:'Inter Tight',sans-serif;font-size:19px}
.vstat span{color:rgba(255,255,255,.6);font-size:13.5px}

/* quote */
.quote-wrap{max-width:1200px;margin:0 auto;text-align:center}
.quote{font-family:'Inter Tight',sans-serif;font-weight:600;font-size:clamp(24px,3.6vw,38px);
  line-height:1.25;letter-spacing:-.02em;margin:0}
.quote em{font-style:normal;background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}

/* cta */
.cta{padding:96px 0}
.cta-in{max-width:720px;margin:0 auto;text-align:center;background:#fff;border:1px solid var(--line);
  border-radius:24px;padding:56px 32px;box-shadow:var(--shadow);position:relative;overflow:hidden}
.cta-in::before{content:"";position:absolute;inset:-40% 0 auto 0;height:260px;
  background:radial-gradient(50% 60% at 50% 0%,rgba(124,77,255,.16),transparent 70%);pointer-events:none}
.cta-h{font-size:clamp(28px,4.4vw,44px);margin:0;position:relative}
.cta-sub{color:var(--muted);font-size:18px;margin:14px 0 28px;position:relative}
.cta .hero-actions{position:relative}

/* footer */
.ft{border-top:1px solid var(--line);background:var(--bg-soft);padding:56px 0 28px}
.ft-in{display:flex;gap:40px;flex-wrap:wrap;justify-content:space-between}
.ft-tag{color:var(--muted);font-size:14px;margin:12px 0 0;max-width:30ch}
.ft-cols{display:flex;gap:64px;flex-wrap:wrap}
.ft-col{display:flex;flex-direction:column;gap:10px}
.ft-col h4{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 4px;font-weight:700}
.ft-col a{color:var(--ink-2);font-size:14.5px;transition:color .15s}
.ft-col a:hover{color:var(--ink)}
.ft-bottom{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;
  margin-top:40px;padding-top:22px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}

/* entrance + reveal */
@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
.rise{animation:rise .7s cubic-bezier(.22,.61,.36,1) backwards;animation-delay:var(--d,0ms)}
.reveal{opacity:0;transform:translateY(16px);transition:opacity .6s ease,transform .6s cubic-bezier(.22,.61,.36,1)}
.reveal.seen{opacity:1;transform:none}

/* responsive */
@media(max-width:900px){
  .grid,.loop{grid-template-columns:repeat(2,1fr)}
  .stats-in{grid-template-columns:repeat(2,1fr);gap:28px 16px}
  .step-arrow{display:none}
  .nv-links{display:none}
}
@media(max-width:560px){
  .grid,.loop{grid-template-columns:1fr}
  .hero{padding:56px 0 24px}
  .ft-cols{gap:36px}
}
@media(prefers-reduced-motion:reduce){
  .rise,.reveal{animation:none!important;opacity:1!important;transform:none!important}
  html{scroll-behavior:auto}
}
`;
