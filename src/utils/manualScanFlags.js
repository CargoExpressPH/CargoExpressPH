// Review flags for a trip's box_scan_events. They only inform the admin; they
// never block a courier. Pure so the contract test can run it under Node.

export const MANUAL_RATE_THRESHOLD = 0.3; // more than 30% of the trip's boxes
export const BURST_COUNT = 3;             // this many manual verifications...
export const BURST_WINDOW_MS = 30 * 1000; // ...within this window

/**
 * @param {Array<{method: string, scanned_at: string}>} events  box_scan_events of one trip
 * @param {number} totalBoxes  boxes on the trip that need verifying
 * @returns {{manualCount: number, rate: number, flags: Array<{code: string, message: string}>}}
 */
export const summarizeManualScans = (events, totalBoxes) => {
  const manual = (events || [])
    .filter((e) => e.method === 'manual_fallback')
    .map((e) => new Date(e.scanned_at).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);

  const rate = totalBoxes > 0 ? manual.length / totalBoxes : 0;
  const flags = [];

  if (manual.length >= 2 && rate > MANUAL_RATE_THRESHOLD) {
    flags.push({
      code: 'high_manual_rate',
      message: `${Math.round(rate * 100)}% of this trip's boxes were verified manually.`,
    });
  }

  for (let i = 0; i + BURST_COUNT - 1 < manual.length; i += 1) {
    if (manual[i + BURST_COUNT - 1] - manual[i] <= BURST_WINDOW_MS) {
      flags.push({
        code: 'manual_burst',
        message: `${BURST_COUNT}+ boxes were verified manually within ${BURST_WINDOW_MS / 1000} seconds.`,
      });
      break;
    }
  }

  return { manualCount: manual.length, rate, flags };
};
