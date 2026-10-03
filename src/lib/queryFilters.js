// PostgREST's OR grammar treats commas, parentheses and quotes as syntax.
// Quote each value, escaping its quotes/backslashes, while preserving the
// existing ILIKE pattern semantics (including user-supplied wildcards).
export const quoteFilterValue = (value) =>
  `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export const containsFilter = (column, value) =>
  `${column}.ilike.${quoteFilterValue(`%${value}%`)}`;
