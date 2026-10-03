import { quoteFilterValue } from './queryFilters';

/**
 * Read a complete created_at/id ordered history without relying on the server's
 * response cap. Keyset pagination also avoids offset shifts when newer rows
 * arrive or earlier rows are deleted during a read. Every page has the same
 * filters and authorization; an error on any page rejects the entire read.
 */
export const fetchAllOrderedRows = async (buildQuery, { ascending = false, searchFilter = '' } = {}) => {
  const rows = [];
  let cursor = null;

  while (true) {
    let query = buildQuery()
      .order('created_at', { ascending, nullsFirst: !ascending })
      .order('id', { ascending })
      .limit(500);

    let cursorFilter = '';
    if (cursor) {
      const comparison = ascending ? 'gt' : 'lt';
      const id = quoteFilterValue(cursor.id);
      if (cursor.created_at === null) {
        cursorFilter = `and(created_at.is.null,id.${comparison}.${id})`;
        if (!ascending) cursorFilter += ',created_at.not.is.null';
      } else {
        const date = quoteFilterValue(cursor.created_at);
        cursorFilter = `created_at.${comparison}.${date},and(created_at.eq.${date},id.${comparison}.${id})`;
        if (ascending) cursorFilter += ',created_at.is.null';
      }
    }
    // Calling .or() twice replaces its URL parameter. Combine the search and
    // cursor in one expression so subsequent pages keep the original search.
    const filter = searchFilter && cursorFilter
      ? `and(or(${searchFilter}),or(${cursorFilter}))`
      : searchFilter || cursorFilter;
    if (filter) query = query.or(filter);

    const { data, error } = await query;
    if (error) throw error;
    const batch = data || [];
    if (batch.length === 0) return rows;

    const next = batch[batch.length - 1];
    if (!next.id || next.created_at === undefined || (cursor && next.id === cursor.id && next.created_at === cursor.created_at)) {
      throw new Error('Could not load the complete history. Please try again.');
    }
    rows.push(...batch);
    cursor = { id: next.id, created_at: next.created_at };
  }
};
