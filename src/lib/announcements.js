import { Zap, Calendar, AlertTriangle, Bell, Megaphone, Sparkles } from 'lucide-react';

export const ANNOUNCEMENT_CATEGORIES = [
  { value: 'auto', label: 'Auto-Detect (Smart Category)', icon: Sparkles, emoji: '' },
  { value: 'schedule', label: 'Schedule Update', icon: Calendar, emoji: '🚢' },
  { value: 'promo', label: 'Special Promo', icon: Zap, emoji: '⚡' },
  { value: 'advisory', label: 'Safety Advisory', icon: AlertTriangle, emoji: '⚠️' },
  { value: 'service', label: 'Service Notice', icon: Bell, emoji: '📞' },
  { value: 'general', label: 'General Update', icon: Megaphone, emoji: '📢' },
];

const CATEGORY_EMOJI_PREFIX = new RegExp(
  `^\\s*(?:${ANNOUNCEMENT_CATEGORIES.filter(c => c.emoji).map(c => c.emoji).concat('🔔').join('|')})\\uFE0F?\\s*`,
  'u',
);

/**
 * The title as a customer should read it. An explicit category is stored as
 * an emoji at the front of the title (see AnnouncementsPage), and the category
 * badge already shows it — keeping it in the title printed the same marker
 * twice. Only the display changes; getAnnouncementCategoryInfo still reads the
 * stored title.
 */
export const announcementDisplayTitle = (title) => {
  const raw = String(title || '');
  return raw.replace(CATEGORY_EMOJI_PREFIX, '').trim() || raw.trim();
};

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
      badgeColor: 'var(--success-text)'
    };
  }
  if (title.includes('🚢') || text.includes('[schedule]')) {
    return {
      label: 'Schedule Update',
      icon: Calendar,
      accentColor: 'var(--info)',
      badgeBg: 'color-mix(in srgb, var(--info) 14%, transparent)',
      badgeColor: 'var(--info-text)'
    };
  }
  if (title.includes('⚠️') || text.includes('[advisory]')) {
    return {
      label: 'Safety Advisory',
      icon: AlertTriangle,
      accentColor: 'var(--warning)',
      badgeBg: 'color-mix(in srgb, var(--warning) 14%, transparent)',
      badgeColor: 'var(--warning-text)'
    };
  }
  if (title.includes('📞') || title.includes('🔔') || text.includes('[notice]')) {
    return {
      label: 'Service Notice',
      icon: Bell,
      accentColor: 'var(--chart-1)',
      badgeBg: 'color-mix(in srgb, var(--chart-1) 14%, transparent)',
      badgeColor: 'var(--chart-purple-text)'
    };
  }
  if (title.includes('📢') || text.includes('[general]')) {
    return {
      label: 'General Update',
      icon: Megaphone,
      accentColor: 'var(--primary)',
      badgeBg: 'color-mix(in srgb, var(--primary) 14%, transparent)',
      badgeColor: 'var(--primary-text)'
    };
  }

  // 2. Keyword Auto-Detection Fallback
  const wordMatch = (word) => new RegExp(`\\b${word}\\b`, 'i').test(text);
  // `\b` treats a hyphen as a word edge, so wordMatch('off') matched the "off"
  // in "cut-off" and tagged every booking cut-off notice as a promo. The
  // promo words only count on their own ("10% off", "free delivery"), not
  // inside cut-off, drop-off or toll-free. No lookbehind: iOS Safari before
  // 16.4 throws on one, and this runs while the page renders.
  const standaloneWord = (word) => new RegExp(`(?:^|[^\\w-])${word}(?![\\w-])`, 'i').test(text);

  if (text.includes('gcash') || text.includes('paymongo') || text.includes('promo') || text.includes('discount') || standaloneWord('free') || standaloneWord('off') || text.includes('payment')) {
    return {
      label: 'Special Promo',
      icon: Zap,
      accentColor: 'var(--success)',
      badgeBg: 'color-mix(in srgb, var(--success) 14%, transparent)',
      badgeColor: 'var(--success-text)'
    };
  }

  if (text.includes('schedule') || text.includes('vessel') || text.includes('cut-off') || text.includes('departure') || text.includes('sailing') || wordMatch('port')) {
    return {
      label: 'Schedule Update',
      icon: Calendar,
      accentColor: 'var(--info)',
      badgeBg: 'color-mix(in srgb, var(--info) 14%, transparent)',
      badgeColor: 'var(--info-text)'
    };
  }

  if (text.includes('weather') || text.includes('typhoon') || text.includes('advisory') || text.includes('delay') || text.includes('caution') || text.includes('protocol') || text.includes('swell')) {
    return {
      label: 'Safety Advisory',
      icon: AlertTriangle,
      accentColor: 'var(--warning)',
      badgeBg: 'color-mix(in srgb, var(--warning) 14%, transparent)',
      badgeColor: 'var(--warning-text)'
    };
  }

  if (text.includes('support') || text.includes('chat') || text.includes('24/7') || text.includes('virtual') || text.includes('assistant') || text.includes('contact') || wordMatch('line')) {
    return {
      label: 'Service Notice',
      icon: Bell,
      accentColor: 'var(--chart-1)',
      badgeBg: 'color-mix(in srgb, var(--chart-1) 14%, transparent)',
      badgeColor: 'var(--chart-purple-text)'
    };
  }

  return {
    label: 'General Update',
    icon: Megaphone,
    accentColor: 'var(--primary)',
    badgeBg: 'color-mix(in srgb, var(--primary) 14%, transparent)',
    badgeColor: 'var(--primary-text)'
  };
};
