/**
 * Voice-to-PR — phone-first feature dictation.
 *
 *   GET  /voice            → polished hero + tap-to-talk + repo picker
 *   POST /voice/transcribe → JSON, runs interpretVoiceTranscript
 *   POST /voice/ship       → ships a `.gluecron/specs/voice-*.md` ready spec
 *   POST /voice/issue      → opens an issue via the existing flow
 *
 * Hard rules (per the build prompt):
 *   - No shared layout / component changes (one nav link is added in
 *     `layout.tsx`, separately).
 *   - Inline JS lives here, in a single `<script>` tag.
 *   - Every CSS class is prefixed `.voice-*`.
 *   - Web Speech API is feature-detected — if unsupported the UI falls
 *     back to a plain textarea so the demo still works in Firefox / dev.
 *   - Skips gracefully when ANTHROPIC_API_KEY is unset (Claude call
 *     returns a heuristic interpretation instead of a structured one).
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { requireAuth, softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { isAiAvailable } from "../lib/ai-client";
import {
  interpretVoiceTranscript,
  shipAsSpec,
  createIssueFromVoice,
  listUserRepos,
} from "../lib/voice-to-pr";
import { triggerIssueTriage } from "../lib/issue-triage";

const voice = new Hono<AuthEnv>();
voice.use("*", softAuth);

// ---------------------------------------------------------------------------
// CSS — every class prefixed `.voice-*` so it can't leak.
// ---------------------------------------------------------------------------
const voiceCss = `
  .voice-page {
    max-width: 720px;
    margin: 0 auto;
    padding: clamp(20px, 4vw, 40px) clamp(14px, 4vw, 24px) clamp(40px, 8vw, 96px);
  }

  /* Hero — gradient hairline + orb + eyebrow + display headline */
  .voice-hero {
    position: relative;
    padding: clamp(28px, 5vw, 44px) clamp(20px, 4vw, 36px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 20px;
    overflow: hidden;
    margin-bottom: clamp(20px, 4vw, 32px);
    box-shadow: 0 1px 0 rgba(255,255,255,0.04), 0 18px 44px -16px rgba(0,0,0,0.42);
  }
  .voice-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.85;
    pointer-events: none;
    z-index: 2;
  }
  .voice-hero-orb {
    position: absolute;
    inset: -40% -20% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(140,109,255,0.26), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.75;
    pointer-events: none;
    z-index: 0;
  }
  .voice-hero-inner { position: relative; z-index: 1; }
  .voice-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 14px;
  }
  .voice-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.16);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .voice-eyebrow-warn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border-radius: 9999px;
    background: rgba(251,191,36,0.10);
    color: #fde68a;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.30);
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.10em;
    margin-left: 6px;
  }
  .voice-title {
    font-family: var(--font-display);
    font-size: clamp(34px, 9vw, 64px);
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 0.98;
    margin: 0 0 12px;
    color: var(--text-strong);
  }
  .voice-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .voice-sub {
    font-size: clamp(14px, 3.5vw, 16px);
    color: var(--text-muted);
    line-height: 1.55;
    margin: 0;
    max-width: 520px;
  }

  /* Tap-to-talk orb */
  .voice-mic-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    margin: clamp(28px, 6vw, 48px) 0;
  }
  .voice-mic {
    appearance: none;
    border: 0;
    cursor: pointer;
    width: clamp(132px, 38vw, 168px);
    height: clamp(132px, 38vw, 168px);
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-shadow:
      0 22px 48px -16px rgba(140,109,255,0.55),
      0 0 0 1px rgba(255,255,255,0.10) inset,
      0 0 64px -8px rgba(54,197,214,0.45);
    transition: transform 160ms cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 200ms ease;
    position: relative;
    font-family: inherit;
  }
  .voice-mic:hover { transform: translateY(-2px) scale(1.02); }
  .voice-mic:active { transform: translateY(0) scale(0.98); }
  .voice-mic:focus-visible {
    outline: none;
    box-shadow:
      0 22px 48px -16px rgba(140,109,255,0.65),
      0 0 0 4px rgba(140,109,255,0.32),
      0 0 64px -8px rgba(54,197,214,0.55);
  }
  .voice-mic[data-recording="1"] {
    animation: voicePulse 1.6s ease-in-out infinite;
  }
  .voice-mic[data-recording="1"]::after {
    content: '';
    position: absolute;
    inset: -8px;
    border-radius: 9999px;
    border: 2px solid rgba(248,113,113,0.6);
    animation: voiceRing 1.6s ease-out infinite;
  }
  @keyframes voicePulse {
    0%, 100% {
      box-shadow:
        0 22px 48px -16px rgba(140,109,255,0.55),
        0 0 0 1px rgba(255,255,255,0.10) inset,
        0 0 64px -8px rgba(54,197,214,0.45);
    }
    50% {
      box-shadow:
        0 22px 48px -16px rgba(248,113,113,0.55),
        0 0 0 1px rgba(255,255,255,0.18) inset,
        0 0 80px -4px rgba(248,113,113,0.55);
    }
  }
  @keyframes voiceRing {
    0%   { opacity: 0.8; transform: scale(0.95); }
    100% { opacity: 0;   transform: scale(1.25); }
  }
  .voice-mic-icon { width: 56%; height: 56%; }
  .voice-mic-label {
    font-family: var(--font-mono);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    font-weight: 700;
  }
  .voice-mic-label[data-recording="1"] { color: #f87171; }

  /* Transcript card */
  .voice-card {
    margin: clamp(16px, 3vw, 24px) 0;
    padding: clamp(16px, 3vw, 22px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    box-shadow: 0 8px 24px -12px rgba(0,0,0,0.40);
  }
  .voice-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 10px;
  }
  .voice-card-title {
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .voice-card-dot {
    width: 7px; height: 7px; border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .voice-transcript {
    min-height: 64px;
    font-size: clamp(15px, 4vw, 18px);
    line-height: 1.55;
    color: var(--text);
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .voice-transcript[data-empty="1"] {
    color: var(--text-faint);
    font-style: italic;
  }
  .voice-textarea {
    width: 100%;
    box-sizing: border-box;
    min-height: 120px;
    padding: 12px 14px;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 12px;
    font-family: inherit;
    font-size: 15px;
    line-height: 1.55;
    resize: vertical;
  }
  .voice-textarea:focus {
    outline: none;
    border-color: rgba(140,109,255,0.55);
    box-shadow: 0 0 0 4px rgba(140,109,255,0.18);
  }

  /* Repo picker */
  .voice-picker { display: flex; flex-direction: column; gap: 8px; }
  .voice-picker-label {
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    font-weight: 700;
  }
  .voice-picker-input {
    width: 100%;
    box-sizing: border-box;
    padding: 12px 14px;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 12px;
    font-family: inherit;
    font-size: 15px;
  }
  .voice-picker-input:focus {
    outline: none;
    border-color: rgba(140,109,255,0.55);
    box-shadow: 0 0 0 4px rgba(140,109,255,0.18);
  }
  .voice-picker-list {
    max-height: 0;
    overflow: hidden;
    transition: max-height 200ms ease;
    border: 1px solid transparent;
    border-radius: 12px;
    margin-top: 4px;
  }
  .voice-picker-list[data-open="1"] {
    max-height: 240px;
    overflow-y: auto;
    border-color: var(--border);
    background: var(--bg);
  }
  .voice-picker-item {
    padding: 10px 14px;
    cursor: pointer;
    font-size: 14px;
    border-bottom: 1px solid var(--border);
  }
  .voice-picker-item:last-child { border-bottom: 0; }
  .voice-picker-item:hover,
  .voice-picker-item[data-active="1"] {
    background: rgba(140,109,255,0.10);
    color: var(--text-strong);
  }

  /* Interpretation card ("We heard...") */
  .voice-heard {
    margin: 12px 0;
    padding: 16px 18px;
    background:
      linear-gradient(180deg, rgba(140,109,255,0.06), transparent 70%),
      var(--bg-elevated);
    border: 1px solid rgba(140,109,255,0.32);
    border-radius: 16px;
    box-shadow: 0 12px 28px -16px rgba(140,109,255,0.4);
  }
  .voice-heard-eyebrow {
    font-family: var(--font-mono);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--accent);
    font-weight: 700;
    margin-bottom: 6px;
  }
  .voice-heard-title {
    font-family: var(--font-display);
    font-size: clamp(18px, 4.5vw, 22px);
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--text-strong);
    margin-bottom: 6px;
  }
  .voice-heard-body {
    font-size: 14px;
    line-height: 1.55;
    color: var(--text);
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .voice-heard-kind {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border-radius: 9999px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-left: 8px;
    vertical-align: 2px;
  }
  .voice-heard-kind[data-kind="spec"] {
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.34);
  }
  .voice-heard-kind[data-kind="issue"] {
    background: rgba(251,191,36,0.14);
    color: #fde68a;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.32);
  }
  .voice-heard-kind[data-kind="unclear"] {
    background: rgba(255,255,255,0.04);
    color: var(--text-muted);
    box-shadow: inset 0 0 0 1px var(--border-strong, var(--border));
  }

  /* Action buttons */
  .voice-actions {
    display: grid;
    grid-template-columns: 1fr;
    gap: 10px;
    margin-top: 14px;
  }
  @media (min-width: 520px) {
    .voice-actions { grid-template-columns: 1fr 1fr 1fr; }
  }
  .voice-btn {
    appearance: none;
    cursor: pointer;
    padding: 13px 16px;
    border-radius: 12px;
    font-family: inherit;
    font-size: 14px;
    font-weight: 600;
    line-height: 1;
    text-align: center;
    transition: transform 140ms ease, box-shadow 140ms ease, background 140ms ease;
    border: 1px solid var(--border);
    color: var(--text-strong);
    background: var(--bg-elevated);
  }
  .voice-btn:hover { transform: translateY(-1px); background: var(--bg-surface); }
  .voice-btn:active { transform: translateY(0); }
  .voice-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
  .voice-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    border-color: transparent;
    box-shadow: 0 8px 22px -6px rgba(140,109,255,0.55), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .voice-btn-primary:hover {
    box-shadow: 0 12px 28px -6px rgba(140,109,255,0.65), inset 0 1px 0 rgba(255,255,255,0.20);
  }
  .voice-btn-warn {
    background: rgba(251,191,36,0.12);
    color: #fde68a;
    border-color: rgba(251,191,36,0.32);
  }

  /* Status line + toast */
  .voice-status {
    margin-top: 10px;
    font-size: 13px;
    color: var(--text-muted);
    min-height: 18px;
  }
  .voice-status[data-kind="error"] { color: #fca5a5; }
  .voice-status[data-kind="ok"] { color: #86efac; }

  /* Mobile spacing tweaks (375px target) */
  @media (max-width: 420px) {
    .voice-page { padding-left: 12px; padding-right: 12px; }
    .voice-hero { padding: 22px 18px; }
    .voice-title { font-size: 36px; }
    .voice-card { padding: 14px; }
  }
`;

// ---------------------------------------------------------------------------
// GET /voice — render the page
// ---------------------------------------------------------------------------

voice.get("/voice", requireAuth, async (c) => {
  const user = c.get("user")!;
  const repos = await listUserRepos(user.id);
  const reposJson = JSON.stringify(repos);
  const aiOn = isAiAvailable();

  return c.html(
    <Layout title="Talk. Ship." user={user}>
      <style dangerouslySetInnerHTML={{ __html: voiceCss }} />
      <div class="voice-page">
        <header class="voice-hero">
          <div class="voice-hero-orb" aria-hidden="true" />
          <div class="voice-hero-inner">
            <div class="voice-eyebrow">
              <span class="voice-eyebrow-pill" aria-hidden="true">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </svg>
              </span>
              Voice {"·"} phone-first dev workflow
              {!aiOn && (
                <span class="voice-eyebrow-warn">AI offline {"—"} heuristic mode</span>
              )}
            </div>
            <h1 class="voice-title">
              <span class="voice-title-grad">Talk. Ship.</span>
            </h1>
            <p class="voice-sub">
              Tap the orb. Dictate a feature. We'll classify it and open a draft PR
              or file an issue. Built for the train, the kitchen, the dog walk.
            </p>
          </div>
        </header>

        {/* Tap-to-talk orb */}
        <div class="voice-mic-wrap">
          <button
            type="button"
            id="voice-mic"
            class="voice-mic"
            aria-label="Tap to talk"
            aria-pressed="false"
          >
            <svg class="voice-mic-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="9" y="2" width="6" height="13" rx="3" />
              <path d="M19 11v1a7 7 0 0 1-14 0v-1" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          </button>
          <div id="voice-mic-label" class="voice-mic-label">Tap to talk</div>
        </div>

        {/* Live transcript or textarea fallback */}
        <section class="voice-card" id="voice-transcript-card">
          <div class="voice-card-head">
            <span class="voice-card-title">
              <span class="voice-card-dot" aria-hidden="true" />
              <span id="voice-card-title-label">Live transcript</span>
            </span>
            <button type="button" id="voice-clear" class="voice-btn" style="padding:6px 10px;font-size:12px">
              Clear
            </button>
          </div>
          <div
            id="voice-transcript"
            class="voice-transcript"
            data-empty="1"
            aria-live="polite"
          >
            Tap the orb above and start speaking{"…"}
          </div>
          {/* Fallback textarea — hidden until the script confirms no Web Speech API */}
          <textarea
            id="voice-textarea"
            class="voice-textarea"
            style="display:none;margin-top:10px"
            placeholder="Voice not supported in this browser — type your feature request here."
            aria-label="Feature request"
          ></textarea>
        </section>

        {/* Repo picker */}
        <section class="voice-card">
          <div class="voice-picker">
            <label class="voice-picker-label" for="voice-repo-input">Which repo?</label>
            <input
              id="voice-repo-input"
              class="voice-picker-input"
              type="text"
              autocomplete="off"
              placeholder={
                repos.length
                  ? "Start typing to search…"
                  : "You don't own any repos yet — create one first"
              }
              aria-label="Repository"
              disabled={!repos.length}
            />
            <input type="hidden" id="voice-repo-id" value="" />
            <div
              id="voice-repo-list"
              class="voice-picker-list"
              role="listbox"
              aria-label="Repository matches"
            />
          </div>
        </section>

        {/* Interpretation / actions */}
        <section id="voice-heard" class="voice-heard" style="display:none">
          <div class="voice-heard-eyebrow">
            We heard
            <span id="voice-heard-kind-pill" class="voice-heard-kind" data-kind="unclear">
              unclear
            </span>
          </div>
          <div id="voice-heard-title" class="voice-heard-title">{""}</div>
          <div id="voice-heard-body" class="voice-heard-body">{""}</div>
        </section>

        <div class="voice-actions">
          <button type="button" id="voice-ship-spec" class="voice-btn voice-btn-primary" disabled>
            Ship as a spec
          </button>
          <button type="button" id="voice-open-issue" class="voice-btn" disabled>
            Open an issue
          </button>
          <button type="button" id="voice-reset" class="voice-btn voice-btn-warn" disabled>
            Re-record
          </button>
        </div>

        <div id="voice-status" class="voice-status" aria-live="polite" />
      </div>

      {/* Inline JS — feature-detects SpeechRecognition, wires the orb, posts. */}
      <script
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{
          __html: buildVoiceClientJs(reposJson),
        }}
      />
    </Layout>
  );
});

/** Read the CSRF cookie out of document.cookie for fetch calls. */
function buildVoiceClientJs(reposJson: string): string {
  return /* js */ `
(function(){
  var REPOS = ${reposJson};
  var state = {
    transcript: '',
    interim: '',
    interpretation: null,
    recording: false,
    repoId: '',
  };

  function $(id){ return document.getElementById(id); }

  function getCsrf(){
    try {
      var m = document.cookie.match(/(?:^|; )csrf_token=([^;]+)/);
      return m ? decodeURIComponent(m[1]) : '';
    } catch(_) { return ''; }
  }

  function setStatus(msg, kind){
    var el = $('voice-status');
    if (!el) return;
    el.textContent = msg || '';
    if (kind) el.setAttribute('data-kind', kind);
    else el.removeAttribute('data-kind');
  }

  function setTranscript(text){
    state.transcript = text || '';
    var el = $('voice-transcript');
    if (!el) return;
    var combined = (state.transcript + ' ' + (state.interim || '')).trim();
    if (combined) {
      el.textContent = combined;
      el.removeAttribute('data-empty');
    } else {
      el.textContent = 'Tap the orb above and start speaking…';
      el.setAttribute('data-empty', '1');
    }
    var hasText = !!state.transcript.trim();
    $('voice-reset').disabled = !hasText;
  }

  function setInterim(t){
    state.interim = t || '';
    setTranscript(state.transcript);
  }

  function renderInterpretation(it){
    state.interpretation = it || null;
    var box = $('voice-heard');
    if (!it) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    $('voice-heard-title').textContent = it.title || '(no title)';
    $('voice-heard-body').textContent = it.body_markdown || '';
    var pill = $('voice-heard-kind-pill');
    pill.textContent = it.kind || 'unclear';
    pill.setAttribute('data-kind', it.kind || 'unclear');
    // Suggest the repo when the model returned a hint.
    if (it.target_repo_id_hint && !state.repoId) {
      var match = REPOS.find(function(r){ return r.id === it.target_repo_id_hint; });
      if (match) selectRepo(match);
    }
    updateActionState();
  }

  function updateActionState(){
    var ready = !!state.transcript.trim() && !!state.repoId;
    $('voice-ship-spec').disabled = !ready;
    $('voice-open-issue').disabled = !ready;
  }

  function selectRepo(r){
    state.repoId = r.id;
    $('voice-repo-input').value = r.fullName;
    $('voice-repo-id').value = r.id;
    $('voice-repo-list').setAttribute('data-open', '0');
    $('voice-repo-list').innerHTML = '';
    updateActionState();
  }

  // ---- Repo picker (autocomplete) -----------------------------------------
  var input = $('voice-repo-input');
  var list = $('voice-repo-list');
  if (input) {
    input.addEventListener('input', function(){
      var q = (input.value || '').trim().toLowerCase();
      state.repoId = '';
      $('voice-repo-id').value = '';
      updateActionState();
      if (!q) { list.innerHTML = ''; list.setAttribute('data-open', '0'); return; }
      var matches = REPOS.filter(function(r){
        return r.fullName.toLowerCase().indexOf(q) !== -1;
      }).slice(0, 6);
      if (matches.length === 0) {
        list.innerHTML = '<div class="voice-picker-item" style="cursor:default;color:var(--text-muted)">No matches</div>';
        list.setAttribute('data-open', '1');
        return;
      }
      list.innerHTML = matches.map(function(r, i){
        return '<div class="voice-picker-item" role="option" data-id="' + r.id + '"' +
               (i === 0 ? ' data-active="1"' : '') + '>' + escapeHtml(r.fullName) + '</div>';
      }).join('');
      list.setAttribute('data-open', '1');
    });
    list.addEventListener('click', function(e){
      var t = e.target.closest('.voice-picker-item');
      if (!t || !t.getAttribute('data-id')) return;
      var id = t.getAttribute('data-id');
      var r = REPOS.find(function(r){ return r.id === id; });
      if (r) selectRepo(r);
    });
    document.addEventListener('click', function(e){
      if (e.target.closest('.voice-picker')) return;
      list.setAttribute('data-open', '0');
    });
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
  }

  // ---- Web Speech API -----------------------------------------------------
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = null;
  var fallbackArea = $('voice-textarea');
  var mic = $('voice-mic');
  var micLabel = $('voice-mic-label');
  var cardTitleLabel = $('voice-card-title-label');

  if (!SR) {
    // Fallback path — show the textarea, repurpose the mic button as a
    // "submit transcript" button.
    fallbackArea.style.display = 'block';
    var emptyEl = $('voice-transcript');
    if (emptyEl) {
      emptyEl.style.display = 'none';
    }
    if (cardTitleLabel) cardTitleLabel.textContent = 'Type your request';
    if (mic) {
      mic.setAttribute('aria-label', 'Use typed transcript');
      micLabel.textContent = 'Type below, then tap';
      mic.addEventListener('click', function(){
        var v = (fallbackArea.value || '').trim();
        if (!v) {
          setStatus('Type something into the box first.', 'error');
          fallbackArea.focus();
          return;
        }
        setTranscript(v);
        submitTranscribe(v);
      });
    }
    setStatus('Voice not supported in this browser — type your feature request below.', 'error');
  } else if (mic) {
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    rec.onresult = function(ev){
      var finalText = '';
      var interim = '';
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var r = ev.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (finalText) {
        var next = (state.transcript ? state.transcript + ' ' : '') + finalText;
        setTranscript(next.trim());
        setInterim('');
      } else {
        setInterim(interim);
      }
    };
    rec.onerror = function(ev){
      stopRecording();
      var msg = (ev && ev.error) ? ('Mic error: ' + ev.error) : 'Mic error';
      if (ev && ev.error === 'not-allowed') {
        msg = 'Microphone access denied — enable it in your browser settings.';
      }
      setStatus(msg, 'error');
    };
    rec.onend = function(){
      // Browser auto-stops after a pause; reflect that in the UI.
      if (state.recording) stopRecording(true);
    };
    mic.addEventListener('click', function(){
      if (state.recording) stopRecording();
      else startRecording();
    });
  }

  function startRecording(){
    if (!rec) return;
    try { rec.start(); }
    catch(e){ setStatus('Could not start recording: ' + (e && e.message || e), 'error'); return; }
    state.recording = true;
    mic.setAttribute('data-recording', '1');
    mic.setAttribute('aria-pressed', 'true');
    micLabel.setAttribute('data-recording', '1');
    micLabel.textContent = 'Listening… tap to stop';
    setStatus('');
  }

  function stopRecording(autoStopped){
    if (rec) { try { rec.stop(); } catch(_){} }
    state.recording = false;
    if (mic) {
      mic.setAttribute('data-recording', '0');
      mic.removeAttribute('data-recording');
      mic.setAttribute('aria-pressed', 'false');
    }
    if (micLabel) {
      micLabel.removeAttribute('data-recording');
      micLabel.textContent = 'Tap to talk';
    }
    setInterim('');
    var t = state.transcript.trim();
    if (t) submitTranscribe(t);
    else if (autoStopped) setStatus('Didn\\'t catch that — tap to try again.');
  }

  // ---- POSTers ------------------------------------------------------------
  function submitTranscribe(text){
    setStatus('Interpreting…');
    fetch('/voice/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrf() },
      credentials: 'same-origin',
      body: JSON.stringify({ transcript: text }),
    })
      .then(function(r){ return r.ok ? r.json() : r.json().then(function(j){ throw new Error(j.error || ('HTTP ' + r.status)); }); })
      .then(function(j){
        if (!j || !j.ok) throw new Error(j && j.error || 'Unknown error');
        renderInterpretation(j.suggestion);
        setStatus('Heard you. Pick a repo and ship it.', 'ok');
      })
      .catch(function(err){
        setStatus('Failed: ' + (err && err.message || err), 'error');
      });
  }

  function shipAction(path, kind){
    if (!state.repoId) { setStatus('Pick a repo first.', 'error'); return; }
    if (!state.transcript.trim()) { setStatus('Speak something first.', 'error'); return; }
    $('voice-ship-spec').disabled = true;
    $('voice-open-issue').disabled = true;
    setStatus(kind === 'spec' ? 'Shipping spec to autopilot…' : 'Opening issue…');
    fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrf() },
      credentials: 'same-origin',
      body: JSON.stringify({
        repository_id: state.repoId,
        transcript: state.transcript,
      }),
    })
      .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, body: j }; }); })
      .then(function(res){
        if (!res.ok || !res.body || res.body.ok === false) {
          var msg = (res.body && res.body.error) || ('HTTP error');
          throw new Error(msg);
        }
        if (kind === 'spec') {
          setStatus('Spec committed — autopilot will open a PR in ~30s. Redirecting…', 'ok');
          setTimeout(function(){ window.location.href = '/specs'; }, 1200);
        } else {
          var b = res.body;
          if (b.url) {
            setStatus('Issue opened. Redirecting…', 'ok');
            setTimeout(function(){ window.location.href = b.url; }, 800);
          } else {
            setStatus('Issue opened.', 'ok');
          }
        }
      })
      .catch(function(err){
        setStatus('Failed: ' + (err && err.message || err), 'error');
        updateActionState();
      });
  }

  $('voice-ship-spec').addEventListener('click', function(){ shipAction('/voice/ship', 'spec'); });
  $('voice-open-issue').addEventListener('click', function(){ shipAction('/voice/issue', 'issue'); });
  $('voice-reset').addEventListener('click', function(){
    state.transcript = ''; state.interim = ''; state.interpretation = null;
    setTranscript('');
    $('voice-heard').style.display = 'none';
    if (fallbackArea) fallbackArea.value = '';
    updateActionState();
    setStatus('Cleared. Tap to talk.');
  });
  $('voice-clear').addEventListener('click', function(){
    state.transcript = ''; state.interim = '';
    setTranscript('');
    if (fallbackArea) fallbackArea.value = '';
    updateActionState();
  });
})();
`;
}

// ---------------------------------------------------------------------------
// POST /voice/transcribe — JSON, classify
// ---------------------------------------------------------------------------

voice.post("/voice/transcribe", requireAuth, async (c) => {
  const user = c.get("user")!;
  let body: { transcript?: unknown } = {};
  try {
    body = (await c.req.json()) as { transcript?: unknown };
  } catch {
    return c.json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const transcript = typeof body.transcript === "string" ? body.transcript : "";
  if (!transcript.trim()) {
    return c.json({ ok: false, error: "transcript is empty" }, 400);
  }
  const repos = await listUserRepos(user.id);
  const res = await interpretVoiceTranscript({
    transcript,
    knownRepos: repos,
  });
  if (!res.ok) return c.json(res, 400);
  return c.json({ ok: true, suggestion: res.suggestion });
});

// ---------------------------------------------------------------------------
// POST /voice/ship — commit a ready spec
// ---------------------------------------------------------------------------

voice.post("/voice/ship", requireAuth, async (c) => {
  const user = c.get("user")!;
  let body: { repository_id?: unknown; transcript?: unknown } = {};
  try {
    body = (await c.req.json()) as {
      repository_id?: unknown;
      transcript?: unknown;
    };
  } catch {
    return c.json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const repositoryId =
    typeof body.repository_id === "string" ? body.repository_id : "";
  const transcript =
    typeof body.transcript === "string" ? body.transcript : "";
  if (!repositoryId) {
    return c.json({ ok: false, error: "repository_id required" }, 400);
  }
  if (!transcript.trim()) {
    return c.json({ ok: false, error: "transcript is empty" }, 400);
  }

  // Confirm the user owns this repo. We don't have collaborators here yet —
  // matches the spec-to-PR convention.
  const repos = await listUserRepos(user.id);
  if (!repos.find((r) => r.id === repositoryId)) {
    return c.json({ ok: false, error: "you can only ship to your own repos" }, 403);
  }

  // Re-interpret so the committed spec has a polished title + body. Cheap —
  // the route POSTs once, this Claude call is fire-and-wait but bounded.
  const interp = await interpretVoiceTranscript({ transcript });
  const interpretation = interp.ok ? interp.suggestion : undefined;

  const res = await shipAsSpec({
    repositoryId,
    transcript,
    userId: user.id,
    interpretation,
  });
  if (!res.ok) return c.json(res, 400);
  return c.json({
    ok: true,
    spec_path: res.specPath,
    commit_sha: res.commitSha,
    branch: res.branch,
  });
});

// ---------------------------------------------------------------------------
// POST /voice/issue — file an issue
// ---------------------------------------------------------------------------

voice.post("/voice/issue", requireAuth, async (c) => {
  const user = c.get("user")!;
  let body: { repository_id?: unknown; transcript?: unknown } = {};
  try {
    body = (await c.req.json()) as {
      repository_id?: unknown;
      transcript?: unknown;
    };
  } catch {
    return c.json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const repositoryId =
    typeof body.repository_id === "string" ? body.repository_id : "";
  const transcript =
    typeof body.transcript === "string" ? body.transcript : "";
  if (!repositoryId) {
    return c.json({ ok: false, error: "repository_id required" }, 400);
  }
  if (!transcript.trim()) {
    return c.json({ ok: false, error: "transcript is empty" }, 400);
  }

  // Same ownership guard as /voice/ship.
  const repos = await listUserRepos(user.id);
  if (!repos.find((r) => r.id === repositoryId)) {
    return c.json({ ok: false, error: "you can only file issues on your own repos" }, 403);
  }

  const interp = await interpretVoiceTranscript({ transcript });
  const interpretation = interp.ok ? interp.suggestion : undefined;

  const res = await createIssueFromVoice({
    repositoryId,
    transcript,
    userId: user.id,
    interpretation,
  });
  if (!res.ok) return c.json(res, 400);

  // Fire-and-forget AI triage so the new issue gets the standard treatment.
  // We resolve the repo id back into an issue id via the returning() above,
  // but the helper exported from voice-to-pr only surfaces issueNumber. The
  // triage trigger expects an issueId — call the lightweight variant only if
  // we can resolve it; otherwise skip silently.
  try {
    const { db } = await import("../db");
    const { issues } = await import("../db/schema");
    const { eq, and } = await import("drizzle-orm");
    const [row] = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.repositoryId, repositoryId),
          eq(issues.number, res.issueNumber)
        )
      )
      .limit(1);
    if (row) {
      triggerIssueTriage({
        ownerName: res.ownerName,
        repoName: res.repoName,
        repositoryId,
        issueId: row.id,
        issueNumber: res.issueNumber,
        authorId: user.id,
        title: interpretation?.title || transcript.slice(0, 80),
        body: interpretation?.body_markdown || transcript,
      }).catch((err) => {
        if (process.env.DEBUG_VOICE === "1") {
          console.warn(
            "[voice] issue triage trigger failed:",
            err instanceof Error ? err.message : err
          );
        }
      });
    }
  } catch {
    /* triage is best-effort */
  }

  return c.json({
    ok: true,
    issue_number: res.issueNumber,
    url: `/${res.ownerName}/${res.repoName}/issues/${res.issueNumber}`,
  });
});

export default voice;
