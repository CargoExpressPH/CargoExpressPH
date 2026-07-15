import { useEffect, useRef } from 'react';

/**
 * FocusTrap — Traps keyboard focus within a container.
 * 
 * Usage:
 *   <FocusTrap active={isOpen}>
 *     <div className="modal">...</div>
 *   </FocusTrap>
 *
 * When active, Tab and Shift+Tab cycle only through focusable elements
 * inside the trap. Focus is restored to the previously focused element
 * when the trap deactivates.
 */
const FocusTrap = ({ children, active = true }) => {
  const trapRef = useRef(null);
  const previousFocusRef = useRef(null);

  useEffect(() => {
    if (!active) return;

    // Save the currently focused element so we can restore it later
    previousFocusRef.current = document.activeElement;

    const trapElement = trapRef.current;
    if (!trapElement) return;

    // Focus the first focusable element inside the trap
    const focusableSelectors = [
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(', ');

    const focusableElements = trapElement.querySelectorAll(focusableSelectors);
    if (focusableElements.length > 0) {
      // Small delay to ensure the DOM is ready
      requestAnimationFrame(() => {
        focusableElements[0].focus();
      });
    }

    const handleKeyDown = (e) => {
      if (e.key !== 'Tab') return;

      const focusable = trapElement.querySelectorAll(focusableSelectors);
      if (focusable.length === 0) return;

      const firstElement = focusable[0];
      const lastElement = focusable[focusable.length - 1];

      if (e.shiftKey) {
        // Shift+Tab: if we're at the first element, wrap to last
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement.focus();
        }
      } else {
        // Tab: if we're at the last element, wrap to first
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      // Restore focus to the previously focused element
      if (previousFocusRef.current && typeof previousFocusRef.current.focus === 'function') {
        previousFocusRef.current.focus();
      }
    };
  }, [active]);

  if (!active) return children;

  return (
    <div ref={trapRef}>
      {children}
    </div>
  );
};

export default FocusTrap;
