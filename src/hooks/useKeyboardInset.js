import { useEffect, useRef } from 'react';

/**
 * Publishes the height of the on-screen keyboard as `--keyboard-inset` on
 * <html>, in pixels, and calls `onChange` when it moves.
 *
 * WHY THIS IS NEEDED AT ALL
 *
 * index.html declares `interactive-widget=resizes-visual`. Under that mode —
 * the default in Chrome since 108 — the Android keyboard resizes only the
 * VISUAL viewport. The layout viewport does not move, and neither does
 * `100dvh`: `dvh` tracks the *layout* viewport, so "dynamic" here means
 * dynamic with respect to the collapsing URL bar, not with respect to the
 * keyboard. Every height in the chat layout is therefore still measured
 * against the full screen while the bottom third of that screen is covered,
 * which is exactly how the composer ended up underneath the keyboard.
 *
 * Switching the meta to `interactive-widget=resizes-content` would make `dvh`
 * shrink and fix this in one line — but it changes the behaviour of every
 * fixed element on every page (the bottom tab bar most of all), and the app's
 * whole `keyboard-active` mechanism was built around the current mode. This
 * hook is the same fix scoped to the one screen that needs it.
 *
 * `visualViewport.offsetTop` is part of the arithmetic on purpose: when the
 * browser scrolls the visual viewport to keep a focused field in sight, the
 * keyboard's height alone no longer describes how much of the layout viewport
 * is hidden below the fold.
 *
 * Reads are rAF-batched, so a resize burst (the keyboard animating in, an
 * orientation change) writes the custom property once per frame rather than
 * once per event.
 *
 * @param {(inset: number) => void} [onChange] called with the new inset in px,
 *   only when it actually changes.
 */
const useKeyboardInset = (onChange) => {
  // Kept in a ref so a caller can pass an inline arrow without re-subscribing
  // the listeners on every render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    if (!vv) return undefined;

    let frame = 0;
    let last = -1;

    const measure = () => {
      frame = 0;
      // What the keyboard (or any other interactive widget) hides at the
      // bottom of the layout viewport.
      const hidden = window.innerHeight - vv.height - vv.offsetTop;
      // Small negative values show up mid-animation and on desktop zoom.
      const inset = Math.max(0, Math.round(hidden));
      if (inset === last) return;
      last = inset;
      root.style.setProperty('--keyboard-inset', `${inset}px`);
      onChangeRef.current?.(inset);
    };

    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(measure);
    };

    measure();
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
      // Leaving a stale inset behind would shorten every other page that ever
      // reads this variable.
      root.style.removeProperty('--keyboard-inset');
    };
  }, []);
};

export default useKeyboardInset;
