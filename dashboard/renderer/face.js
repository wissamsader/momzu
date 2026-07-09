// Animated face — faithful port of rileyjarvis's RickyFace (MIT licensed,
// github.com/rbrown101010/rileyjarvis): circular cyan-ring face, gradient
// eyes with blink/look cycles, and a mouth lip-synced from live speech
// audio via four CSS variables (open / width / round / teeth).
//
// Interface matches the old sphere: createFace(mount) → { setState, setMouth }.
// Moods: idle | listening | thinking | working | speaking | error.

const FACE_CSS = `
#face-root {
  position: relative;
  display: grid;
  place-items: center;
  width: clamp(280px, 42vh, 520px);
  height: clamp(280px, 42vh, 520px);
  border-radius: 999px;
  background: #08090d;
  border: clamp(7px, 1vh, 12px) solid rgba(86, 189, 255, 0.82);
  overflow: hidden;
  transition: border-color 300ms ease;
}
#face-root::after {
  content: "";
  position: absolute;
  inset: 14px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  pointer-events: none;
}
#face-root .eye-row {
  position: relative;
  z-index: 2;
  display: flex;
  gap: clamp(44px, 9vh, 84px);
  transform: translateY(-32px);
  animation: face-eye-look-row 6.5s infinite ease-in-out;
}
#face-root .eye {
  position: relative;
  width: clamp(50px, 9.5vh, 70px);
  height: clamp(58px, 11vh, 82px);
  border-radius: 999px;
  background: linear-gradient(180deg, #f8fbff, #88e9ff);
  animation: face-blink 4.6s infinite;
  overflow: hidden;
  transition: transform 250ms ease, background 300ms ease;
}
#face-root .eye span {
  position: absolute;
  inset: 24% 30% 32%;
  border-radius: 999px;
  background: #071019;
  opacity: 0.82;
  animation: face-pupil-look 6.5s infinite ease-in-out;
}
#face-root.face-thinking .eye,
#face-root.face-working .eye { transform: scaleY(0.72); }
#face-root.face-error { border-color: rgba(255, 91, 114, 0.82); }
#face-root.face-error .eye { background: linear-gradient(180deg, #fff5f7, #ff5b72); }
#face-root.face-listening { border-color: rgba(89, 239, 161, 0.75); }
#face-root .mouth-wrap {
  position: absolute;
  z-index: 2;
  bottom: 24%;
  display: grid;
  place-items: center;
  width: 180px;
  height: 84px;
}
#face-root .mouth {
  position: relative;
  width: calc(72px + (var(--mouth-width) * 69px) - (var(--mouth-round) * 26px));
  height: calc(4px + (var(--mouth-open) * 33px));
  transform-origin: center;
  transition: width 55ms linear, height 55ms linear, transform 55ms linear;
  transform: translateY(calc(var(--mouth-open) * -4px)) scaleX(calc(1 - (var(--mouth-round) * 0.28)));
}
#face-root .mouth-line {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border-radius: calc(999px - (var(--mouth-round) * 400px));
  background: #dff8ff;
  transform: scaleY(calc(0.35 + (var(--mouth-open) * 0.9)));
}
#face-root .mouth-teeth {
  position: absolute;
  z-index: 1;
  left: 50%;
  top: 18%;
  width: calc(39px + (var(--mouth-width) * 33px));
  height: 2px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.82);
  opacity: var(--mouth-teeth);
  transform: translateX(-50%);
}
#face-root.face-speaking .mouth {
  width: calc(78px + (var(--mouth-width) * 78px) - (var(--mouth-round) * 32px));
  height: calc(4px + (var(--mouth-open) * 39px));
}
/* sleeping: eyes fully closed, no look/blink cycles, dim slow breathing.
   The glow lives on a sibling layer and animates opacity only — animating
   box-shadow on #face-root repaints the whole face every frame (GPU). */
#face-root.face-sleeping { border-color: rgba(86, 189, 255, 0.28); }
#face-glow {
  position: absolute; inset: 0; margin: auto;
  width: clamp(280px, 42vh, 520px);
  height: clamp(280px, 42vh, 520px);
  border-radius: 999px;
  box-shadow: 0 0 18px rgba(86, 189, 255, 0.18);
  opacity: 0;
  pointer-events: none;
}
#face-root.face-sleeping + #face-glow { animation: face-breathe 5s ease-in-out infinite; }
#face-root.face-sleeping .eye-row { animation: none; }
#face-root.face-sleeping .eye {
  animation: none;
  transform: scaleY(0.06);
  background: linear-gradient(180deg, #9fb8c8, #5b7f96);
}
#face-root.face-sleeping .eye span { animation: none; opacity: 0; }
@keyframes face-breathe {
  0%, 100% { opacity: 0.28; }
  50% { opacity: 1; }
}
@keyframes face-blink {
  0%, 88%, 92%, 100% { transform: scaleY(1); }
  89.5%, 93.5% { transform: scaleY(0.08); }
}
@keyframes face-eye-look-row {
  0%, 12%, 100% { transform: translate(0, -32px); }
  24%, 36% { transform: translate(12px, -34px); }
  50%, 62% { transform: translate(-14px, -30px); }
  76% { transform: translate(5px, -35px); }
}
@keyframes face-pupil-look {
  0%, 12%, 100% { transform: translate(0, 0); }
  24%, 36% { transform: translate(6px, -2px); }
  50%, 62% { transform: translate(-7px, 2px); }
  76% { transform: translate(3px, -3px); }
}
`;

