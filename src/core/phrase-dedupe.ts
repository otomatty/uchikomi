import type { Attempt, Phrase } from './types';
import { sameClause, splitClauses } from './clauses';
import { createMatcher, kanaToRoman, normalizeRoman } from './romaji';

const label = (value: string) => value.normalize('NFKC').replace(/\s+/g, '');
const reading = (value: string) => label(value).replace(/[ァ-ヶ]/g, character => String.fromCharCode(character.charCodeAt(0) - 0x60));

/** Unknown readings cannot bridge two different known readings. */
export function groupDuplicatePhrases(phrases: readonly Phrase[]): Phrase[][] {
  const texts = new Map<string, Phrase[]>();
  for (const phrase of phrases) {
    const key = label(phrase.text), rows = texts.get(key) ?? [];
    rows.push(phrase); texts.set(key, rows);
  }
  const groups: Phrase[][] = [];
  for (const rows of texts.values()) {
    const known = new Map<string, Phrase[]>(), unknown = new Map<string, Phrase[]>();
    for (const phrase of rows) {
      const kana = reading(phrase.reading), roman = normalizeRoman(phrase.roman);
      if (!kana && !roman) { groups.push([phrase]); continue; }
      const map = kana ? known : unknown, key = kana || roman, values = map.get(key) ?? [];
      values.push(phrase); map.set(key, values);
    }
    for (const [roman, values] of unknown) {
      const matches = [...known.values()].filter(group => group.some(phrase => normalizeRoman(phrase.roman) === roman));
      if (known.size === 1 && matches.length === 1) matches[0].push(...values);
      else groups.push(values);
    }
    groups.push(...known.values());
  }
  return groups;
}

export function phraseSeenSources(phrase: Phrase): {id:string;count:number}[] {
  return phrase.seenSources ?? [{ id: phrase.id, count: phrase.seenCount }];
}

/** When an existing canonical ID is saved again, its count is an aggregate. */
export function phraseSnapshot(existing: Phrase, incoming: Phrase): Phrase {
  if (incoming.id !== existing.id || incoming.seenSources || !existing.seenSources) return incoming;
  const extra = Math.max(0, incoming.seenCount - existing.seenCount);
  return { ...incoming, seenSources: existing.seenSources.map(source => source.id === existing.id ? { ...source, count: source.count + extra } : source) };
}

export function mergePhraseGroup(group: readonly Phrase[], preferredId?: string, preferredContent?: Phrase, archiveImages = true): Phrase {
  if (group.length === 1) return group[0];
  const oldest = [...group].sort((a, b) => a.capturedAt - b.capturedAt || a.id.localeCompare(b.id));
  const canonicalId = preferredId ?? oldest[0].id;
  // A verified observation wins over OCR. Among equal verification states keep
  // the most confident, then most recently observed complete spelling.
  const best = preferredContent ?? [...group].sort((a, b) => Number(b.verified) - Number(a.verified) ||
    Number(!!b.reading) - Number(!!a.reading) || b.confidence - a.confidence || b.lastSeenAt - a.lastSeenAt || a.id.localeCompare(b.id))[0];
  const sources = new Map<string, number>();
  for (const phrase of group) for (const source of phraseSeenSources(phrase)) sources.set(source.id, Math.max(sources.get(source.id) ?? 0, source.count));
  const seenSources = [...sources].map(([id, count]) => ({ id, count })).sort((a, b) => a.id.localeCompare(b.id));
  // Once present, the archive identifies the original images. A later live
  // preview is not another original merely because an old ID is reimported.
  const images = [...new Set(group.flatMap(phrase => phrase.screenshots ?? (phrase.screenshot ? [phrase.screenshot] : [])))];
  const screenshot = (!archiveImages ? [...group].reverse().find(phrase => phrase.screenshot)?.screenshot : undefined) ?? best.screenshot ?? images[0];
  const result: Phrase = {
    ...best, id: canonicalId, verified: group.some(phrase => phrase.verified),
    capturedAt: Math.min(...group.map(phrase => phrase.capturedAt)), lastSeenAt: Math.max(...group.map(phrase => phrase.lastSeenAt)),
    confidence: Math.max(...group.map(phrase => phrase.confidence)), seenCount: seenSources.reduce((sum, source) => sum + source.count, 0),
  };
  if (seenSources.length > 1 || group.some(phrase => phrase.seenSources)) result.seenSources = seenSources;
  else delete result.seenSources;
  if (screenshot !== undefined) result.screenshot = screenshot;
  // Consolidation retains the original representative too, so a later live
  // capture may update its preview without deleting any archived source image.
  // Ordinary repeat captures carry this archive forward without growing it.
  const archived = archiveImages ? images : [...new Set(group.flatMap(phrase => phrase.screenshots ?? []))];
  const combinesOriginalRows = archiveImages && new Set(group.map(phrase => phrase.id)).size > 1;
  if (archived.length > 1 || (combinesOriginalRows && archived.length > 0) || group.some(phrase => phrase.screenshots)) result.screenshots = archived;
  else delete result.screenshots;
  if (group.some(phrase => phrase.tags)) result.tags = [...new Set(group.flatMap(phrase => phrase.tags ?? []))];
  return result;
}

/** Preserve measurements only when the new target accepts the same input. */
export function compatiblePhraseAttempt(before: Phrase, after: Phrase, attempt: Attempt): boolean {
  if (attempt.clause) return compatibleAttemptWithPhrase(after, attempt);
  const oldReading = reading(before.reading), newReading = reading(after.reading);
  if (oldReading === newReading && (normalizeRoman(before.roman) === normalizeRoman(after.roman) || (oldReading && kanaToRoman(oldReading)))) return true;
  return compatibleAttemptWithPhrase(after, attempt);
}

/** Recheck detailed delayed input even when its canonical ID has not changed. */
export function compatibleAttemptWithPhrase(after: Phrase, attempt: Attempt): boolean {
  if (!attempt.judgements?.length) return false;
  const clause = attempt.clause;
  if (clause && !splitClauses(after).some(part => sameClause(part,clause))) return false;
  const matcher = clause ? createMatcher(clause.reading, kanaToRoman(clause.reading)) : createMatcher(after.reading, after.roman);
  for (const judgement of attempt.judgements) {
    if (matcher.position !== judgement.position || [...matcher.expectedKeys].sort().join('\0') !== [...judgement.expected].sort().join('\0')) return false;
    if (matcher.feed(judgement.actual).accepted !== judgement.accepted) return false;
  }
  return matcher.typed === attempt.typed && (!attempt.complete || matcher.complete);
}
