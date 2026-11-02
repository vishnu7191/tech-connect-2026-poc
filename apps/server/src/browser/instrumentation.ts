import type { Page } from 'playwright';
import { logger } from '../core/logger.js';

/**
 * Page-side interaction instrumentation.
 *
 * Lenz records interactions from two places:
 *
 *   1. The ACTION WRAPPER (services/interaction-recorder.ts), which knows the
 *      step, the intended target and the verified outcome. This is the
 *      authoritative source.
 *   2. These page-side listeners, which observe what the DOM actually saw -
 *      including scrolling the page did by itself (anchor jumps, focus scroll,
 *      momentum on a touch surface) and clicks that reach a frame the wrapper
 *      cannot address directly.
 *
 * The second source exists to CLOSE GAPS, not to duplicate the first. The
 * recorder de-duplicates on (time, position); see `isDuplicate` there.
 *
 * ---------------------------------------------------------------------------
 * Why the script is a STRING and not a function
 *
 * `page.addInitScript(fn)` serializes `fn`, but this server runs through `tsx`,
 * so esbuild has already rewritten the source - including wrapping named
 * functions in a `__name` helper that does not exist in the page. That is the
 * exact failure that once produced a silent, empty Make discovery run
 * (see doc/HANDOVER.md). Passing `{ content: '...' }` hands Chromium text that
 * esbuild never touched, which sidesteps the whole class of problem.
 * ---------------------------------------------------------------------------
 *
 * PRIVACY: these listeners never read the value of any input, textarea or
 * contenteditable element, and never record the text of a password, email, tel,
 * or anything marked `data-sensitive`. The event model has no field that could
 * carry a typed value.
 */

/** What the page sends across the binding. Validated on arrival. */
export interface RawPageEvent {
  type: 'click' | 'tap' | 'swipe' | 'scroll' | 'key' | 'navigation';
  pointer: 'mouse' | 'touch' | 'none';
  x: number | null;
  y: number | null;
  pageX: number | null;
  pageY: number | null;
  role: string | null;
  name: string | null;
  selector: string | null;
  targetWidth: number | null;
  targetHeight: number | null;
  scrollX: number | null;
  scrollY: number | null;
  docWidth: number | null;
  docHeight: number | null;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  deltaX: number | null;
  deltaY: number | null;
  durationMs: number | null;
  container: string;
  url: string;
  /** Page wall-clock time (`Date.now()`), used to place the event on the timeline. */
  ts: number;
  frameUrl: string;
}

export const LENZ_BINDING = '__lenzRecordInteraction';

/**
 * Scroll sampling interval, in milliseconds.
 *
 * A raw `scroll` listener fires on every animation frame - roughly 60 events a
 * second, per container. At that rate a three-minute run writes tens of
 * thousands of near-identical rows, which costs far more than the fidelity is
 * worth. 120 ms keeps the shape of the movement (a flick resolves to 4-8
 * samples) while bounding the row count, and a trailing sample always fires so
 * the final resting position is exact rather than wherever the throttle last
 * landed.
 */
export const SCROLL_SAMPLE_MS = 120;

