import { useEffect } from 'react';

/**
 * useScrollLock — freezes background page scroll while an overlay is open.
 *
 * Why this is not just `body { overflow: hidden }`:
 *
 *  1. iOS Safari ignores `overflow: hidden` on <body>. Pinning the body with
 *     `position: fixed` and offsetting it by the current scroll position is
 *     the only reliable way to stop the page moving underneath a modal.
 *  2. Hiding a desktop scrollbar reflows the page ~15px wider. We add matching
 *     padding-right so nothing shifts as the modal opens.
 *  3. Modals stack (ConfirmModal opens on top of TripReassignModal, and the
 *     booking-form blocker opens over the page). A naive lock/unlock pair would
 *     let the inner modal closing unlock scroll while the outer one is still
 *     open, so the lock is reference-counted at module scope.
 *  4. base.css sets `html { scroll-behavior: smooth }`. Restoring the scroll
 *     offset on release would animate, which reads as the page lurching. We
 *     suppress it for the duration of the restore.
 *
 * @param {boolean} active - lock while true; release when false or unmounted.
 */

let lockCount = 0;
let savedScrollY = 0;
let savedPath = '';
let savedInline = null;

const applyLock = () => {
  const body = document.body;
  savedScrollY = window.scrollY || window.pageYOffset || 0;
  // Remembered so we do not restore a stale offset onto a different page —
  // see the note in releaseLock().
  savedPath = window.location.pathname;

  // Width of the scrollbar that is about to disappear (0 on overlay-scrollbar
  // platforms such as iOS/Android, non-zero on classic desktop browsers).
  const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;

  savedInline = {
    position: body.style.position,
    top: body.style.top,
    left: body.style.left,
    right: body.style.right,
    width: body.style.width,
    overflow: body.style.overflow,
    paddingRight: body.style.paddingRight,
  };

  body.style.position = 'fixed';
  body.style.top = `-${savedScrollY}px`;
  body.style.left = '0';
  body.style.right = '0';
  body.style.width = '100%';
  body.style.overflow = 'hidden';

  if (scrollbarWidth > 0) {
    const existing = parseFloat(window.getComputedStyle(body).paddingRight) || 0;
    body.style.paddingRight = `${existing + scrollbarWidth}px`;
  }
};

const releaseLock = () => {
  const body = document.body;
  const root = document.documentElement;

  if (savedInline) {
    body.style.position = savedInline.position;
    body.style.top = savedInline.top;
    body.style.left = savedInline.left;
    body.style.right = savedInline.right;
    body.style.width = savedInline.width;
    body.style.overflow = savedInline.overflow;
    body.style.paddingRight = savedInline.paddingRight;
    savedInline = null;
  }

  // Only restore the offset if we are still on the page that was locked.
  // Some overlays navigate and *then* close — CommandPalette does
  // `navigate(cmd.to); onClose();`, and the logout ConfirmModal closes after
  // navigate('/login'). Restoring there would scroll the freshly-opened page
  // down to the previous page's offset and fight the router's scroll-to-top.
  if (window.location.pathname === savedPath) {
    const previousBehavior = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    window.scrollTo(0, savedScrollY);
    root.style.scrollBehavior = previousBehavior;
  }
};

const useScrollLock = (active = true) => {
  useEffect(() => {
    if (!active) return undefined;

    if (lockCount === 0) applyLock();
    lockCount += 1;

    return () => {
      lockCount = Math.max(0, lockCount - 1);
      if (lockCount === 0) releaseLock();
    };
  }, [active]);
};

export default useScrollLock;
