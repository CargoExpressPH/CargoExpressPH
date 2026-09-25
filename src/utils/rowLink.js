/**
 * Makes a whole table row (or compact mobile card) open a page, not only the
 * link inside it.
 *
 * The row keeps its real <Link> for keyboard and screen-reader users, and for
 * middle-click into a new tab; this only widens the mouse/touch target.
 * Clicks that land on the row's own links, buttons or form fields are left to
 * them, and so is a drag that selected text (copying a tracking number must
 * not navigate away).
 */
export const rowLinkProps = (navigate, to) => ({
  className: 'row-link',
  onClick: (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.target.closest('a, button, input, select, textarea, label, [role="button"], [role="option"]')) return;
    if (window.getSelection?.()?.toString()) return;
    if (event.metaKey || event.ctrlKey) {
      window.open(to, '_blank', 'noopener');
      return;
    }
    navigate(to);
  },
});