const INIT_SCRIPT = `
(function () {
  if (window.__lenzInstrumented) return;
  window.__lenzInstrumented = true;

  var SAMPLE_MS = ${SCROLL_SAMPLE_MS};
  var SENSITIVE_TYPES = { password: 1, email: 1, tel: 1, 'credit-card': 1 };

  var send = function (payload) {
    try {
      if (typeof window.${LENZ_BINDING} === 'function') {
        window.${LENZ_BINDING}(payload);
      }
    } catch (err) {
      // The binding disappears when the context tears down mid-navigation.
      // Nothing can be done about it here, and throwing would break the page.
      if (window.console && console.debug) console.debug('[lenz] report failed', err && err.message);
    }
  };

  var isSensitive = function (el) {
    if (!el || !el.tagName) return false;
    var tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      var t = (el.getAttribute('type') || 'text').toLowerCase();
      if (SENSITIVE_TYPES[t]) return true;
      var ac = (el.getAttribute('autocomplete') || '').toLowerCase();
      if (ac.indexOf('password') >= 0 || ac.indexOf('cc-') === 0 || ac.indexOf('one-time') >= 0) return true;
    }
    if (el.hasAttribute && el.hasAttribute('data-sensitive')) return true;
    return false;
  };

  /* Accessible-ish name. Deliberately NEVER reads .value, and refuses to read
     text out of anything that could hold something a person typed. */
  var nameFor = function (el) {
    if (!el || !el.tagName) return null;
    if (isSensitive(el)) return '[redacted field]';
    var aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return String(aria).trim().slice(0, 120);
    var tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable) {
      var ph = el.getAttribute && el.getAttribute('placeholder');
      var nm = el.getAttribute && el.getAttribute('name');
      return (ph || nm || tag).toString().trim().slice(0, 120);
    }
    if (tag === 'img') {
      var alt = el.getAttribute('alt');
      return alt ? String(alt).trim().slice(0, 120) : 'image';
    }
    var text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text) return text.slice(0, 120);
    var title = el.getAttribute && el.getAttribute('title');
    return title ? String(title).trim().slice(0, 120) : null;
  };

  var roleFor = function (el) {
    if (!el || !el.tagName) return null;
    var r = el.getAttribute && el.getAttribute('role');
    if (r) return String(r).slice(0, 60);
    return el.tagName.toLowerCase();
  };

  /* Short structural path. Identifiers and test ids only - never a value. */
  var selectorFor = function (el) {
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 4) {
      var piece = node.tagName.toLowerCase();
      var testId = node.getAttribute && (node.getAttribute('data-testid') || node.getAttribute('data-test-id'));
      if (testId) {
        parts.unshift(piece + '[data-testid="' + String(testId).slice(0, 40) + '"]');
        break;
      }
      if (node.id && /^[A-Za-z][\\w-]*$/.test(node.id)) {
        parts.unshift('#' + node.id);
        break;
      }
      var parent = node.parentElement;
      if (parent) {
        var same = 0;
        var idx = 0;
        for (var i = 0; i < parent.children.length; i++) {
          var sib = parent.children[i];
          if (sib.tagName === node.tagName) {
            same++;
            if (sib === node) idx = same;
          }
        }
        if (same > 1) piece += ':nth-of-type(' + idx + ')';
      }
      parts.unshift(piece);
      node = node.parentElement;
      depth++;
    }
    return parts.join(' > ').slice(0, 300) || null;
  };

  var docSize = function () {
    var d = document.documentElement;
    var b = document.body;
    return {
      w: Math.max(d ? d.scrollWidth : 0, b ? b.scrollWidth : 0, window.innerWidth || 0),
      h: Math.max(d ? d.scrollHeight : 0, b ? b.scrollHeight : 0, window.innerHeight || 0)
    };
  };

  var containerPath = function (target) {
    if (!target || target === document || target === window || target === document.documentElement) {
      return 'window';
    }
    return selectorFor(target) || 'nested-container';
  };

  var base = function (extra) {
    var size = docSize();
    var payload = {
      x: null, y: null, pageX: null, pageY: null,
      role: null, name: null, selector: null,
      targetWidth: null, targetHeight: null,
      deltaX: null, deltaY: null, durationMs: null,
      container: 'window',
      scrollX: window.scrollX || 0,
      scrollY: window.scrollY || 0,
      docWidth: size.w,
      docHeight: size.h,
      viewportWidth: window.innerWidth || 0,
      viewportHeight: window.innerHeight || 0,
      devicePixelRatio: window.devicePixelRatio || 1,
      url: location.href,
      frameUrl: location.href,
      ts: Date.now()
    };
    for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k]; }
    return payload;
  };

  var describeTarget = function (payload, el) {
    if (!el || el.nodeType !== 1) return payload;
    var rect = null;
    try { rect = el.getBoundingClientRect(); } catch (err) { rect = null; }
    payload.role = roleFor(el);
    payload.name = nameFor(el);
    payload.selector = selectorFor(el);
    if (rect) { payload.targetWidth = rect.width; payload.targetHeight = rect.height; }
    return payload;
  };

  /* ---- pointer / touch ---- */

  var touchStart = null;

  document.addEventListener('touchstart', function (ev) {
    try {
      var t = ev.changedTouches && ev.changedTouches[0];
      if (!t) return;
      touchStart = {
        x: t.clientX, y: t.clientY, ts: Date.now(), target: ev.target,
        /* Furthest the finger ever got from where it landed. See the note on
           the end handler for why the end position is not enough. */
        maxDx: 0, maxDy: 0
      };
    } catch (err) { /* nothing recoverable */ }
  }, true);

  document.addEventListener('touchmove', function (ev) {
    try {
      if (!touchStart) return;
      var t = ev.changedTouches && ev.changedTouches[0];
      if (!t) return;
      var dx = t.clientX - touchStart.x;
      var dy = t.clientY - touchStart.y;
      if (Math.abs(dx) > Math.abs(touchStart.maxDx)) touchStart.maxDx = dx;
      if (Math.abs(dy) > Math.abs(touchStart.maxDy)) touchStart.maxDy = dy;
    } catch (err) { /* nothing recoverable */ }
  }, true);

  /*
   * End of a touch sequence.
   *
   * Bound to touchCANCEL as well as touchend, and measured from the furthest
   * point the finger reached rather than from where the sequence ended. Both
   * matter for the same reason: once the browser decides a drag is a scroll it
   * takes the gesture over, and the page sees a cancel carrying a stale
   * position. Measuring the end position alone under-reports a 400px flick as
   * a ~40px nudge, which was observed and is what this handler now avoids.
   */
  var endTouch = function (ev) {
    try {
      if (!touchStart) return;
      var t = ev.changedTouches && ev.changedTouches[0];
      var endDx = t ? t.clientX - touchStart.x : 0;
      var endDy = t ? t.clientY - touchStart.y : 0;
      var dx = Math.abs(endDx) > Math.abs(touchStart.maxDx) ? endDx : touchStart.maxDx;
      var dy = Math.abs(endDy) > Math.abs(touchStart.maxDy) ? endDy : touchStart.maxDy;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var dur = Date.now() - touchStart.ts;
      /* 12 CSS px is the conventional slop between a tap and a drag; below it a
         finger has not meaningfully moved. Above it the gesture is reported as
         a swipe with its real displacement, never collapsed into a tap. */
      var isSwipe = dist > 12;
      var payload = base({
        type: isSwipe ? 'swipe' : 'tap',
        pointer: 'touch',
        x: touchStart.x,
        y: touchStart.y,
        pageX: touchStart.x + (window.scrollX || 0),
        pageY: touchStart.y + (window.scrollY || 0),
        deltaX: isSwipe ? dx : null,
        deltaY: isSwipe ? dy : null,
        durationMs: dur
      });
      send(describeTarget(payload, touchStart.target));
      touchStart = null;
    } catch (err) { /* nothing recoverable */ }
  };

  document.addEventListener('touchend', endTouch, true);
  document.addEventListener('touchcancel', endTouch, true);

  document.addEventListener('click', function (ev) {
    try {
      /* A click synthesised from a touch is already reported as a tap. */
      if (ev.pointerType === 'touch') return;
      if (ev.detail === 0 && !ev.clientX && !ev.clientY) {
        /* Keyboard activation - genuinely has no coordinate. Report it as such
           rather than inventing 0,0, which would appear as a corner hotspot. */
        send(describeTarget(base({ type: 'key', pointer: 'none' }), ev.target));
        return;
      }
      var payload = base({
        type: 'click',
        pointer: 'mouse',
        x: ev.clientX,
        y: ev.clientY,
        pageX: ev.pageX,
        pageY: ev.pageY
      });
      send(describeTarget(payload, ev.target));
    } catch (err) { /* nothing recoverable */ }
  }, true);

  /* ---- scroll ---- */

  var lastSent = 0;
  var lastY = window.scrollY || 0;
  var lastX = window.scrollX || 0;
  var trailing = null;

  var emitScroll = function (target) {
    var y = 0, x = 0, container = 'window';
    if (target && target !== document && target !== window && target !== document.documentElement && target.nodeType === 1) {
      y = target.scrollTop; x = target.scrollLeft; container = containerPath(target);
    } else {
      y = window.scrollY || 0; x = window.scrollX || 0;
    }
    var dy = y - lastY;
    var dx = x - lastX;
    var dir = 'none';
    if (Math.abs(dy) >= Math.abs(dx)) { if (dy > 0) dir = 'down'; else if (dy < 0) dir = 'up'; }
    else { if (dx > 0) dir = 'right'; else if (dx < 0) dir = 'left'; }
    var payload = base({ type: 'scroll', pointer: 'none', deltaX: dx, deltaY: dy, container: container });
    payload.scrollX = x;
    payload.scrollY = y;
    payload.direction = dir;
    if (container !== 'window' && target && target.nodeType === 1) {
      payload.docHeight = target.scrollHeight;
      payload.docWidth = target.scrollWidth;
      payload.viewportHeight = target.clientHeight;
      payload.viewportWidth = target.clientWidth;
    }
    lastY = y; lastX = x;
    send(payload);
  };

  document.addEventListener('scroll', function (ev) {
    try {
      var now = Date.now();
      var target = ev.target;
      if (trailing) { clearTimeout(trailing); trailing = null; }
      if (now - lastSent >= SAMPLE_MS) {
        lastSent = now;
        emitScroll(target);
      }
      /* Always close the gesture with the resting position, so maximum depth
         is the real maximum and not wherever the throttle happened to stop. */
      trailing = setTimeout(function () {
        lastSent = Date.now();
        emitScroll(target);
        trailing = null;
      }, SAMPLE_MS + 40);
    } catch (err) { /* nothing recoverable */ }
  }, true);
})();
`;

