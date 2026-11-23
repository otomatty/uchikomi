export type ScoreType = 'total';
export interface NumericScoreText { text: string; confidence: number; }
export interface ScoreText {
  headerText: string; bodyText: string; headerConfidence: number; bodyConfidence: number;
  amountLines?: { total?: NumericScoreText; paid?: NumericScoreText; profit?: NumericScoreText };
  numeric?: { total?: NumericScoreText; paid?: NumericScoreText; profit?: NumericScoreText };
  totalLabelText?: string; totalLabelConfidence?: number;
  labelText?: string; labelConfidence?: number; structureConfidence?: number;
}
export interface ParsedScore {
  kind: 'none' | 'review' | 'score'; scoreType: ScoreType; confidence: number;
  score?: number; total?: number; reason?: string; fingerprint?: string;
  modeSource?: 'configured' | 'ocr';
}
const compact = (value: string) => value.normalize('NFKC').replace(/[\s\u200b\uFEFF]/g, '');
const confidenceOf = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0,Math.min(100,value)) : 0;
function money(token: string): number | null {
  // Yen amounts have no fractional part. A single separator convention with
  // exactly three digits per group permits the common comma/dot OCR variation.
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,3}(?:\.\d{3})+)$/.test(token)) return null;
  const amount = Number(token.replace(/[,.]/g, ''));
  return Number.isSafeInteger(amount) && amount >= 0 && amount <= 1000000 ? amount : null;
}
interface Amounts { values: number[]; invalid: boolean; }
function amounts(text: string, suffix: string): Amounts {
  const values: number[] = [];
  let invalid = false;
  // Keep OCR-confused letters in the token and reject them, rather than guessing
  // O/0 or I/1, or silently accepting only the end of a corrupted number.
  const expression = new RegExp(`([+\\-0-9OoIl][0-9OoIl,.]*)円${suffix}`, 'g');
  for (const match of text.matchAll(expression)) {
    const value = money(match[1]);
    if (value === null) invalid = true;
    else if (!values.includes(value)) values.push(value);
  }
  return { values, invalid };
}

/**
 * Parse labelled result-screen amounts. The user's configured course/mode is
 * 10,000 yen / accuracy. A clearly recognised different course or mode blocks
 * automatic saving; an unreadable mode is honestly recorded as configured.
 * The score is always the directly observed food total. The game's difference
 * line is optional corroboration, never a separate score or an inferred total.
 */
