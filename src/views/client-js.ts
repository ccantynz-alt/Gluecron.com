/**
 * Client-side JavaScript — embedded inline in the layout.
 *
 * Provides interactivity without requiring a build step or framework:
 * - Copy to clipboard
 * - Markdown preview in comment forms
 * - Keyboard shortcuts
 * - Toast notifications
 * - Async form submission for stars/actions
 * - Live search debouncing
 * - Tab indentation in textareas
 * - Mobile hamburger menu
 */

export const clientJs = `
(function() {
  'use strict';

  // ─── Toast Notification System ──────────────────────────────────────────

  const toastContainer = document.createElement('div');
  toastContainer.id = 'toast-container';
  document.body.appendChild(toastContainer);

  function toast(message, type) {
    type = type || 'info';
    var el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.textContent = message;
    toastContainer.appendChild(el);
    requestAnimationFrame(function() { el.classList.add('toast-visible'); });
    setTimeout(function() {
      el.classList.remove('toast-visible');
      setTimeout(function() { el.remove(); }, 300);
    }, 3000);
  }

  // ─── Copy to Clipboard ─────────────────────────────────────────────────

  document.addEventListener('click', function(e) {
    var btn = e.target.closest('[data-clipboard]');
    if (!btn) return;
    e.preventDefault();
    var text = btn.getAttribute('data-clipboard');
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(function() {
        var original = btn.textContent;
        btn.textContent = 'Copied!';
        btn.classList.add('btn-success');
        setTimeout(function() {
          btn.textContent = original;
          btn.classList.remove('btn-success');
        }, 2000);
      });
    }
  });

  // ─── Markdown Preview ──────────────────────────────────────────────────

  document.addEventListener('click', function(e) {
    var tab = e.target.closest('[data-tab]');
    if (!tab) return;

    var editor = tab.closest('.comment-editor');
    if (!editor) return;

    var tabName = tab.getAttribute('data-tab');
    var tabs = editor.querySelectorAll('[data-tab]');
    var textarea = editor.querySelector('textarea');
    var preview = editor.querySelector('.editor-preview');

    tabs.forEach(function(t) { t.classList.toggle('active', t.getAttribute('data-tab') === tabName); });

    if (tabName === 'preview') {
      textarea.style.display = 'none';
      preview.style.display = 'block';
      preview.innerHTML = '<div style="padding:12px;color:var(--text-muted)">Loading preview...</div>';

      // Simple markdown rendering (bold, italic, code, links, headers)
      var md = textarea.value || 'Nothing to preview';
      var html = md
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/^### (.+)$/gm, '<h3>$1</h3>')
        .replace(/^## (.+)$/gm, '<h2>$1</h2>')
        .replace(/^# (.+)$/gm, '<h1>$1</h1>')
        .replace(/\\.([^\\x60]+)\\.\\./g, '<code>$1</code>')
        .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
        .replace(/\\*(.+?)\\*/g, '<em>$1</em>')
        .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>')
        .replace(/\\n/g, '<br>');
      preview.innerHTML = '<div class="markdown-body" style="padding:12px">' + html + '</div>';
    } else {
      textarea.style.display = '';
      preview.style.display = 'none';
    }
  });

  // ─── Tab Key in Textareas ──────────────────────────────────────────────

  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Tab') return;
    var textarea = e.target;
    if (textarea.tagName !== 'TEXTAREA') return;

    e.preventDefault();
    var start = textarea.selectionStart;
    var end = textarea.selectionEnd;
    var value = textarea.value;
    textarea.value = value.substring(0, start) + '  ' + value.substring(end);
    textarea.selectionStart = textarea.selectionEnd = start + 2;
  });

  // ─── Keyboard Shortcuts ────────────────────────────────────────────────

  var shortcutOverlay = null;

  function toggleShortcuts() {
    if (shortcutOverlay) {
      shortcutOverlay.remove();
      shortcutOverlay = null;
      return;
    }
    shortcutOverlay = document.createElement('div');
    shortcutOverlay.className = 'shortcut-overlay';
    shortcutOverlay.innerHTML = [
      '<div class="shortcut-modal">',
      '<h3>Keyboard Shortcuts</h3>',
      '<div class="shortcut-grid">',
      '<div><kbd>?</kbd> Show shortcuts</div>',
      '<div><kbd>/</kbd> Focus search</div>',
      '<div><kbd>g</kbd> <kbd>h</kbd> Go home</div>',
      '<div><kbd>g</kbd> <kbd>e</kbd> Go to explore</div>',
      '<div><kbd>g</kbd> <kbd>n</kbd> New repository</div>',
      '<div><kbd>g</kbd> <kbd>s</kbd> Go to settings</div>',
      '<div><kbd>Esc</kbd> Close modal</div>',
      '</div>',
      '<button class="btn btn-sm" onclick="this.closest(\\'.shortcut-overlay\\').remove()">Close</button>',
      '</div>'
    ].join('');
    document.body.appendChild(shortcutOverlay);
    shortcutOverlay.addEventListener('click', function(e) {
      if (e.target === shortcutOverlay) {
        shortcutOverlay.remove();
        shortcutOverlay = null;
      }
    });
  }

  var gPressed = false;
  var gTimeout;

  document.addEventListener('keydown', function(e) {
    // Don't trigger shortcuts when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

    if (e.key === '?') {
      e.preventDefault();
      toggleShortcuts();
      return;
    }

    if (e.key === 'Escape') {
      if (shortcutOverlay) {
        shortcutOverlay.remove();
        shortcutOverlay = null;
      }
      return;
    }

    if (e.key === '/') {
      var searchInput = document.querySelector('.search-input') || document.querySelector('input[name="q"]');
      if (searchInput) {
        e.preventDefault();
        searchInput.focus();
      }
      return;
    }

    if (e.key === 'g') {
      if (!gPressed) {
        gPressed = true;
        gTimeout = setTimeout(function() { gPressed = false; }, 500);
        return;
      }
    }

    if (gPressed) {
      gPressed = false;
      clearTimeout(gTimeout);
      if (e.key === 'h') { window.location.href = '/'; return; }
      if (e.key === 'e') { window.location.href = '/explore'; return; }
      if (e.key === 'n') { window.location.href = '/new'; return; }
      if (e.key === 's') { window.location.href = '/settings'; return; }
    }
  });

  // ─── Star Button Async ─────────────────────────────────────────────────

  document.addEventListener('click', function(e) {
    var starBtn = e.target.closest('.star-btn[type="submit"]');
    if (!starBtn) return;

    var form = starBtn.closest('form');
    if (!form) return;

    e.preventDefault();
    var action = form.getAttribute('action');

    fetch(action, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    }).then(function() {
      // Toggle visual state
      starBtn.classList.toggle('starred');
      var currentText = starBtn.textContent.trim();
      var match = currentText.match(/(\\d+)/);
      if (match) {
        var count = parseInt(match[1]);
        var newCount = starBtn.classList.contains('starred') ? count + 1 : count - 1;
        starBtn.textContent = (starBtn.classList.contains('starred') ? '\\u2605 ' : '\\u2606 ') + Math.max(0, newCount);
      }
      toast(starBtn.classList.contains('starred') ? 'Starred!' : 'Unstarred', 'success');
    }).catch(function() {
      // Fall back to normal form submission
      form.submit();
    });
  });

  // ─── Mobile Hamburger Menu ─────────────────────────────────────────────

  var navRight = document.querySelector('.nav-right');
  if (navRight && window.innerWidth < 768) {
    var hamburger = document.createElement('button');
    hamburger.className = 'hamburger-btn';
    hamburger.innerHTML = '\\u2630';
    hamburger.setAttribute('aria-label', 'Toggle menu');
    navRight.parentElement.insertBefore(hamburger, navRight);
    navRight.classList.add('mobile-hidden');

    hamburger.addEventListener('click', function() {
      navRight.classList.toggle('mobile-hidden');
      navRight.classList.toggle('mobile-visible');
    });
  }

  // ─── Relative Time Auto-Update ─────────────────────────────────────────

  function updateTimes() {
    document.querySelectorAll('[data-time]').forEach(function(el) {
      var date = new Date(el.getAttribute('data-time'));
      var now = new Date();
      var diff = Math.floor((now - date) / 60000);
      if (diff < 1) el.textContent = 'just now';
      else if (diff < 60) el.textContent = diff + 'm ago';
      else if (diff < 1440) el.textContent = Math.floor(diff / 60) + 'h ago';
      else if (diff < 43200) el.textContent = Math.floor(diff / 1440) + 'd ago';
    });
  }
  var _timesInterval = setInterval(updateTimes, 60000);

  // ─── Confirmation on Dangerous Actions ─────────────────────────────────

  document.addEventListener('submit', function(e) {
    var form = e.target;
    if (!form.classList.contains('confirm-action')) return;
    var msg = form.getAttribute('data-confirm') || 'Are you sure?';
    if (!confirm(msg)) {
      e.preventDefault();
    }
  });

})();
`;
