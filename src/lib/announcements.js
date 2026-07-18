import { Zap, Calendar, AlertTriangle, Bell, Megaphone } from 'lucide-react';

export const ANNOUNCEMENT_CATEGORIES = [
  { value: 'auto', label: '🤖 Auto-Detect (Smart Category)', emoji: '' },
  { value: 'schedule', label: '🚢 Schedule Update', emoji: '🚢' },
  { value: 'promo', label: '⚡ Special Promo', emoji: '⚡' },
  { value: 'advisory', label: '⚠️ Safety Advisory', emoji: '⚠️' },
  { value: 'service', label: '📞 Service Notice', emoji: '📞' },
  { value: 'general', label: '📢 General Update', emoji: '📢' },
];

/**
 * Resolves category metadata (label, icon, colors) for any announcement.
 * Checks explicit category markers (emojis/tags) first, then falls back to keyword matching.
 */
export const getAnnouncementCategoryInfo = (announcement) => {
  const title = (announcement?.title || '').trim();
  const text = `${announcement?.title || ''} ${announcement?.content || ''}`.toLowerCase();

  // 1. Explicit Category Marker Check
  if (title.includes('⚡') || text.includes('[promo]')) {
    return {
      label: 'Special Promo',
      icon: Zap,
      accentColor: 'var(--success)',
      badgeBg: 'color-mix(in srgb, var(--success) 14%, transparent)',
      badgeColor: 'var(--success)'
    };
  }
  if (title.includes('🚢') || text.includes('[schedule]')) {
    return {
      label: 'Schedule Update',
      icon: Calendar,
      accentColor: 'var(--info)',
      badgeBg: 'color-mix(in srgb, var(--info) 14%, transparent)',
      badgeColor: 'var(--info)'
    };
  }
  if (title.includes('⚠️') || text.includes('[advisory]')) {
    return {
      label: 'Safety Advisory',
      icon: AlertTriangle,
      accentColor: 'var(--warning)',
      badgeBg: 'color-mix(in srgb, var(--warning) 14%, transparent)',
      badgeColor: 'var(--warning)'
    };
  }
  if (title.includes('📞') || title.includes('🔔') || text.includes('[notice]')) {
    return {
      label: 'Service Notice',
      icon: Bell,
      accentColor: 'var(--chart-purple)',
      badgeBg: 'color-mix(in srgb, var(--chart-purple) 14%, transparent)',
      badgeColor: 'var(--chart-purple)'
    };
  }
  if (title.includes('📢') || text.includes('[general]')) {
    return {
      label: 'General Update',
      icon: Megaphone,
      accentColor: 'var(--primary)',
      badgeBg: 'color-mix(in srgb, var(--primary) 14%, transparent)',
      badgeColor: 'var(--primary)'
    };
  }

  // 2. Keyword Auto-Detection Fallback
  const wordMatch = (word) => new RegExp(`\\b${word}\\b`, 'i').test(text);

  if (text.includes('gcash') || text.includes('paymongo') || text.includes('promo') || text.includes('discount') || wordMatch('free') || wordMatch('off') || text.includes('payment')) {
    return {
      label: 'Special Promo',
      icon: Zap,
      accentColor: 'var(--success)',
      badgeBg: 'color-mix(in srgb, var(--success) 14%, transparent)',
      badgeColor: 'var(--success)'
    };
  }

  if (text.includes('schedule') || text.includes('vessel') || text.includes('cut-off') || text.includes('departure') || text.includes('sailing') || wordMatch('port')) {
    return {
      label: 'Schedule Update',
      icon: Calendar,
      accentColor: 'var(--info)',
      badgeBg: 'color-mix(in srgb, var(--info) 14%, transparent)',
      badgeColor: 'var(--info)'
    };
  }

  if (text.includes('weather') || text.includes('typhoon') || text.includes('advisory') || text.includes('delay') || text.includes('caution') || text.includes('protocol') || text.includes('swell')) {
    return {
      label: 'Safety Advisory',
      icon: AlertTriangle,
      accentColor: 'var(--warning)',
      badgeBg: 'color-mix(in srgb, var(--warning) 14%, transparent)',
      badgeColor: 'var(--warning)'
    };
  }

  if (text.includes('support') || text.includes('chat') || text.includes('24/7') || text.includes('virtual') || text.includes('assistant') || text.includes('contact') || wordMatch('line')) {
    return {
      label: 'Service Notice',
      icon: Bell,
      accentColor: 'var(--chart-purple)',
      badgeBg: 'color-mix(in srgb, var(--chart-purple) 14%, transparent)',
      badgeColor: 'var(--chart-purple)'
    };
  }

  return {
    label: 'General Update',
    icon: Megaphone,
    accentColor: 'var(--primary)',
    badgeBg: 'color-mix(in srgb, var(--primary) 14%, transparent)',
    badgeColor: 'var(--primary)'
  };
};
