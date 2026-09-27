import { useEffect, useRef } from 'react';

/**
 * Publishes the height of the on-screen keyboard as `--keyboard-inset` on
 * <html>, in pixels, toggles `body.keyboard-open` while it is up, and calls
 * each subscriber's `onChange` when it moves.
 *
 * WHY THIS IS NEEDED AT ALL
 *
 * index.html declares `interactive-widget=resizes-visual`. Under that mode —
 * the default in Chrome since 108 — the Android keyboard resizes only the
 * VISUAL viewport. The layout viewport does not move, and neither does
 * `100dvh`: `dvh` tracks the *layout* viewport, so "dynamic" here means
 * dynamic with respect to the collapsing URL bar, not with respect to the
 * keyboard. Every height and every bottom padding in the app is therefore
 * still measured against the full screen while the bottom third of that
 * screen is covered, which is how inputs end up underneath the keyboard.
 *
 * Switching the meta to `interactive-widget=resizes-content` would make `dvh`
 * shrink and fix this in one line — but it changes the behaviour of every
 * fixed element on every page (the bottom tab bar most of all), and the app's
 * `keyboard-active` mechanism was built around the current mode.
 *
 * ONE LISTENER, MANY SUBSCRIBERS
 *
 * The measurement is module-scoped rather than per-hook-instance: the hook is
 * mounted globally in App and again by pages that need their own reaction to
 * it (SupportChatPage scrolls its timeline). Two instances must not mean two
 * sets of viewport listeners, and — the part that actually bites — the first
 * one to unmount must not remove the custom property while the other is still
 * relying on it. Listeners attach on the first subscriber and detach on the
 * last.
 *
 * `visualViewport.offsetTop` is part of the arithmetic on purpose: when the
 * browser scrolls the visual viewport to keep a focused field in sight, the
 * keyboard's height alone no longer describes how much of the layout viewport
 * is hidden below the fold. Booking's bottom space instead uses the height
 * difference, which does not change each time the visual viewport pans.
 */

const subscribers = new Set();
let attached = false;
let frame = 0;
let lastInset = -1;
let lastKeyboardHeight = -1;

const measure = () => {
  frame = 0;
  const vv = window.visualViewport;
  if (!vv) return;

  const hidden = window.innerHeight - vv.height - vv.offsetTop;
  // Small negative values show up mid-animation and under desktop zoom.
  const inset = Math.max(0, Math.round(hidden));
  // Unlike `inset`, this stays stable when Android pans the visual viewport
  // over a focused field. Booking uses it only for scrollable bottom space.
  const keyboardHeight = Math.max(0, Math.round(window.innerHeight - vv.height));
  if (inset === lastInset && keyboardHeight === lastKeyboardHeight) return;
  const insetChanged = inset !== lastInset;
  lastInset = inset;
  lastKeyboardHeight = keyboardHeight;

  const root = document.documentElement;
  root.style.setProperty('--keyboard-inset', `${inset}px`);
  root.style.setProperty('--booking-keyboard-height', `${keyboardHeight}px`);
  // A separate class from the existing `keyboard-active`, which CustomerLayout
  // derives from focus events. Two writers on one class would fight: a
  // focusout fires while the keyboard is still on screen. This one is measured
  // rather than inferred, so rules that must be exact key off it instead.
  document.body.classList.toggle('keyboard-open', inset > 0);

  if (insetChanged) subscribers.forEach((fn) => fn(inset));
};

const schedule = () => {
  if (frame) return;
  // rAF-batched: a keyboard animating in fires a burst of resize events, and
  // the custom property only needs writing once per frame.
  frame = requestAnimationFrame(measure);
};

const attach = () => {
  const vv = window.visualViewport;
  if (attached || !vv) return;
  attached = true;
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  measure();
};

const detach = () => {
  const vv = window.visualViewport;
  if (!attached || !vv) return;
  attached = false;
  if (frame) { cancelAnimationFrame(frame); frame = 0; }
  vv.removeEventListener('resize', schedule);
  vv.removeEventListener('scroll', schedule);
  lastInset = -1;
  lastKeyboardHeight = -1;
  document.documentElement.style.removeProperty('--keyboard-inset');
  document.documentElement.style.removeProperty('--booking-keyboard-height');
  document.body.classList.remove('keyboard-open');
};

/**
 * Scroll a focused field outside booking above the keyboard, but only when
 * the keyboard is actually covering it.
 *
 * On other pages, the browser can leave a field behind the keyboard under
 * `resizes-visual`. This checks against the visual viewport and moves only a
 * covered field. Booking is handled by native focus panning plus stable page
 * padding: a second scroll during a viewport animation yanks the field away.
 */
export const scrollFocusedFieldIntoView = () => {
  const vv = window.visualViewport;
  const el = document.activeElement;
  if (!vv || !el || el === document.body) return;

  const isField = el.matches?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
  if (!isField) return;

  // On Android, the browser has already panned the focused booking field into
  // view. Scrolling the page again on each visual viewport event makes it
  // oscillate while the keyboard is still open (including while typing).
  if (el.closest('.booking-page')) return;

  const rect = el.getBoundingClientRect();
  const visibleBottom = vv.offsetTop + vv.height;
  // A little breathing room so the field is not flush against the keyboard.
  const covered = rect.bottom > visibleBottom - 8;
  if (!covered) return;

  el.scrollIntoView({ block: 'center', behavior: 'auto' });
};

/**
 * @param {(inset: number) => void} [onChange] called with the new inset in px,
 *   only when it changes.
 */
const useKeyboardInset = (onChange) => {
  // Kept in a ref so a caller can pass an inline arrow without re-subscribing
  // on every render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const notify = (inset) => onChangeRef.current?.(inset);
    subscribers.add(notify);
    attach();

    return () => {
      subscribers.delete(notify);
      if (subscribers.size === 0) detach();
    };
  }, []);
};

export default useKeyboardInset;
