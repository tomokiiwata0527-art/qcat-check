// 接着剤充填率の算定（純JS・依存なし。ブラウザとNodeの両方で動く）
// 入力画像は {data: Uint8ClampedArray(RGBA), width, height}

export const DEFAULTS = {
  tileW: 98,        // mm
  tileH: 264,       // mm
  scale: 4,         // 補正画像の px/mm
  marginPct: 7,     // 外周除外（短辺方向の%）。要領書の定義に合わせて調整
  sensitivity: 0,   // 自動閾値への加算（+で露出と判定されにくくなる）
  minBlobPct: 0.4,  // 全体に対する%未満の露出領域は除去（ノイズ）
  thresholdPass: 60,
  thresholdCaution: 65,
};

// ---- 透視変換 -------------------------------------------------
function solve(A, b) {
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
    for (let r = i + 1; r < n; r++) {
      const f = A[r][i] / A[i][i];
      for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
    x[i] = s / A[i][i];
  }
  return x;
}

// dst(出力座標) → src(元画像座標) のホモグラフィ
export function homography(dstPts, srcPts) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = dstPts[i], [u, v] = srcPts[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b);
  return [...h, 1];
}

export function warp(img, corners, W, H) {
  // corners: [TL, TR, BR, BL] （元画像のpx座標）
  const h = homography([[0, 0], [W, 0], [W, H], [0, H]], corners);
  const out = new Uint8ClampedArray(W * H * 4);
  const { data, width, height } = img;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = h[6] * x + h[7] * y + 1;
      const u = (h[0] * x + h[1] * y + h[2]) / d;
      const v = (h[3] * x + h[4] * y + h[5]) / d;
      const o = (y * W + x) * 4;
      if (u < 0 || v < 0 || u >= width - 1 || v >= height - 1) { out[o + 3] = 255; continue; }
      const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0;
      const i00 = (y0 * width + x0) * 4, i10 = i00 + 4, i01 = i00 + width * 4, i11 = i01 + 4;
      for (let c = 0; c < 3; c++) {
        out[o + c] = data[i00 + c] * (1 - fx) * (1 - fy) + data[i10 + c] * fx * (1 - fy)
          + data[i01 + c] * (1 - fx) * fy + data[i11 + c] * fx * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, width: W, height: H };
}

// ---- フィルタ --------------------------------------------------
function gaussKernel(sigma) {
  const r = Math.ceil(sigma * 3), k = [];
  let s = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); s += v; }
  return { k: k.map(v => v / s), r };
}

function blurRGB(img, sigma) {
  const { data, width: W, height: H } = img;
  const { k, r } = gaussKernel(sigma);
  const tmp = new Float32Array(W * H * 3), out = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) {
    let s = 0;
    for (let i = -r; i <= r; i++) { const xx = Math.min(W - 1, Math.max(0, x + i)); s += k[i + r] * data[(y * W + xx) * 4 + c]; }
    tmp[(y * W + x) * 3 + c] = s;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) {
    let s = 0;
    for (let i = -r; i <= r; i++) { const yy = Math.min(H - 1, Math.max(0, y + i)); s += k[i + r] * tmp[(yy * W + x) * 3 + c]; }
    out[(y * W + x) * 3 + c] = s;
  }
  return out;
}

const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const fxyz = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;

// 「黄み」指標 = b* − 0.5|a*|（クリーム色=素地は高く、青灰色=接着剤は低い）
function warmChannel(rgb, n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const R = lin(rgb[i * 3]), G = lin(rgb[i * 3 + 1]), B = lin(rgb[i * 3 + 2]);
    const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
    const Y = 0.2126729 * R + 0.7151522 * G + 0.0721750 * B;
    const Z = (0.0193339 * R + 0.1191920 * G + 0.9503041 * B) / 1.08883;
    const fx = fxyz(X), fy = fxyz(Y), fz = fxyz(Z);
    const a = 500 * (fx - fy), b = 200 * (fy - fz);
    w[i] = b - 0.5 * Math.abs(a);
  }
  return w;
}

