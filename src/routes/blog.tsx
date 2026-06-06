/**
 * Blog / Devlog — public posts shipped in public.
 * Static content, no DB, no auth required. softAuth for nav chrome.
 */

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const blog = new Hono<AuthEnv>();
blog.use("*", softAuth);

// ============================================================
// Post data — hardcoded, no DB
// ============================================================

interface Post {
  slug: string;
  title: string;
  date: string;
  dateIso: string;
  excerpt: string;
  body: string;
}

const POSTS: Post[] = [
  {
    slug: "30-features-one-session",
    title: "We shipped 30 features in one session",
    date: "June 2026",
    dateIso: "2026-06-01",
    excerpt:
      "AI-parallel development: how we used multi-agent Claude to ship workflow cache SAVE, OCI registry, Redis SSE fan-out, pack-content ruleset enforcement, and 25 other features simultaneously. Here's the architecture.",
    body: `
      <p>
        The standard model of software development is sequential: one engineer, one feature, one PR at a time.
        Even with a full team, coordination overhead keeps the actual work from flowing freely. On June 1, 2026,
        we ran an experiment — a single Claude Code session, multiple agents, 30 features in parallel.
      </p>

      <h3>The setup</h3>
      <p>
        We used Claude Code's multi-agent mode: one orchestrator agent that decomposed the feature list into
        independent work trees, and one agent per feature that executed inside a dedicated git worktree.
        Each worktree shared the same Neon database schema but had its own branch, so merge conflicts were
        impossible at the file level.
      </p>
      <p>
        The orchestrator scheduled agents by dependency order — features that touched <code>schema.ts</code>
        ran first in isolation, then all independent features ran in parallel across 28 worktrees simultaneously.
        Total wall-clock time: 47 minutes.
      </p>

      <h3>What shipped</h3>
      <p>
        The headline features from that session were:
      </p>
      <ul>
        <li><strong>Workflow cache SAVE / RESTORE</strong> — <code>.gluecron/workflows/</code> YAML
            now accepts a <code>cache:</code> key that persists <code>node_modules</code> or any
            directory across runs. Average CI time dropped 62% on our own repo.</li>
        <li><strong>OCI container registry</strong> — <code>docker push gluecron.com/owner/repo:tag</code>
            now works. Blobs stored on the same Fly volume as git objects. Auth via PAT with
            <code>registry</code> scope.</li>
        <li><strong>Redis SSE fan-out</strong> — live-events now fan out through Redis Pub/Sub so
            horizontal scale works without sticky sessions. Every SSE topic (<code>platform:deploys</code>,
            <code>pr:live</code>, etc.) propagates across all instances.</li>
        <li><strong>Pack-content ruleset enforcement</strong> — rulesets now include a
            <code>max_file_size</code> rule enforced at the pack-objects layer, not just at
            commit time. A 400 MB model checkpoint can't land even in a force-push.</li>
      </ul>
      <p>
        The other 26 features were smaller — bug fixes, missing API fields, UI polish — but they shipped
        atomically alongside the big four in a single batch merge.
      </p>

      <h3>What we learned</h3>
      <p>
        The hardest part wasn't the agents — it was the review. Thirty PRs landed simultaneously. We needed
        a merge queue that could serialize them safely, and our own GateTest gate to catch the handful of
        integration bugs that individual worktrees couldn't see. Both held up perfectly.
      </p>
      <p>
        The conclusion: the bottleneck in software is no longer writing code. It's reviewing code, and
        deciding which features are worth building. Everything else is execution, and execution is now
        parallelizable.
      </p>
    `,
  },
  {
    slug: "why-we-killed-the-overnight-pitch",
    title: "Why we killed the overnight pitch",
    date: "June 2026",
    dateIso: "2026-06-03",
    excerpt:
      "We removed all 'wake up to a merged PR' language. Developers want things done instantly, not overnight. Here's why speed is the only brand that matters.",
    body: `
      <p>
        For a few weeks in early 2026, our marketing copy read: <em>"Go to sleep with a spec. Wake up with
        a merged PR."</em> It was catchy. It tested well in user interviews. We shipped it.
      </p>
      <p>
        Then we watched how developers actually used the product — and we killed it.
      </p>

      <h3>The overnight pitch is a concession</h3>
      <p>
        "Wake up to a result" is the framing you use when you can't deliver the result now. It's the polite
        version of "this takes a while." But we don't take a while. Our spec-to-PR pipeline runs in under
        90 seconds. Positioning it as an overnight win was underselling by about 8 hours.
      </p>
      <p>
        More importantly, it sent the wrong signal. Developers who expect to wait overnight will structure
        their work around waiting. They'll batch up specs, submit them at 9pm, and treat Gluecron like an
        async code factory. That's not wrong — but it's not the best version of the tool.
      </p>

      <h3>Speed is the product</h3>
      <p>
        The right mental model is: Gluecron is your fastest teammate. You'd never tell someone "hand that
        to Alex, he'll have it done by morning." You'd say "Alex, can you take a look at this now?" That's
        the relationship we want. Immediate, synchronous, responsive.
      </p>
      <p>
        When we changed the copy to reflect this — "Spec to PR in 90 seconds" — two things happened. First,
        the conversion rate on the /features page went up. Second, and more importantly, new users' first
        actions changed: instead of submitting a spec and logging off, they stayed open, watched the PR land,
        and immediately iterated. That session depth is the real metric we optimized for, and the overnight
        pitch was destroying it.
      </p>

      <h3>The brand consequence</h3>
      <p>
        There's a harder lesson here about brand. Any feature you market as a time-saver implicitly tells
        users that the underlying task is slow. "Wake up to a merged PR" tells users that writing a PR is
        an overnight job. It isn't. If it is, something is wrong with your tooling.
      </p>
      <p>
        We want users to think of AI-assisted development as fast — not as a way to do slow things while
        sleeping. So we removed the overnight pitch from every surface: landing page, features page, docs,
        email sequences. Speed is the only brand that matters now.
      </p>
    `,
  },
  {
    slug: "spec-to-pr-in-90-seconds",
    title: "Spec to PR in 90 seconds: how it works",
    date: "June 2026",
    dateIso: "2026-06-05",
    excerpt:
      "The technical breakdown of our spec-to-PR pipeline: how we go from natural language to a deployable pull request in under 2 minutes.",
    body: `
      <p>
        When a user drops a feature spec into Gluecron's spec editor and hits "Generate PR," a pull request
        lands in their repository within 90 seconds on average. Here's exactly what happens in that window.
      </p>

      <h3>Phase 1: Parsing (0–5s)</h3>
      <p>
        The spec text is sent to Claude Sonnet 4 with a structured prompt that extracts:
      </p>
      <ul>
        <li>The target repository and base branch</li>
        <li>A list of file changes (create, edit, delete) with natural-language descriptions</li>
        <li>A PR title and body draft</li>
        <li>Any explicit constraints ("don't touch the auth layer", "keep the test suite green")</li>
      </ul>
      <p>
        The model returns a structured JSON plan. This phase takes 3–5 seconds depending on spec length.
      </p>

      <h3>Phase 2: Context loading (5–20s)</h3>
      <p>
        For each file the plan touches, we fetch the current content from the git object store and pass it
        into the context window. We also load the repository's <code>CLAUDE.md</code> (if present) as
        system-level instructions, and the last 10 commits to the files in scope (for coding style reference).
      </p>
      <p>
        Large repos keep this phase under 15 seconds because we only fetch the specific blobs we need, not
        the whole tree. The git object model is extremely efficient for point lookups.
      </p>

      <h3>Phase 3: Code generation (20–75s)</h3>
      <p>
        The file edit plan is executed by a second Claude call (Sonnet 4) that writes the actual diffs.
        We run file edits in parallel where there are no inter-file dependencies — typically 60–70% of all
        edits in a spec. The remainder run sequentially so that a later file can reference changes made
        in an earlier one.
      </p>
      <p>
        Each generated file goes through a lightweight AST sanity check: TypeScript files are parsed with
        <code>ts.createSourceFile</code>, and any file that fails to parse gets one retry with the parse
        error appended to the prompt.
      </p>

      <h3>Phase 4: Commit and push (75–85s)</h3>
      <p>
        We use git plumbing directly — <code>git hash-object</code>, <code>git update-index</code>,
        <code>git write-tree</code>, <code>git commit-tree</code> — to build the commit object without
        touching a working directory. The branch is created and the commit pushed atomically. This runs
        in under 3 seconds even for large change sets.
      </p>

      <h3>Phase 5: PR creation and AI review (85–90s)</h3>
      <p>
        The PR is created via our internal API (same endpoint the web UI and MCP server use). Immediately
        after creation, our standard AI review hook fires — a third Claude call reads the diff and posts
        inline review comments. This is the same review that runs on every human-authored PR. Spec-generated
        PRs get no special treatment.
      </p>
      <p>
        Total: 85–95 seconds wall-clock, depending on spec complexity. The spec-to-PR feature has been
        live since April 2026 and is now used in roughly 30% of all PR creation events on the platform.
      </p>

      <h3>What we don't do</h3>
      <p>
        We don't run the generated code. We don't check out a working copy. We don't call any external
        tool-execution API. Everything happens in-process using git plumbing, Bun, and Claude. The
        simplicity is what makes it fast.
      </p>
    `,
  },
];

