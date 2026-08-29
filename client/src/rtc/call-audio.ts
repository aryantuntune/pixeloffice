// ---------------------------------------------------------------------------
// Synthesized Web Audio sound effects for calls (ringtone, join, leave).
// Complies with the Constitution: zero binary assets, procedural audio.
// ---------------------------------------------------------------------------

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AudioContextCtor = window.AudioContext;
  if (!AudioContextCtor) return null;
  if (!audioCtx) {
    try {
      audioCtx = new AudioContextCtor();
    } catch {
      return null;
    }
  }
  if (audioCtx.state === "suspended") {
    void audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

let ringTimer: number | null = null;
function playTone(freq: number, durationSec: number, delaySec = 0, type: OscillatorType = "sine", volume = 0.12): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const startTime = ctx.currentTime + delaySec;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, startTime);

    gain.gain.setValueAtTime(0.001, startTime);
    gain.gain.exponentialRampToValueAtTime(volume, startTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + durationSec);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(startTime);
    osc.stop(startTime + durationSec + 0.05);
  } catch {
    // Ignore audio playback errors (e.g. browser autoplay restrictions)
  }
}

export function startRingtone(): void {
  stopRingtone();
  const playChime = () => {
    playTone(587.33, 0.18, 0, "sine", 0.1); // D5
    playTone(880.0, 0.28, 0.2, "sine", 0.12); // A5
    playTone(1174.66, 0.35, 0.45, "sine", 0.1); // D6
  };
  playChime();
  if (typeof window !== "undefined") {
    ringTimer = window.setInterval(playChime, 2400);
  }
}

export function stopRingtone(): void {
  if (ringTimer !== null && typeof window !== "undefined") {
    window.clearInterval(ringTimer);
    ringTimer = null;
  }
}

export function playJoinTone(): void {
  stopRingtone();
  playTone(523.25, 0.12, 0, "sine", 0.1); // C5
  playTone(659.25, 0.12, 0.1, "sine", 0.12); // E5
  playTone(783.99, 0.22, 0.2, "sine", 0.15); // G5
}

export function playLeaveTone(): void {
  stopRingtone();
  playTone(783.99, 0.12, 0, "sine", 0.1); // G5
  playTone(659.25, 0.12, 0.09, "sine", 0.1); // E5
  playTone(523.25, 0.2, 0.18, "sine", 0.08); // C5
}
