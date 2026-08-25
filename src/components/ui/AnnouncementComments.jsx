import { useState } from 'react';
import { Loader, MessageSquare, Send } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { addAnnouncementComment } from '../../lib/database';
import { useToast } from '../../hooks/useToast';
import MessageCustomerButton from './MessageCustomerButton';
import { formatPhDateTime } from '../../utils/datetime';

const MAX_COMMENT_LENGTH = 500;

/**
 * Turn a failed post into a sentence the customer can act on.
 *
 * Every branch says the comment was NOT posted, because that is the one thing
 * the person needs to know and the one thing a raw driver message never says
 * — "Failed to fetch" and "AbortError" both leave someone staring at an input
 * that still holds their text, unable to tell whether it went through.
 *
 * The SQLSTATEs are the ones `add_announcement_comment` raises deliberately;
 * PostgREST passes them through as `error.code`. Anything else is an unplanned
 * failure, and there the RPC's own message is more use than a guess, so it is
 * appended rather than swallowed.
 */
const describePostFailure = (e) => {
  const code = e?.code;
  if (code === '42501') return 'Your comment was not posted — your session has expired. Please sign in again.';
  if (code === '22023') return `Your comment was not posted — ${(e.message || 'it was rejected.').toLowerCase()}`;
  if (code === 'P0002') return 'Your comment was not posted — this announcement is no longer available.';

  // A dropped connection or a timeout from withTimeout: the request may or may
  // not have reached the database, so the honest instruction is to check
  // rather than to blindly resend.
  const message = e?.message || '';
  if (/fetch|network|timeout|abort/i.test(message)) {
    return 'Your comment was not posted — the connection dropped. Check your signal, then refresh before trying again.';
  }

  return `Your comment was not posted. ${message || 'Please try again.'}`;
};

/**
 * The comment thread under an announcement — one component for all three
 * surfaces (customer feed card, customer notification modal, admin list) so
 * the posting path and the empty state cannot drift apart between them.
 *
 * Two things it deliberately does not do:
 *
 * - It does not write the comment locally and then reconcile. The RPC returns
 *   the announcement's whole array as the database now holds it, so the reply
 *   is what we render: a comment somebody else posted while this one was being
 *   typed appears at the same moment, and nothing has to be merged by hand.
 * - It does not render the "message this customer" control for a customer.
 *   There is no customer-to-customer chat, so the button would open an admin
 *   route they cannot reach. The admin's own comments are exempt too — the
 *   inbox has no thread for talking to yourself.
 *
 * `onCommentsChange` hands the fresh array back to the owner of the
 * announcement object so a parent list stays in step without a refetch.
 */
const AnnouncementComments = ({ announcementId, comments, onCommentsChange }) => {
  const { user, isAdmin } = useAuth();
  const toast = useToast();
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);

  // The column is nullable and rows created before the migration have no
  // array at all — treat both as "no comments yet" rather than crashing on
  // .map, which is what an unguarded read of a JSONB default does.
  const thread = Array.isArray(comments) ? comments : [];

  const handlePost = async () => {
    const body = text.trim();
    if (!body || posting) return;
    setPosting(true);
    try {
      const updated = await addAnnouncementComment(announcementId, body);
      setText('');
      onCommentsChange?.(Array.isArray(updated) ? updated : thread);
    } catch (e) {
      // The text is deliberately left in the input — setText('') runs only on
      // success. Clearing it here would destroy what they wrote at the exact
      // moment they have to type it again.
      toast.error(describePostFailure(e));
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="announcement-comments">
      <div className="announcement-comments-heading">
        <MessageSquare size={14} aria-hidden="true" />
        {thread.length === 0
          ? 'Comments'
          : `Comments (${thread.length})`}
      </div>

      {thread.length === 0 ? (
        <p className="announcement-comments-empty">
          No comments yet.
        </p>
      ) : (
        <ul className="announcement-comment-list">
          {thread.map((c, i) => (
            // Comments written before the id was stored, and any row hand-fixed
            // in SQL, can lack an id — fall back to the index rather than
            // collapsing every such comment onto one key.
            <li key={c.id || `${c.created_at}-${i}`} className="announcement-comment">
              <div className="announcement-comment-head">
                <span className="announcement-comment-author">{c.name || 'Customer'}</span>
                {isAdmin && c.user_id && c.user_id !== user?.id && (
                  <MessageCustomerButton customerId={c.user_id} customerName={c.name} />
                )}
                <span className="announcement-comment-time">
                  {c.created_at ? formatPhDateTime(c.created_at) : ''}
                </span>
              </div>
              <p className="announcement-comment-text">{c.text}</p>
            </li>
          ))}
        </ul>
      )}

      {user && (
        <div className="announcement-comment-form">
          <input
            type="text"
            className="form-input"
            value={text}
            maxLength={MAX_COMMENT_LENGTH}
            spellCheck="false"
            placeholder="Write a comment…"
            aria-label="Write a comment"
            onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handlePost(); } }}
            disabled={posting}
          />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={handlePost}
            disabled={posting || !text.trim()}
          >
            {posting
              ? <Loader size={14} className="animate-spin" aria-hidden="true" />
              : <Send size={14} aria-hidden="true" />}
            <span>Post</span>
          </button>
        </div>
      )}
    </div>
  );
};

export default AnnouncementComments;