/**
 * Install the listeners and the reporting binding on a page.
 *
 * Order matters: the binding has to exist before the init script runs, and both
 * are delivered as init scripts in registration order.
 */
export async function installInteractionInstrumentation(
  page: Page,
  onEvent: (event: RawPageEvent) => void,
): Promise<boolean> {
  try {
    await page.exposeBinding(LENZ_BINDING, (_source, payload: unknown) => {
      try {
        if (payload && typeof payload === 'object') onEvent(payload as RawPageEvent);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'Interaction event handler threw');
      }
    });
    await page.addInitScript({ content: INIT_SCRIPT });
    return true;
  } catch (err) {
    // Instrumentation is additive. If it cannot be installed the run still
    // produces wrapper-recorded interactions - but the caller must report the
    // reduced fidelity rather than present a thinner dataset as complete.
    logger.warn(
      { err: (err as Error).message },
      'Could not install page-side interaction instrumentation; wrapper-only recording',
    );
    return false;
  }
}

/**
 * Apply the listeners to a page that is already loaded.
 *
 * `addInitScript` only affects documents created afterwards, so a session that
 * installs instrumentation after navigating needs this too. Safe to call
 * repeatedly - the script guards on `window.__lenzInstrumented`.
 */
export async function applyInstrumentationNow(page: Page): Promise<void> {
  try {
    await page.evaluate(INIT_SCRIPT);
  } catch (err) {
    logger.debug(
      { err: (err as Error).message },
      'Could not apply interaction instrumentation to the current document',
    );
  }
}
