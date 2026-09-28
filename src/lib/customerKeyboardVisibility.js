const TEXT_INPUT_TYPES = new Set([
  'text', 'search', 'password', 'email', 'tel', 'number', 'url',
  'date', 'time', 'datetime-local',
]);

export const isCustomerTypingField = (element) => Boolean(element && (
  element.tagName === 'TEXTAREA' || element.isContentEditable ||
  (element.tagName === 'INPUT' && TEXT_INPUT_TYPES.has(element.type))
));

// iOS can report innerHeight equal to visualViewport.height while its keyboard
// is still open. A viewport resize must never unhide navigation over a focused
// text field; focus owns this state and viewport changes may only restore it.
export const watchCustomerKeyboardVisibility = (win) => {
  const { document } = win;
  let blurTimer = 0;
  const syncFromFocus = () => {
    blurTimer = 0;
    document.body.classList.toggle('keyboard-active', isCustomerTypingField(document.activeElement));
  };
  const onFocusIn = (event) => {
    if (isCustomerTypingField(event.target)) {
      if (blurTimer) win.clearTimeout(blurTimer);
      blurTimer = 0;
      document.body.classList.add('keyboard-active');
    } else if (document.body.classList.contains('keyboard-active') && !blurTimer) {
      blurTimer = win.setTimeout(syncFromFocus, 350);
    }
  };
  const onFocusOut = () => {
    if (blurTimer) win.clearTimeout(blurTimer);
    // Keep the bar hidden through the keyboard's close animation and while
    // focus moves between fields. The timer checks the final focused element.
    blurTimer = win.setTimeout(syncFromFocus, 350);
  };
  const onViewportChange = () => {
    if (isCustomerTypingField(document.activeElement)) {
      document.body.classList.add('keyboard-active');
    }
  };

  win.addEventListener('focusin', onFocusIn);
  win.addEventListener('focusout', onFocusOut);
  win.visualViewport?.addEventListener('resize', onViewportChange);
  syncFromFocus();

  return () => {
    if (blurTimer) win.clearTimeout(blurTimer);
    win.removeEventListener('focusin', onFocusIn);
    win.removeEventListener('focusout', onFocusOut);
    win.visualViewport?.removeEventListener('resize', onViewportChange);
    document.body.classList.remove('keyboard-active');
  };
};
