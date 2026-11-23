import { createMatcher } from '../core/romaji';
import { normalizeReading, validReading } from './helpers';

export interface ObservedReading {
  japanese: string;
  reading: string;
  roman: string;
  japaneseConfidence: number;
  readingConfidence: number;
  romanConfidence: number;
}
export interface ResolvedReading {
  reading: string;
  observedReading: string;
  consistent: boolean;
  confidence: number;
  source: 'reading' | 'title' | 'unverified';
}

function matchesRoman(reading: string, roman: string): boolean {
  if (!validReading(reading) || !roman) return false;
  // No fallback roman is supplied: unsupported kana must fail this cross-check,
  // rather than silently accepting the exact spelling we wanted to verify.
  const matcher = createMatcher(reading, '');
  for (const key of roman) if (!matcher.feed(key).accepted) return false;
  return matcher.complete;
}

/**
 * Resolve only text visible in the captured frame. Tiny furigana may confuse ぱ
 * and ば; a kana-only title is independent evidence when its full reading agrees
 * with the observed roman line. Kanji readings are never inferred or guessed.
 */
export function resolveOcrReading(observed: ObservedReading): ResolvedReading {
  const reading = normalizeReading(observed.reading);
  const valid = validReading(reading);
  const titleReading = normalizeReading(observed.japanese);
  const titleHasReading = validReading(titleReading);
  const titleConsistent = titleHasReading && matchesRoman(titleReading, observed.roman);
  if (valid && matchesRoman(reading, observed.roman)) {
    // A kana-only title can be checked too. Contradictory visible text remains
    // reviewable even when the smaller furigana happened to be recognized well.
    return { reading, observedReading: reading, consistent: !titleHasReading || titleConsistent, confidence: observed.readingConfidence, source: 'reading' };
  }
  if (Number.isFinite(observed.japaneseConfidence) && Number.isFinite(observed.romanConfidence) &&
      observed.japaneseConfidence >= 85 && observed.romanConfidence >= 88 &&
      titleConsistent) {
    return { reading: titleReading, observedReading: reading, consistent: true, confidence: observed.japaneseConfidence, source: 'title' };
  }
  return { reading: valid ? reading : '', observedReading: reading, consistent: false, confidence: observed.readingConfidence, source: 'unverified' };
}
