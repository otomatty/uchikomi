import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOcrReading, type ObservedReading } from '../src/capture/ocr-reading';

const captured: ObservedReading = {
  japanese: 'タイムパラドックス', reading: 'たいむばらどっくす', roman: 'taimuparadokkusu',
  japaneseConfidence: 95, readingConfidence: 95, romanConfidence: 92,
};

test('tiny furigana disagreement can use independently observed kana title and matching full roman', () => {
  const result = resolveOcrReading(captured);
  assert.equal(result.reading, 'たいむぱらどっくす');
  assert.equal(result.observedReading, 'たいむばらどっくす');
  assert.equal(result.source, 'title');
  assert.equal(result.consistent, true);
  assert.equal(result.confidence, 95);
});

test('a consistent furigana reading takes precedence and retains its own confidence', () => {
  const result = resolveOcrReading({ ...captured, reading: 'たいむぱらどっくす', readingConfidence: 76 });
  assert.equal(result.source, 'reading');
  assert.equal(result.confidence, 76);
  assert.equal(result.consistent, true);
});

test('contradictory kana title cannot be auto-confirmed by a correct furigana alone', () => {
  const result = resolveOcrReading({ ...captured, japanese: 'タイムバパラドックス', reading: 'たいむぱらどっくす' });
  assert.equal(result.reading, 'たいむぱらどっくす');
  assert.equal(result.source, 'reading');
  assert.equal(result.consistent, false);
});

test('title fallback rejects low confidence, incomplete roman and a duplicated OCR glyph', () => {
  for (const patch of [
    { japaneseConfidence: 84 }, { romanConfidence: 87 }, { japaneseConfidence: NaN },
    { roman: 'taimuparadokku' }, { roman: 'taimuparadokkusux' },
    { japanese: 'タイムバパラドックス' },
  ]) {
    const result = resolveOcrReading({ ...captured, ...patch });
    assert.equal(result.consistent, false);
    assert.equal(result.source, 'unverified');
  }
});

test('kanji is never converted into an inferred reading from roman', () => {
  const result = resolveOcrReading({ ...captured, japanese: '引っ越しの準備', reading: 'ひっこしのじゅんびい', roman: 'hikkosinojunbi' });
  assert.equal(result.consistent, false);
  assert.equal(result.source, 'unverified');
  assert.equal(result.reading, 'ひっこしのじゅんびい');
});

test('a valid observed furigana allows kanji title and official alternate spelling', () => {
  const result = resolveOcrReading({ ...captured, japanese: '引っ越しの準備', reading: 'ひっこしのじゅんび', roman: 'hikkosinojunbi' });
  assert.equal(result.consistent, true);
  assert.equal(result.source, 'reading');
});
