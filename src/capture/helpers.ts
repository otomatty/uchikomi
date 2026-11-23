import type { Calibration, Rect } from '../core/types';

export const SAMPLE_MS = 80;
export const MAX_KEY_BUFFER = 40000;
export const MAX_CANDIDATES = 16;

/** In-place OCR preparation shared by the captured-frame pipeline and fixture checks. */
export function preprocessOcrPixels(data: Uint8ClampedArray, width: number, height: number): void {
  if (width < 1 || height < 1 || data.length < width * height * 4) return;
  let border = 0;
  let count = 0;
  for (let x = 0; x < width; x += 5) {
    const i = x * 4;
    border += (data[i] + data[i + 1] + data[i + 2]) / 3;
    count++;
  }
  const inverted = border / Math.max(1, count) < 125;
  for (let i = 0; i < data.length; i += 4) {
    const low = Math.min(data[i], data[i + 1], data[i + 2]);
    const high = Math.max(data[i], data[i + 1], data[i + 2]);
    // Typed red/orange letters remain foreground on the dark game prompt.
    // Requiring a bright saturated pixel keeps the dim scenery behind it out.
    let gray = inverted && high >= 180 && high - low >= 55 ? high : low;
    if (inverted) gray = 255 - gray;
    gray = gray < 150 ? 0 : 255;
    data[i] = data[i + 1] = data[i + 2] = gray;
  }
}

export function isAllowedGameUrl(url?: string): boolean {
  if (!url) return false;
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && (parsed.hostname === 'sushida.net' || parsed.hostname === 'www.sushida.net'); }
  catch { return false; }
}

export function normalizeJapanese(value: string): string {
  return value.normalize('NFKC').replace(/[\s\u200b\uFEFF]/g, '').replace(/^[|｜]+|[|｜]+$/g, '').slice(0, 140);
}

export function normalizeReading(value: string): string {
  return normalizeJapanese(value).replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

export function normalizeOcrRoman(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[‘’`]/g, "'").replace(/\s/g, '').replace(/[^a-z0-9!?.,\-'/:;()\[\]]/g, '').slice(0, 240);
}

export function validRoman(value: string): boolean {
  return value.length >= 3 && value.length <= 160 && /[a-z]{2,}/.test(value) && /^[a-z0-9!?.,\-'/:;()\[\]]+$/.test(value);
}

export function validJapanese(value: string): boolean {
  return value.length >= 2 && value.length <= 100 && /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(value);
}

export function validReading(value: string): boolean {
  return value.length >= 2 && /^[ぁ-ゖーa-zA-Z0-9!?。、，,.\-・'()「」〜～：:;]+$/.test(value);
}

export function isRect(value: unknown): value is Rect {
  if (!value || typeof value !== 'object') return false;
  const r = value as Rect;
  return [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.x >= 0 && r.y >= 0 && r.width >= .025 && r.height >= .008 && r.x + r.width <= 1.001 && r.y + r.height <= 1.001;
}

export function isCalibration(value: unknown): value is Calibration {
  if (!value || typeof value !== 'object') return false;
  const v = value as Calibration;
  return isRect(v.japanese) && isRect(v.roman) && (!v.reading || isRect(v.reading)) && Number.isFinite(v.updatedAt);
}

export function pixelRect(rect: Rect, width: number, height: number): Rect {
  const x = Math.max(0, Math.min(width - 1, Math.floor(rect.x * width)));
  const y = Math.max(0, Math.min(height - 1, Math.floor(rect.y * height)));
  return { x, y, width: Math.max(1, Math.min(width - x, Math.ceil(rect.width * width))), height: Math.max(1, Math.min(height - y, Math.ceil(rect.height * height))) };
}

export function unionRects(rects: Rect[]): Rect {
  const x = Math.min(...rects.map(r => r.x));
  const y = Math.min(...rects.map(r => r.y));
  const right = Math.max(...rects.map(r => r.x + r.width));
  const bottom = Math.max(...rects.map(r => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

export function signatureDistance(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) return 1;
  let difference = 0;
  let foreground = 0;
  for (let i = 0; i < a.length; i++) {
    difference += Math.abs(a[i] - b[i]);
    foreground += Math.max(a[i], b[i]);
  }
  // Normalize against glyph ink, not empty crop area: a one-character change
  // must still be noticed when a short word sits in a wide game text box.
  return foreground ? difference / foreground : 0;
}

export function isCaptureStroke(value: unknown): value is { key: string; at: number; code?: string } {
  if (!value || typeof value !== 'object') return false;
  const v = value as { key: string; at: number };
  return typeof v.key === 'string' && v.key.length === 1 && /^[a-zA-Z0-9!?.,\-'/:;()\[\] ]$/.test(v.key) && Number.isFinite(v.at) && Math.abs(Date.now() - v.at) < 120000;
}
