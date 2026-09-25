// Google Maps search link for a hub address, used by the About page's
// "Visit Our Hubs" block and the public footer so both open the same place.
export const getGoogleMapsSearchUrl = (address) => (
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address?.trim() || '')}`
);