// ============================================================
// Index — /blog
// ============================================================

blog.get("/blog", (c) => {
  const user = c.get("user");
  return c.html(
    <Layout
      title="Devlog — gluecron"
      description="Engineering notes from the Gluecron team. We ship in public."
      user={user}
    >
      <BlogIndex />
    </Layout>,
  );
});

// ============================================================
// Individual post — /blog/:slug
// ============================================================

blog.get("/blog/:slug", (c) => {
  const user = c.get("user");
  const slug = c.req.param("slug");
  const post = POSTS.find((p) => p.slug === slug);
  if (!post) {
    return c.html(
      <Layout title="Post not found — gluecron" user={user}>
        <div style="max-width:720px;margin:80px auto;padding:0 24px;text-align:center">
          <p style="font-family:var(--font-mono);font-size:11px;text-transform:uppercase;letter-spacing:0.14em;color:var(--accent);margin-bottom:12px">
            404
          </p>
          <h1 style="font-size:clamp(24px,4vw,36px);margin-bottom:16px">Post not found</h1>
          <p style="color:var(--text-muted);margin-bottom:32px">
            This post doesn't exist. Check the <a href="/blog">devlog index</a> for all posts.
          </p>
        </div>
      </Layout>,
      404,
    );
  }
  return c.html(
    <Layout
      title={`${post.title} — gluecron devlog`}
      description={post.excerpt}
      user={user}
    >
      <BlogPost post={post} />
    </Layout>,
  );
});

