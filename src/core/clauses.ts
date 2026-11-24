import { Parser, jaModel } from 'budoux';
import { hiragana, kanaToRoman } from './romaji';
import type { Clause, Phrase, PracticePhrase } from './types';

const parser = new Parser(jaModel);
const han = /[\p{Script=Han}々〆]+|./gu;
const wildcard = /^[\p{Script=Han}々〆]/u;
const kana = /^[ぁ-ゖー]$/u;

// For each chunk boundary retain the possible offsets in the recorded reading.
// Literal kana anchor the alignment. A run of kanji consumes one or more kana.
function boundaryOffsets(chunks:string[][], reading:string[]) {
  let reachable = new Uint8Array(reading.length + 1);
  reachable[0] = 1;
  const boundaries = [reachable];
  for (const chunk of chunks) {
    for (const token of chunk) {
      const next = new Uint8Array(reachable.length);
      const variable = wildcard.test(token);
      for (let i = 1; i <= reading.length; i++) {
        next[i] = variable
          ? Number(kana.test(reading[i-1]) && !!(reachable[i-1] || next[i-1]))
          : Number(reading[i-1] === token && !!reachable[i-1]);
      }
      reachable = next;
    }
    boundaries.push(reachable);
  }
  return boundaries;
}

export function splitClauses(phrase:Pick<Phrase,'text'|'reading'>):Clause[] {
  const chunks = parser.parse(phrase.text.normalize('NFKC')).map(chunk=>chunk.trim()).filter(Boolean);
  const reading = [...hiragana(phrase.reading)];
  if (chunks.length < 2 || !reading.length || !kanaToRoman(reading.join(''))) return [];
  const tokens = chunks.map(chunk => hiragana(chunk).match(han) ?? []);
  const left = boundaryOffsets(tokens, reading);
  if (!left[chunks.length][reading.length]) return [];
  const right = boundaryOffsets(tokens.map(chunk=>[...chunk].reverse()).reverse(), [...reading].reverse());
  const boundaries = left.map((offsets, boundary) => {
    let unique = -1;
    for (let i = 0; i < offsets.length; i++) {
      if (!offsets[i] || !right[chunks.length-boundary][reading.length-i]) continue;
      if (unique !== -1) return -1;
      unique = i;
    }
    return unique;
  });
  return chunks.flatMap((text,i) => {
    const start = boundaries[i], end = boundaries[i+1];
    if (start < 0 || end <= start || !/[\p{L}\p{N}]/u.test(text)) return [];
    return [{text, reading:reading.slice(start,end).join(''), start}];
  });
}

export function clauseTarget(phrase:Phrase, clause:Clause):PracticePhrase {
  return {...phrase, text:clause.text, reading:clause.reading, roman:kanaToRoman(clause.reading), clause};
}

export function sameClause(a:Clause, b:Clause):boolean {
  return a.start === b.start && a.text === b.text && a.reading === b.reading;
}
