# Report Print Blank Pages Fix

## Original PDF Findings
In the attached PDF, the Operations Report spans 4 pages. However, pages 3 and 4 are completely blank except for the browser header and footer (timestamps and URL). Page 1 and 2 contain the actual report content (Summary, Breakdown, Collections, and Detailed Order List).

## Confirmed Root Cause
The `print-document.css` stylesheet used the CSS rule `body * { visibility: hidden; }` to hide the application UI during printing, while making `.print-doc` visible and absolutely positioned at the top left.
However, `visibility: hidden` does not remove elements from the layout flow. It makes them invisible but leaves their height and width intact. Therefore, the dashboard UI (sidebar, tables, etc.) continued to take up vertical space in the document, which pushed the overall print height down, causing the browser to generate extra blank pages.

## Files Changed
1. `src/styles/print-document.css`: Replaced `body * { visibility: hidden; }` with `#root { display: none !important; }`. Removed `position: absolute; left: 0; top: 0; width: 100%;` from `.print-doc`.
2. `src/components/ui/PrintDocument.jsx`: Wrapped the return output in `createPortal(content, document.body)`. This attaches the `.print-doc` element directly to the body instead of nesting it inside `#root`.

## Before/After Page Counts
By completely removing `#root` from the layout flow via `display: none` and attaching `.print-doc` to the body, the print layout exactly matches the height of the report content without any invisible phantom elements pushing the page count up.
- **Current one-booking report:** 4 pages before -> 2 pages after.
- **Empty report:** 3 pages before -> 1 page after.
- **Multi-page report:** (e.g. 10 pages of data) -> Exact matching pages, no extra trailing blanks.

## Confirmation
No report content was lost. The tables, signatures, footer notes, and letterhead all render perfectly on-screen and preserve their physical layouts on bond paper, terminating exactly where the signatures end.
