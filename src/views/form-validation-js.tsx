/**
 * BLOCK O2 — Inline client-side form validation.
 *
 * Vanilla JS that mounts a `<span class="field-error" aria-live="polite">`
 * under every matched form input. Fires on blur AND on input (after the
 * first blur). Per-field override via data-validation-message attribute.
 *
 * Visual states:
 *   .input-invalid → red border
 *   .input-valid   → green border + checkmark icon
 *
 * Server-side `?error=…` redirect validation still works — this is
 * additive UX polish.
 */

import type { FC } from "hono/jsx";

export const formValidationScript = /* js */ `
(function () {
  if (window.__gluecronFormValidationMounted) return;
  window.__gluecronFormValidationMounted = true;

  function ready(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn);
    } else { fn(); }
  }

  function validateInput(el) {
    var v = el.value;
    if (el.disabled || el.readOnly) return "";
    if (el.hasAttribute("required") && v.trim() === "") {
      return el.getAttribute("data-validation-required")
        || (el.labels && el.labels[0] ? el.labels[0].textContent + " is required" : "This field is required");
    }
    if (v === "") return "";
    if (el.type === "email") {
      var emailRe = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
      if (!emailRe.test(v)) {
        return el.getAttribute("data-validation-message") || "Enter a valid email address";
      }
    }
    var pat = el.getAttribute("pattern");
    if (pat) {
      try {
        if (!new RegExp("^(?:" + pat + ")$").test(v)) {
          return el.getAttribute("data-validation-message") || "Doesn't match the required format";
        }
      } catch (_e) {}
    }
    var minL = parseInt(el.getAttribute("minlength") || "0", 10);
    if (minL > 0 && v.length < minL) {
      return el.getAttribute("data-validation-message") || ("Must be at least " + minL + " characters");
    }
    var maxL = parseInt(el.getAttribute("maxlength") || "0", 10);
    if (maxL > 0 && v.length > maxL) {
      return el.getAttribute("data-validation-message") || ("Must be at most " + maxL + " characters");
    }
    return "";
  }

  function ensureErrorSpan(el) {
    var id = el.id || el.name;
    if (!id) { id = "fv-" + Math.random().toString(36).slice(2, 8); el.id = id; }
    var errId = id + "-fv-error";
    var span = document.getElementById(errId);
    if (!span) {
      span = document.createElement("span");
      span.id = errId;
      span.className = "field-error";
      span.setAttribute("aria-live", "polite");
      el.parentNode && el.parentNode.insertBefore(span, el.nextSibling);
      var describedBy = el.getAttribute("aria-describedby") || "";
      var parts = describedBy.split(/\\s+/).filter(Boolean);
      if (parts.indexOf(errId) < 0) {
        parts.push(errId);
        el.setAttribute("aria-describedby", parts.join(" "));
      }
    }
    return span;
  }

  function applyState(el, msg) {
    var span = ensureErrorSpan(el);
    if (msg) {
      el.classList.add("input-invalid");
      el.classList.remove("input-valid");
      el.setAttribute("aria-invalid", "true");
      span.textContent = msg;
      span.classList.add("field-error-shown");
    } else if (el.value === "") {
      el.classList.remove("input-invalid");
      el.classList.remove("input-valid");
      el.removeAttribute("aria-invalid");
      span.textContent = "";
      span.classList.remove("field-error-shown");
    } else {
      el.classList.remove("input-invalid");
      el.classList.add("input-valid");
      el.removeAttribute("aria-invalid");
      span.textContent = "";
      span.classList.remove("field-error-shown");
    }
  }

  function wire(el) {
    if (el.__fvWired) return;
    el.__fvWired = true;
    el.addEventListener("blur", function () { el.__fvBlurred = true; applyState(el, validateInput(el)); });
    el.addEventListener("input", function () { if (!el.__fvBlurred) return; applyState(el, validateInput(el)); });
  }

  function scan(root) {
    var sel = "input[required],input[pattern],input[minlength],input[maxlength],input[type=email]";
    var nodes = (root || document).querySelectorAll(sel);
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.type === "hidden" || el.type === "submit" || el.type === "button") continue;
      wire(el);
    }
  }

  ready(function () { scan(document); });
})();
`;

export const formValidationCss = `
.input-invalid { border-color: var(--red, #ff6a6a) !important; box-shadow: 0 0 0 2px rgba(255,106,106,0.18) !important; }
.input-valid { border-color: var(--green, #4ade80) !important; box-shadow: 0 0 0 2px rgba(74,222,128,0.18) !important; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16' fill='none' stroke='%234ade80' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 8.5l3.5 3.5L13 4.5'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; background-size: 14px 14px; padding-right: 32px !important; }
.field-error { display: block; margin-top: 4px; font-size: 12px; color: var(--red, #ff6a6a); line-height: 1.4; min-height: 0; transition: min-height 120ms ease; }
.field-error-shown { min-height: 1.4em; }
`;

export const FormValidationAssets: FC = () => (
  <>
    <style dangerouslySetInnerHTML={{ __html: formValidationCss }} />
    <script dangerouslySetInnerHTML={{ __html: formValidationScript }} />
  </>
);
