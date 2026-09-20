import { useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';

const RETRYABLE_STATUSES = new Set(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED']);

/**
 * Refreshes one protected order when its authoritative totals change. The
 * payment ledger remains private: the database trigger updates `orders`, and
 * the caller refetches payment history through its existing RLS-protected
 * database helpers.
 */
const useOrderPaymentRealtime = (orderId, onChange, enabled = true) => {
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!enabled || !orderId) return undefined;

    let disposed = false;
    let reconnectTimer = null;
    let retryCount = 0;
    let channel = null;

    const notify = (reason) => {
      if (!disposed) onChangeRef.current?.(reason);
    };

    const clearReconnect = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== null) return;
      const delay = Math.min(30000, 1000 * (2 ** Math.min(retryCount, 5)));
      retryCount += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (disposed) return;
      clearReconnect();
      if (channel) {
        const oldChannel = channel;
        channel = null;
        void supabase.removeChannel(oldChannel);
      }

      const nextChannel = supabase
        .channel(`order_payment_detail_${orderId}_${Date.now()}`)
        .on('postgres_changes', {
          event: 'UPDATE',
          schema: 'public',
          table: 'orders',
          filter: `id=eq.${orderId}`,
        }, () => notify('order-update'))
        .subscribe((status) => {
          if (disposed || channel !== nextChannel) return;
          if (status === 'SUBSCRIBED') {
            retryCount = 0;
            notify('realtime-connected');
          } else if (RETRYABLE_STATUSES.has(status)) {
            channel = null;
            void supabase.removeChannel(nextChannel);
            scheduleReconnect();
          }
        });

      channel = nextChannel;
    };

    const refreshWhenActive = () => {
      if (document.visibilityState === 'visible') notify('page-active');
      if (!channel || !['joined', 'joining'].includes(channel.state)) scheduleReconnect();
    };

    connect();
    window.addEventListener('online', refreshWhenActive);
    window.addEventListener('focus', refreshWhenActive);
    document.addEventListener('visibilitychange', refreshWhenActive);

    return () => {
      disposed = true;
      clearReconnect();
      window.removeEventListener('online', refreshWhenActive);
      window.removeEventListener('focus', refreshWhenActive);
      document.removeEventListener('visibilitychange', refreshWhenActive);
      if (channel) {
        const lastChannel = channel;
        channel = null;
        void supabase.removeChannel(lastChannel);
      }
    };
  }, [orderId, enabled]);
};

export default useOrderPaymentRealtime;
