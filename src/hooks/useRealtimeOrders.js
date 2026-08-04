import { useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';

/**
 * Subscribe to `orders` changes and deliver them in debounced batches.
 *
 * WHY BATCHED, not one callback per event:
 *   A single admin action fans out into many row updates — assigning a trip
 *   touches every order on it, and `updateTrip`'s status cascade rewrites the
 *   whole manifest at once. PayMongo webhooks also arrive in bursts when
 *   several customers pay together. Refetching per event would hammer the
 *   database and make the table flicker; coalescing a burst into one callback
 *   costs a fraction of a second of staleness and nothing else.
 *
 * WHY `orders` and not `payment_transactions`:
 *   The ledger table is not in the supabase_realtime publication, but
 *   update_order_payment_totals writes derived totals back to `orders` on
 *   every ledger row. Subscribing here therefore catches every payment,
 *   including ones reconciled by the webhook on a different device.
 *
 * Realtime respects RLS, so an admin session receives all orders and a
 * customer session would receive only their own.
 *
 * @param {Object}   options
 * @param {boolean}  options.enabled     subscribe only while true
 * @param {string}   options.channelName unique per page; suffixed with the user id
 * @param {string}   options.userId      namespaces the channel per user
 * @param {number}   options.debounceMs  quiet period before flushing a batch
 * @param {Function} options.onBatch     called with the accumulated payloads
 */
const useRealtimeOrders = ({
  enabled = true,
  channelName,
  userId,
  debounceMs = 800,
  onBatch,
}) => {
  // Held in a ref so a new inline callback on every render does not tear down
  // and rebuild the WebSocket subscription.
  const onBatchRef = useRef(onBatch);
  onBatchRef.current = onBatch;

  const pendingRef = useRef([]);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!enabled || !userId) return undefined;

    const flush = () => {
      timerRef.current = null;
      const batch = pendingRef.current;
      pendingRef.current = [];
      if (batch.length > 0) onBatchRef.current?.(batch);
    };

    const channel = supabase
      .channel(`${channelName}_${userId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'orders',
      }, (payload) => {
        pendingRef.current.push(payload);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(flush, debounceMs);
      })
      .subscribe();

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      pendingRef.current = [];
      supabase.removeChannel(channel);
    };
  }, [enabled, channelName, userId, debounceMs]);
};

export default useRealtimeOrders;