export function parseResultScore(input: ScoreText): ParsedScore {
  const header = compact(input.headerText), body = compact(input.bodyText);
  const line = (kind: 'total' | 'paid' | 'profit') => compact(input.amountLines?.[kind]?.text ?? input.bodyText);
  const lineConfidence = (kind: 'total' | 'paid' | 'profit') => confidenceOf(input.amountLines?.[kind]?.confidence ?? input.bodyConfidence);
  const totalText = line('total'), paidText = line('paid'), differenceText = line('profit');
  const label = compact(input.labelText ?? differenceText), totalLabel = compact(input.totalLabelText ?? totalText);
  const labelConfidence = confidenceOf(input.labelConfidence ?? lineConfidence('profit'));
  const totalLabelConfidence = confidenceOf(input.totalLabelConfidence ?? lineConfidence('total'));
  const result: ParsedScore = {
    kind: 'none', scoreType: 'total', confidence: 0,
    modeSource: header.includes('正確重視') && confidenceOf(input.headerConfidence) >= 82 ? 'ocr' : 'configured',
  };
  const total = amounts(totalText, '分のお寿司(?:を(?:ゲット|獲得))?');
  const gain = amounts(differenceText, '分(?:お)?得(?:でした|です|[!！])');
  const loss = amounts(differenceText, '分(?:の)?損(?:でした|です|[!！])');
  const paid = amounts(paidText, '払って');
  // The semantic anchor is 得でした. A small お is occasionally recognised as
  // ね in the result font; this does not change the independently read amount.
  const gainLabel = /[円内]分(?:お|ね)?得(?:でした|です|[!！])/.test(label);
  const lossLabel = /[円内]分(?:の)?損(?:でした|です|[!！])/.test(label);
  // The small food noun can have imperfect kanji OCR. Its amount suffix and
  // acquisition verb still identify the total row within the verified receipt;
  // no numeral or monetary value is guessed from those glyphs.
  const hasTotalLabel = /[円内]分のお寿司|お寿司を(?:ゲット|獲得)|[円内]分の[ぁ-んァ-ヶー一-龠]{1,8}を(?:ゲット|獲得)/.test(totalLabel);
  if (!total.values.length && !gain.values.length && !loss.values.length && !total.invalid && !gain.invalid && !loss.invalid && !gainLabel && !lossLabel && !hasTotalLabel) return result;
  const review = (reason: string): ParsedScore => ({ ...result, kind: 'review', reason,
    fingerprint: result.fingerprint ?? `review:total:${reason}:${header}:${body}:${label}`.slice(0,1000) });
  const course = amounts(header, 'コース');
  if (course.values.some(value=>value!==10000) || /普通|ふつう|速度必須|一発勝負|練習/.test(header)) {
    return review('10,000円・正確重視以外の結果が表示されています');
  }
  if (labelConfidence >= 82 && gainLabel && lossLabel) return review('補助金額の読み取りが一致しませんでした');

  const readNumeric = (kind: 'total' | 'paid' | 'profit') => {
    const value = input.numeric?.[kind];
    return value && confidenceOf(value.confidence) >= 85 ? money(compact(value.text)) : null;
  };
  const numericTotal = readNumeric('total'), numericPaid = readNumeric('paid');
  const anchorConfidence = Math.max(hasTotalLabel ? totalLabelConfidence : 0, gainLabel || lossLabel ? labelConfidence : 0);
  const structuredNumeric = confidenceOf((input.structureConfidence ?? 0) * 100) >= 90 && anchorConfidence >= 82 && numericTotal !== null && numericPaid !== null;
  let totalValue: number;
  if (structuredNumeric) {
    if (numericPaid !== 10000) return review('支払額が10,000円と一致しませんでした');
    totalValue = numericTotal;
    result.confidence = Math.min(anchorConfidence, confidenceOf(input.numeric!.total!.confidence), confidenceOf(input.numeric!.paid!.confidence));
  } else {
    result.confidence = Math.min(lineConfidence('total'), lineConfidence('paid'));
    if (total.invalid || total.values.length !== 1) return review('食べた金額の合計を確認できませんでした');
    if (paid.invalid || paid.values.length !== 1 || paid.values[0] !== 10000) return review('10,000円の支払額を確認できませんでした');
    totalValue = total.values[0];
  }

  // Clear primary amounts can stand alone. A weak/unreadable optional line
  // must not prevent saving them, but usable contradictory evidence still does.
  if ((lineConfidence('total') >= 82 && total.values.some(value => value !== totalValue)) ||
      (lineConfidence('paid') >= 82 && paid.values.some(value => value !== 10000)) ||
      (numericTotal !== null && numericTotal !== totalValue) || (numericPaid !== null && numericPaid !== 10000)) {
    return review('2つの文字認識で金額が一致しませんでした');
  }
  const difference = totalValue - 10000;
  if (labelConfidence >= 82 && ((gainLabel && difference < 0) || (lossLabel && difference > 0))) {
    return review('補助金額との計算が一致しませんでした');
  }
  if (lineConfidence('profit') >= 82 && ((gain.values.length && loss.values.length) ||
      gain.values.some(value => value !== difference) || loss.values.some(value => -value !== difference))) {
    return review('補助金額との計算が一致しませんでした');
  }
  const numericDifference = readNumeric('profit');
  if (numericDifference !== null && (numericDifference !== Math.abs(difference) ||
      (labelConfidence >= 82 && ((gainLabel && numericDifference !== difference) || (lossLabel && -numericDifference !== difference))))) {
    return review('補助金額との計算が一致しませんでした');
  }
  if (totalValue < 0 || totalValue % 20 !== 0) return review('合計金額を確認してください');
  Object.assign(result, {
    score: totalValue, total: totalValue,
    fingerprint: `total:10000:accuracy:${totalValue}`,
  });
  if (result.confidence<82) return review('認識の確信度が足りないため確認が必要です');
  return {...result,kind:'score'};
}

/** Two separate, agreeing observations; repeated callbacks are not new evidence. */
export class StableScoreReader {
  private previous: { fingerprint:string;at:number;parsed:ParsedScore;count:number }|null=null;
  observe(parsed:ParsedScore,at:number):ParsedScore|null {
    if (parsed.scoreType!=='total'||parsed.kind==='none'||!parsed.fingerprint||!Number.isFinite(at)) {this.previous=null;return null;}
    if (!this.previous||this.previous.fingerprint!==parsed.fingerprint||at-this.previous.at>12000) {
      this.previous={fingerprint:parsed.fingerprint,at,parsed,count:1};return null;
    }
    if (at-this.previous.at<500)return null;
    this.previous.at=at;this.previous.count++;
    const previous=this.previous.parsed;this.previous.parsed=parsed;
    if (this.previous.count>=2&&previous.kind==='score'&&parsed.kind==='score') return {...parsed,confidence:Math.min(previous.confidence,parsed.confidence)};
    if (this.previous.count>=2)return {...parsed,kind:'review',reason:parsed.reason??previous.reason??'結果をもう一度確認してください'};
    return null;
  }
}
