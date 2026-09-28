// Transport failures as they reach the booking pages: the fetch wrapper in
// lib/supabase.js ("HTTP Error 500: …"), browsers' offline errors ("Failed to
// fetch", Firefox "NetworkError", Safari "Load failed"), and aborts/timeouts.
const TRANSPORT_FAILURE = /^(?:error:\s*)?http error \d+|failed to fetch|networkerror|network request failed|load failed|abort|timed? ?out/i;

/**
 * The reason shown in the "we couldn't confirm your booking" notice.
 * Messages written for people (a route/province mismatch, a database rule's
 * explanation) pass through; transport failures become one plain sentence,
 * since "HTTP Error 500" tells a customer nothing they can act on. The toast
 * still carries the original text.
 */
export const describeBookingSaveError = (error) => {
  const message = String(error?.message || '').trim();
  if (!message || TRANSPORT_FAILURE.test(message)) {
    return 'The connection to our server failed while saving.';
  }
  return message;
};