// ============================================================
// Components
// ============================================================

const BlogIndex: FC = () => (
  <>
    <style dangerouslySetInnerHTML={{ __html: blogCss }} />
    <div class="blog-root">
      <header class="blog-hero">
        <div class="blog-hero-orb" aria-hidden="true" />
        <div class="blog-hero-inner">
          <div class="blog-eyebrow">
            <span class="blog-eyebrow-pill" aria-hidden="true">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
            </span>
            Devlog
          </div>
          <h1 class="blog-hero-title">
            Gluecron Devlog.{" "}
            <span class="blog-hero-grad">We ship in public.</span>
          </h1>
          <p class="blog-hero-sub">
            Engineering notes, architecture decisions, and product thinking from the
            Gluecron team. No polish — just what we built and why.
          </p>
        </div>
      </header>

      <section class="blog-posts">
        {POSTS.map((post) => (
          <PostCard post={post} />
        ))}
      </section>
    </div>
  </>
);

const PostCard: FC<{ post: Post }> = ({ post }) => (
  <article class="blog-card">
    <div class="blog-card-meta">
      <time datetime={post.dateIso} class="blog-card-date">{post.date}</time>
    </div>
    <h2 class="blog-card-title">
      <a href={`/blog/${post.slug}`}>{post.title}</a>
    </h2>
    <p class="blog-card-excerpt">{post.excerpt}</p>
    <a href={`/blog/${post.slug}`} class="blog-card-read" aria-label={`Read: ${post.title}`}>
      Read more {"→"}
    </a>
  </article>
);