function otsu(vals) {
  const hist = new Float64Array(256);
  for (const v of vals) hist[v]++;
  const total = vals.length;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = -1, thr = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sB += t * hist[t];
    const mB = sB / wB, mF = (sum - sB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

// ---- 形態処理 --------------------------------------------------
function slide(src, W, H, r, horiz, takeMin) {
  const out = new Uint8Array(W * H);
  const len = horiz ? W : H, lines = horiz ? H : W;
  for (let l = 0; l < lines; l++) {
    for (let p = 0; p < len; p++) {
      let v = takeMin ? 1 : 0;
      for (let d = -r; d <= r; d++) {
        const q = p + d;
        let s;
        if (q < 0 || q >= len) s = takeMin ? 1 : 0; else s = src[horiz ? l * W + q : q * W + l];
        if (takeMin) { if (!s) { v = 0; break; } } else if (s) { v = 1; break; }
      }
      out[horiz ? l * W + p : p * W + l] = v;
    }
  }
  return out;
}
const erode = (m, W, H, r) => slide(slide(m, W, H, r, true, true), W, H, r, false, true);
const dilate = (m, W, H, r) => slide(slide(m, W, H, r, true, false), W, H, r, false, false);

function removeSmall(mask, W, H, minPx) {
  const seen = new Uint8Array(W * H), stack = [];
  for (let s = 0; s < W * H; s++) {
    if (!mask[s] || seen[s]) continue;
    const comp = []; stack.push(s); seen[s] = 1;
    while (stack.length) {
      const p = stack.pop(); comp.push(p);
      const x = p % W, y = (p / W) | 0;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < W - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && mask[p - W] && !seen[p - W]) { seen[p - W] = 1; stack.push(p - W); }
      if (y < H - 1 && mask[p + W] && !seen[p + W]) { seen[p + W] = 1; stack.push(p + W); }
    }
    if (comp.length < minPx) for (const p of comp) mask[p] = 0;
  }
}

// ---- メイン ----------------------------------------------------
export function judge(fillPct, o = DEFAULTS) {
  if (fillPct < o.thresholdPass) return 'fail';
  if (fillPct < o.thresholdCaution) return 'caution';
  return 'pass';
}

export function analyze(img, corners, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const W = Math.round(o.tileW * o.scale), H = Math.round(o.tileH * o.scale);
  const warped = warp(img, corners, W, H);
  const m = Math.round(W * o.marginPct / 100);
  const roi = new Uint8Array(W * H);
  let roiN = 0;
  for (let y = m; y < H - m; y++) for (let x = m; x < W - m; x++) { roi[y * W + x] = 1; roiN++; }

  const sigma = 3 * (o.scale / 4);
  const w = warmChannel(blurRGB(warped, sigma), W * H);
  const v = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) v[i] = Math.max(0, Math.min(255, Math.round((w[i] + 20) * 4)));
  const roiVals = new Uint8Array(roiN);
  for (let i = 0, j = 0; i < W * H; i++) if (roi[i]) roiVals[j++] = v[i];
  const autoThr = otsu(roiVals);
  const thr = autoThr + o.sensitivity;

  let bare = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) bare[i] = (roi[i] && v[i] > thr) ? 1 : 0;
  const k = Math.max(1, Math.round(2 * o.scale / 4));      // ≒5x5
  const k2 = Math.max(1, Math.round(4 * o.scale / 4));     // ≒9x9
  bare = dilate(erode(bare, W, H, k), W, H, k);            // open
  bare = erode(dilate(bare, W, H, k2), W, H, k2);          // close
  for (let i = 0; i < W * H; i++) if (!roi[i]) bare[i] = 0;
  removeSmall(bare, W, H, o.minBlobPct / 100 * W * H);

  let bareN = 0; for (let i = 0; i < W * H; i++) bareN += bare[i];
  const barePct = 100 * bareN / roiN;
  const fillPct = 100 - barePct;
  return { fillPct, barePct, result: judge(fillPct, o), autoThreshold: autoThr, threshold: thr, warped, bare, roi, width: W, height: H, margin: m, opts: o };
}

// 解析結果画像（RGBA）。青=接着剤あり、赤=接着剤なし。色の付かない外周は算定から除外した範囲
export function overlay(res) {
  const { warped, bare, roi, width: W, height: H } = res;
  const out = new Uint8ClampedArray(warped.data);
  for (let i = 0; i < W * H; i++) {
    if (!roi[i]) continue;
    const o = i * 4;
    if (bare[i]) {
      out[o] = out[o] * 0.45 + 235 * 0.55; out[o + 1] = out[o + 1] * 0.45 + 60 * 0.55; out[o + 2] = out[o + 2] * 0.45 + 60 * 0.55;
    } else {
      out[o] = out[o] * 0.55 + 70 * 0.45; out[o + 1] = out[o + 1] * 0.55 + 125 * 0.45; out[o + 2] = out[o + 2] * 0.55 + 235 * 0.45;
    }
  }
  return { data: out, width: W, height: H };
}
