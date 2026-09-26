import { Share2 } from 'lucide-react';
import { useToast } from '../../hooks/useToast';

/**
 * Icon button beside a tracking number, the partner of CopyButton (same
 * .copy-btn styling). Opens the device share sheet with the public tracking
 * link, the same link the Track page shares; where there is no share sheet
 * it copies the link instead.
 */
const ShareButton = ({ trackingNumber, className = '' }) => {
  const toast = useToast();

  const handleShare = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!trackingNumber) return;
    // The link reopens the Track page with the number filled in (?q= is read on load).
    const url = `${window.location.origin}/track?q=${encodeURIComponent(trackingNumber)}`;
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Track my CargoExpress PH shipment',
          text: `Tracking number: ${trackingNumber}`,
          url,
        });
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return; // the share sheet was closed
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Tracking link copied — paste it in Messenger or Viber');
    } catch {
      toast.error('Could not share. Copy the tracking number instead.');
    }
  };

  return (
    <button
      type="button"
      className={`copy-btn ${className}`.trim()}
      onClick={handleShare}
      aria-label="Share tracking link"
      title="Share tracking link"
    >
      <Share2 size={16} aria-hidden="true" />
    </button>
  );
};

export default ShareButton;