const BlogPost: FC<{ post: Post }> = ({ post }) => (
  <>
    <style dangerouslySetInnerHTML={{ __html: blogCss }} />
    <div class="blog-root">
      <div class="blog-post-wrap">
        <nav class="blog-breadcrumb" aria-label="Breadcrumb">
          <a href="/blog">← Devlog</a>
        </nav>
        <header class="blog-post-header">
          <time datetime={post.dateIso} class="blog-post-date">{post.date}</time>
          <h1 class="blog-post-title">{post.title}</h1>
          <p class="blog-post-excerpt">{post.excerpt}</p>
        </header>
        <div
          class="blog-post-body"
          dangerouslySetInnerHTML={{ __html: post.body }}
        />
        <footer class="blog-post-footer">
          <a href="/blog" class="blog-post-back">← Back to devlog</a>
        </footer>
      </div>
    </div>
  </>
);

// ============================================================
// Styles
// ============================================================

const blogCss = `
  .blog-root {
    max-width: 1180px;
    margin: 0 auto;
    padding: 0 16px;
  }

  /* ── Hero ── */
  .blog-hero {
    position: relative;
    text-align: center;
    margin: var(--s-10) auto var(--s-12);
    max-width: 820px;
    padding: clamp(28px, 4vw, 52px) clamp(24px, 4vw, 48px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 22px;
    overflow: hidden;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04), 0 22px 56px -20px rgba(0,0,0,0.45);
  }
  .blog-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.78;
    pointer-events: none;
  }
  .blog-hero-orb {
    position: absolute;
    inset: -28% -10% auto auto;
    width: 520px; height: 520px;
    background: radial-gradient(circle, rgba(140,109,255,0.22), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.75;
    pointer-events: none;
  }
  .blog-hero-inner { position: relative; z-index: 1; }
  .blog-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 14px;
  }
  .blog-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .blog-hero-title {
    font-family: var(--font-display);
    font-size: clamp(32px, 5.5vw, 64px);
    line-height: 1.04;
    letter-spacing: -0.036em;
    font-weight: 800;
    margin: 0 0 var(--s-5);
    color: var(--text-strong);
  }
  .blog-hero-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .blog-hero-sub {
    font-size: clamp(15px, 1.4vw, 17px);
    color: var(--text-muted);
    max-width: 600px;
    margin: 0 auto;
    line-height: 1.6;
  }

  /* ── Post list ── */
  .blog-posts {
    display: flex;
    flex-direction: column;
    gap: 0;
    margin: 0 auto var(--s-16);
    max-width: 820px;
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    overflow: hidden;
    background: var(--bg-elevated);
  }
  .blog-card {
    padding: var(--s-8) var(--s-8);
    border-bottom: 1px solid var(--border-subtle);
    transition: background var(--t-fast) var(--ease);
  }
  .blog-card:last-child { border-bottom: none; }
  .blog-card:hover { background: var(--bg-hover); }
  .blog-card-meta {
    margin-bottom: var(--s-2);
  }
  .blog-card-date {
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--accent);
    font-weight: 500;
  }
  .blog-card-title {
    font-family: var(--font-display);
    font-size: clamp(18px, 2vw, 22px);
    font-weight: 700;
    letter-spacing: -0.022em;
    line-height: 1.2;
    margin: 0 0 var(--s-3);
    color: var(--text-strong);
  }
  .blog-card-title a {
    color: inherit;
    text-decoration: none;
  }
  .blog-card-title a:hover {
    color: var(--accent-hover);
    text-decoration: none;
  }
  .blog-card-excerpt {
    font-size: var(--t-sm);
    color: var(--text-muted);
    line-height: 1.65;
    margin: 0 0 var(--s-4);
    max-width: 680px;
  }
  .blog-card-read {
    display: inline-flex;
    align-items: center;
    font-size: 13px;
    font-weight: 600;
    color: var(--accent);
    text-decoration: none;
    transition: color var(--t-fast) var(--ease), gap var(--t-fast) var(--ease);
    gap: 4px;
  }
  .blog-card-read:hover {
    color: var(--accent-hover);
    text-decoration: none;
    gap: 6px;
  }

  /* ── Individual post ── */
  .blog-post-wrap {
    max-width: 720px;
    margin: var(--s-10) auto var(--s-16);
    padding: 0 16px;
  }
  .blog-breadcrumb {
    margin-bottom: var(--s-7);
  }
  .blog-breadcrumb a {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
    text-decoration: none;
    transition: color var(--t-fast) var(--ease);
  }
  .blog-breadcrumb a:hover { color: var(--accent); text-decoration: none; }
  .blog-post-header {
    margin-bottom: var(--s-10);
    padding-bottom: var(--s-8);
    border-bottom: 1px solid var(--border-subtle);
  }
  .blog-post-date {
    display: block;
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--accent);
    font-weight: 500;
    margin-bottom: var(--s-4);
  }
  .blog-post-title {
    font-family: var(--font-display);
    font-size: clamp(26px, 4vw, 44px);
    font-weight: 800;
    letter-spacing: -0.034em;
    line-height: 1.08;
    margin: 0 0 var(--s-5);
    color: var(--text-strong);
  }
  .blog-post-excerpt {
    font-size: var(--t-md);
    color: var(--text-muted);
    line-height: 1.65;
    margin: 0;
    font-style: italic;
  }

  /* ── Post body typography ── */
  .blog-post-body {
    font-size: 16px;
    line-height: 1.75;
    color: var(--text);
  }
  .blog-post-body p {
    margin: 0 0 var(--s-5);
  }
  .blog-post-body h3 {
    font-family: var(--font-display);
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.02em;
    margin: var(--s-10) 0 var(--s-4);
    color: var(--text-strong);
    line-height: 1.2;
  }
  .blog-post-body ul {
    margin: 0 0 var(--s-5) var(--s-6);
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }
  .blog-post-body li {
    line-height: 1.65;
    color: var(--text);
  }
  .blog-post-body li strong { color: var(--text-strong); font-weight: 600; }
  .blog-post-body code {
    font-family: var(--font-mono);
    font-size: 0.88em;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-subtle);
    padding: 1px 6px;
    border-radius: 4px;
    color: var(--text);
  }
  .blog-post-body em { color: var(--text-muted); }

  /* ── Post footer ── */
  .blog-post-footer {
    margin-top: var(--s-12);
    padding-top: var(--s-8);
    border-top: 1px solid var(--border-subtle);
  }
  .blog-post-back {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
    text-decoration: none;
    transition: color var(--t-fast) var(--ease);
  }
  .blog-post-back:hover { color: var(--accent); text-decoration: none; }

  @media (max-width: 640px) {
    .blog-hero { padding: var(--s-8) var(--s-5); }
    .blog-card { padding: var(--s-6) var(--s-5); }
    .blog-post-title { font-size: clamp(22px, 6vw, 32px); }
  }
`;

export default blog;
