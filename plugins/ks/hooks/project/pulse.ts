// The in-progress phase's dot in the project pane, as one Raster cell whose
// color breathes between a dim and a bright amber. The pane repaints only that
// cell (`$.ui.blit`) on a timer, so the rest of the pane never redraws for it.

export const PULSE_MS = 80
/** Frames in one breath: PULSE_MS × this ≈ 1.6s. */
export const PULSE_FRAMES = 20

const DIM = 0x78350f // amber-900
const BRIGHT = 0xfbbf24 // amber-400
const DEFAULT = 0x01000000 // the terminal's own background

function lerp(from: number, to: number, t: number): number {
  const channel = (shift: number): number => {
    const a = (from >> shift) & 0xff
    const b = (to >> shift) & 0xff
    return Math.round(a + (b - a) * t) << shift
  }
  return channel(16) | channel(8) | channel(0)
}

/** The dot's color at `frame`: a cosine ease, brightest at frame 0. */
export function pulseColor(frame: number): number {
  const t = (1 + Math.cos((2 * Math.PI * (frame % PULSE_FRAMES)) / PULSE_FRAMES)) / 2
  return lerp(DIM, BRIGHT, t)
}

/** One Raster cell, base64 as `cells` takes it: `glyph` in the frame's color. */
export function pulseCell(glyph: string, frame: number): string {
  const words = Uint32Array.of(glyph.codePointAt(0) ?? 0x25cf, pulseColor(frame), DEFAULT)
  // The hooks environment has Uint8Array#toBase64; the es2023 lib does not declare it.
  const bytes = new Uint8Array(words.buffer) as Uint8Array & { toBase64: () => string }
  return bytes.toBase64()
}
