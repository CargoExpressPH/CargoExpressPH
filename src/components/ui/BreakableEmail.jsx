import { Fragment } from 'react';

/**
 * An email address that wraps after "@" and "." when it does not fit, rather
 * than mid-word ("cargoexpress.exa / mple"), which is where
 * `overflow-wrap: anywhere` alone breaks it. Splits with a capture group, not
 * a lookbehind, because regex lookbehind needs iOS 16.4.
 */
export default function BreakableEmail({ value }) {
  if (!value) return null;
  return value.split(/([@.])/).map((part, i) => (
    part === '@' || part === '.'
      ? <Fragment key={i}>{part}<wbr /></Fragment>
      : part
  ));
}
