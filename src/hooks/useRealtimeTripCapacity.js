import { useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';

const RETRYABLE_STATUSES = new Set(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED']);
const REFRESH_POLL_MS = 45_000;
const MAX_REFRESH_POLL_MS = 5 * 60_000;
const EVENT_DEBOUNCE_MS = 650;

/**
 * Keep trip-capacity summaries fresh across trip edits and order assignment or
 * weight changes. `trips` is RLS-readable; `orders` events are still filtered
 * by the caller's normal RLS visibility. Periodic/focus refresh covers rows a
 * customer cannot see (other customers' bookings) without exposing them.
 */
const useRealtimeTripCapacity = (onRefresh, enabled = true) => {
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    if (!enabled) return undefined;

    let disposed = false;
    let channel = null;
    let reconnectTimer = null;
    let debounceTimer = null;
    let pollTimer = null;
    let retryCount = 0;
    let pollDelay = REFRESH_POLL_MS;
    const instanceId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const refresh = () => {
      if (disposed || document.visibilityState !== 'visible') return Promise.resolve(null);
      try {
        return Promise.resolve(onRefreshRef.current?.()).then((succeeded) => {
          if (succeeded === true) {
            pollDelay = REFRESH_POLL_MS;
            schedulePoll(REFRESH_POLL_MS);
          }
          return succeeded;
        }).catch(() => false);
      } catch {
        return Promise.resolve(false);
      }
    };

    const schedulePoll = (delay = pollDelay) => {
      if (disposed) return;
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      pollTimer = window.setTimeout(async () => {
        pollTimer = null;
        if (document.visibilityState !== 'visible') {
          schedulePoll(REFRESH_POLL_MS);
          return;
        }
        const succeeded = await refresh();
        pollDelay = succeeded === false
          ? Math.min(MAX_REFRESH_POLL_MS, Math.max(REFRESH_POLL_MS, pollDelay * 2))
          : REFRESH_POLL_MS;
        schedulePoll();
      }, delay);
    };

    const debounceRefresh = () => {
      if (disposed) return;
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        refresh();
      }, EVENT_DEBOUNCE_MS);
    };

    const clearReconnect = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    let connect;
    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== null) return;
      const delay = Math.min(30_000, 1_000 * (2 ** Math.min(retryCount, 5)));
      retryCount += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    connect = () => {
      if (disposed) return;
      clearReconnect();
      if (channel) {
        const previousChannel = channel;
        channel = null;
        void supabase.removeChannel(previousChannel);
      }

      const nextChannel = supabase
        .channel(`trip_capacity_${instanceId}`)
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'trips',
        }, debounceRefresh)
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'orders',
        }, debounceRefresh);
      channel = nextChannel;
      nextChannel.subscribe((status) => {
        if (disposed || channel !== nextChannel) return;
        if (status === 'SUBSCRIBED') {
          retryCount = 0;
          debounceRefresh();
        } else if (RETRYABLE_STATUSES.has(status)) {
          const failedChannel = channel;
          channel = null;
          if (failedChannel) void supabase.removeChannel(failedChannel);
          scheduleReconnect();
        }
      });
    };

    const refreshWhenActive = () => {
      if (document.visibilityState === 'visible') refresh();
      if (!channel || !['joined', 'joining'].includes(channel.state)) scheduleReconnect();
    };

    connect();
    schedulePoll();
    window.addEventListener('focus', refreshWhenActive);
    window.addEventListener('online', refreshWhenActive);
    document.addEventListener('visibilitychange', refreshWhenActive);

    return () => {
      disposed = true;
      clearReconnect();
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      window.removeEventListener('focus', refreshWhenActive);
      window.removeEventListener('online', refreshWhenActive);
      document.removeEventListener('visibilitychange', refreshWhenActive);
      if (channel) {
        const activeChannel = channel;
        channel = null;
        void supabase.removeChannel(activeChannel);
      }
    };
  }, [enabled]);
};

export default useRealtimeTripCapacity;