const SILENT = { open: 0, width: 0.18, round: 0, teeth: 0 };

export function createFace(mount) {
  const style = document.createElement('style');
  style.textContent = FACE_CSS;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'face-root';
  root.className = 'face-idle';
  root.innerHTML = `
    <div class="eye-row">
      <div class="eye"><span></span></div>
      <div class="eye"><span></span></div>
    </div>
    <div class="mouth-wrap">
      <div class="mouth">
        <div class="mouth-teeth"></div>
        <div class="mouth-line"></div>
      </div>
    </div>`;
  mount.appendChild(root);

  // Sibling glow layer for the sleeping breathe (must follow root — the
  // `.face-sleeping + #face-glow` selector keys off DOM order).
  const glow = document.createElement('div');
  glow.id = 'face-glow';
  mount.appendChild(glow);

  const applyMouth = (s) => {
    root.style.setProperty('--mouth-open', s.open.toFixed(3));
    root.style.setProperty('--mouth-width', s.width.toFixed(3));
    root.style.setProperty('--mouth-round', s.round.toFixed(3));
    root.style.setProperty('--mouth-teeth', s.teeth.toFixed(3));
  };
  applyMouth(SILENT);

  return {
    setState(state) {
      root.className = `face-${state}`;
      if (state !== 'speaking') applyMouth(SILENT);
    },
    setMouth(shape) { applyMouth(shape); },
  };
}

// rileyjarvis's exact realtime viseme approximation: RMS energy plus three
// speech bands → mouth open/width/round/teeth, smoothed between frames.
export function mouthFromAudio(analyser, timeData, freqData, prev) {
  analyser.getByteTimeDomainData(timeData);
  analyser.getByteFrequencyData(freqData);
  let total = 0;
  for (const sample of timeData) {
    const centered = (sample - 128) / 128;
    total += centered * centered;
  }
  const energy = clamp01(Math.sqrt(total / timeData.length) * 10.5);
  const low = clamp01((avg(freqData, 2, 14) / 255) * 2.2);
  const mid = clamp01((avg(freqData, 14, 48) / 255) * 2.1);
  const high = clamp01((avg(freqData, 48, 110) / 255) * 2.8);

  const target = {
    open: clamp01(energy * 0.75 + mid * 0.45 - high * 0.16),
    width: clamp01(0.28 + mid * 0.55 + high * 0.74 - low * 0.28),
    round: clamp01(0.08 + low * 0.95 + energy * 0.1 - high * 0.42),
    teeth: clamp01(high * 1.4 + mid * 0.25 - low * 0.35),
  };
  return {
    open: lerp(prev.open, target.open, 0.36),
    width: lerp(prev.width, target.width, 0.36),
    round: lerp(prev.round, target.round, 0.36),
    teeth: lerp(prev.teeth, target.teeth, 0.36),
  };
}

export const silentMouth = () => ({ ...SILENT });

function avg(values, start, end) {
  const capped = Math.min(end, values.length);
  if (start >= capped) return 0;
  let total = 0;
  for (let i = start; i < capped; i++) total += values[i];
  return total / (capped - start);
}
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
