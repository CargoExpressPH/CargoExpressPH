// Why a box was verified without a camera scan. The first four are what the
// courier picks in "Can't Scan QR?"; the last two are set by the app itself.
// Must match the CHECK on box_scan_events.reason.
export const MANUAL_SCAN_REASONS = [
  { value: 'torn_label', label: 'Torn label' },
  { value: 'wet_smudged', label: 'Wet / smudged' },
  { value: 'low_light', label: 'Low light' },
  { value: 'camera_issue', label: 'Camera issue' },
];

export const MANUAL_SCAN_REASON_LABELS = {
  ...Object.fromEntries(MANUAL_SCAN_REASONS.map((r) => [r.value, r.label])),
  unidentified_label: 'Unidentified label',
  other: 'Other',
};
