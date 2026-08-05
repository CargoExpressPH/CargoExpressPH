import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { getCustomerUnreadChatCount } from '../lib/database';

/**
 * useCustomerChatUnread — real-time count of unread ADMIN messages in the
 * customer's conversations. Refetches on every INSERT/UPDATE of an admin
 * message (new replies bump it, marking messages read clears it).
 */
export const useCustomerChatUnread = (userId) => {
  const [count, setCount] = useState(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    if (!userId) return;
    mountedRef.current = true;

    const refresh = async () => {
      try {
        const value = await getCustomerUnreadChatCount(userId);
        if (mountedRef.current) setCount(value);
      } catch (err) {
        // Keep the last known count on transient errors — but say so. A fully
        // silent catch here is what hid a permanent TypeError in the query and
        // pinned this badge at 0 without anyone noticing.
        console.warn('[chat-unread] count failed:', err?.message || err);
      }
    };

    refresh();

    const channel = supabase
      .channel(`customer_chat_unread_${userId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'chat_messages',
        filter: 'sender_role=eq.admin',
      }, refresh)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'chat_messages',
        filter: 'sender_role=eq.admin',
      }, refresh)
      .subscribe();

    return () => {
      mountedRef.current = false;
      supabase.removeChannel(channel);
    };
  }, [userId]);

  return count;
};
