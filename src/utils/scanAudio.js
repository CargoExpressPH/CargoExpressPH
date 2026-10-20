// Synthesizes scanner audio feedback using the Web Audio API.
// Pure browser API — no external audio files required, zero latency,
// works reliably offline and across PWAs and mobile browsers.

let audioCtx = null;
let isMuted = false;

const getAudioContext = () => {
  if (typeof window === 'undefined') return null;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!audioCtx) {
    try {
      audioCtx = new AudioContextClass();
    } catch {
      return null;
    }
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
};

/** Toggle or set mute state for scanner beeps */
export const setScanAudioMuted = (muted) => {
  isMuted = Boolean(muted);
};

export const isScanAudioMuted = () => isMuted;

/** Triggers device haptic feedback if supported */
export const triggerHaptic = (pattern = 60) => {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(pattern);
    } catch {
      /* ignore vibration errors */
    }
  }
};

/**
 * Plays a pleasant ascending dual-tone chime for a successful box verification.
 * 880Hz (A5) -> 1760Hz (A6).
 */
export const playScanSuccessSound = () => {
  triggerHaptic(50);
  if (isMuted) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;

    // Tone 1: 880Hz (bright ping)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(880, now);
    gain1.gain.setValueAtTime(0.18, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.12);

    // Tone 2: 1760Hz (crisp confirmation)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(1760, now + 0.08);
    gain2.gain.setValueAtTime(0.22, now + 0.08);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.08);
    osc2.stop(now + 0.22);
  } catch {
    /* audio failure is never fatal */
  }
};

/**
 * Plays a low warning buzz for foreign cargo (package not in this trip) or bad QR.
 * 220Hz saw-tooth wave with dual pulses.
 */
export const playScanErrorSound = () => {
  triggerHaptic([100, 60, 100]);
  if (isMuted) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.setValueAtTime(165, now + 0.12);

    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.28);
  } catch {
    /* audio failure is never fatal */
  }
};

/**
 * Plays a harsh descending triple-buzz for a box that belongs to a different
 * trip. Deliberately longer and lower than the plain error tone so a driver
 * can tell "wrong route" from "bad QR" without looking at the screen.
 */
export const playWrongRouteSound = () => {
  triggerHaptic([200, 80, 200, 80, 320]);
  if (isMuted) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;
    [0, 0.22, 0.44].forEach((offset, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(196 - i * 22, now + offset);
      gain.gain.setValueAtTime(0.18, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.18);
    });
  } catch {
    /* audio failure is never fatal */
  }
};

/**
 * Plays a gentle double-pip for an already-scanned box.
 * 587Hz (D5) -> 587Hz.
 */
export const playScanDuplicateSound = () => {
  triggerHaptic(30);
  if (isMuted) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;

    const playPip = (offset) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(587.33, now + offset);
      gain.gain.setValueAtTime(0.15, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.07);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.07);
    };

    playPip(0);
    playPip(0.1);
  } catch {
    /* audio failure is never fatal */
  }
};

/**
 * Plays a triumphant celebratory chord when all trip cargo is verified.
 * C5 - E5 - G5 - C6 arpeggio.
 */
export const playScanCompleteSound = () => {
  triggerHaptic([80, 50, 80, 50, 150]);
  if (isMuted) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const freqs = [523.25, 659.25, 783.99, 1046.5];
    const now = ctx.currentTime;

    freqs.forEach((freq, idx) => {
      const startTime = now + idx * 0.08;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, startTime);
      gain.gain.setValueAtTime(0.18, startTime);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.35);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startTime);
      osc.stop(startTime + 0.35);
    });
  } catch {
    /* audio failure is never fatal */
  }
};
