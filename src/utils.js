export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const mean = (a) =>
  a && a.length ? a.reduce((p, c) => p + c, 0) / a.length : null;

export const std = (a) => {
  const m = mean(a);
  if (m === null) return 0;
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
};

export const median = (a) => {
  if (!a || !a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Sistolic peak detection on PPG/rPPG brightness signal.
// Shared by HRV (red channel) and rPPG (green channel).
export function detectPeaks(samples) {
  const v = samples.map((s) => s.v);
  const t = samples.map((s) => s.t);
  const win = 3;
  const sm = [];
  for (let i = 0; i < v.length; i++) {
    let a = 0, c = 0;
    for (let j = -win; j <= win; j++) {
      if (v[i + j] != null) { a += v[i + j]; c++; }
    }
    sm.push(a / c);
  }
  const longWin = 15;
  const base = [];
  for (let i = 0; i < sm.length; i++) {
    let a = 0, c = 0;
    for (let j = -longWin; j <= longWin; j++) {
      if (sm[i + j] != null) { a += sm[i + j]; c++; }
    }
    base.push(a / c);
  }
  const det = sm.map((x, i) => x - base[i]);
  const sd = std(det);
  // No variation = no signal. Don't invent peaks from quantization noise.
  if (sd < 0.01) return [];
  const th = sd * 0.35;
  const peaks = [];
  let lastT = -1;
  for (let i = 2; i < det.length - 2; i++) {
    if (
      det[i] > th &&
      det[i] > det[i - 1] &&
      det[i] >= det[i + 1] &&
      det[i] > det[i - 2] &&
      det[i] > det[i + 2]
    ) {
      // 0.35s refractory period (~170 BPM ceiling)
      if (lastT < 0 || t[i] - lastT > 0.35) {
        peaks.push({ t: t[i], v: det[i] });
        lastT = t[i];
      }
    }
  }
  return peaks;
}
