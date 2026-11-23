export type ScoreType = 'profit' | 'total';
export interface NumericScoreText { text: string; confidence: number; }
export interface ScoreText {
  headerText: string; bodyText: string; headerConfidence: number; bodyConfidence: number;
  scoreType: ScoreType;
  numeric?: { total?: NumericScoreText; paid?: NumericScoreText; profit?: NumericScoreText };
  labelText?: string; labelConfidence?: number; structureConfidence?: number;
}
export interface ParsedScore {
  kind: 'none' | 'review' | 'score'; scoreType: ScoreType; confidence: number;
  score?: number; total?: number; profit?: number; reason?: string; fingerprint?: string;
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
 * A ranking's generic "score" never supplies an unlabelled profit amount.
 */
export function parseResultScore(input: ScoreText): ParsedScore {
  const header = compact(input.headerText), body = compact(input.bodyText), label = compact(input.labelText ?? input.bodyText);
  const result: ParsedScore = {
    kind: 'none', scoreType: input.scoreType, confidence: confidenceOf(input.labelConfidence ?? input.bodyConfidence),
    modeSource: header.includes('正確重視') && confidenceOf(input.headerConfidence) >= 82 ? 'ocr' : 'configured',
  };
  const total = amounts(body, '分のお寿司(?:を(?:ゲット|獲得))?');
  const gain = amounts(body, '分(?:お)?得(?:でした|です|[!！])');
  const loss = amounts(body, '分(?:の)?損(?:でした|です|[!！])');
  const paid = amounts(body, '払って');
  // The semantic anchor is 得でした. A small お is occasionally recognised as
  // ね in the result font; this does not change the independently read amount.
  const gainLabel = /[円内]分(?:お|ね)?得(?:でした|です|[!！])/.test(label);
  const lossLabel = /[円内]分(?:の)?損(?:でした|です|[!！])/.test(label);
  if (!total.values.length && !gain.values.length && !loss.values.length && !total.invalid && !gain.invalid && !loss.invalid && !gainLabel && !lossLabel) return result;
  const review = (reason: string): ParsedScore => ({ ...result, kind: 'review', reason,
    fingerprint: result.fingerprint ?? `review:${input.scoreType}:${reason}:${header}:${body}:${label}`.slice(0,1000) });
  const course = amounts(header, 'コース');
  if (course.values.some(value=>value!==10000) || /普通|ふつう|速度必須|一発勝負|練習/.test(header)) {
    return review('10,000円・正確重視以外の結果が表示されています');
  }
  if (gainLabel && lossLabel) return review('お得・損の読み取りが一致しませんでした');

  let totalValue: number | undefined, profitValue: number | undefined;
  const structuredNumeric = !!input.numeric && confidenceOf((input.structureConfidence ?? 0)*100)>=90 && (gainLabel || lossLabel);
  if (structuredNumeric) {
    const numeric = input.numeric!;
    const read = (value?:NumericScoreText) => value ? money(compact(value.text)) : null;
    const numericProfit=read(numeric.profit),numericPaid=read(numeric.paid),numericTotal=read(numeric.total);
    if (numericProfit===null || numericPaid===null || (numeric.total && numericTotal===null)) return review('数字を確実に読み取れませんでした');
    if ([numeric.profit,numeric.paid,...(numeric.total?[numeric.total]:[])].some(item=>confidenceOf(item?.confidence)<85)) return review('金額の認識に確認が必要です');
    if (numericPaid!==10000) return review('支払額が10,000円と一致しませんでした');
    profitValue=lossLabel?-numericProfit:numericProfit;
    totalValue=numericTotal??profitValue+10000;
    // When the independent Japanese pass also has readable digits, it must
    // agree. Malformed Japanese-number OCR cannot override the numeric pass.
    if (total.values.some(v=>v!==totalValue) || gain.values.some(v=>v!==profitValue) || loss.values.some(v=>-v!==profitValue) || paid.values.some(v=>v!==10000)) {
      return review('2つの文字認識で金額が一致しませんでした');
    }
    result.confidence=Math.min(result.confidence,confidenceOf(numeric.profit!.confidence),confidenceOf(numeric.paid!.confidence),...(numeric.total?[confidenceOf(numeric.total.confidence)]:[]));
  } else {
    if ([total,gain,loss,paid].some(item=>item.invalid||item.values.length>1) || (gain.values.length&&loss.values.length)) return review('金額の読み取りが一致しませんでした');
    if (!paid.values.length || paid.values[0]!==10000) return review('10,000円の支払額を確認できませんでした');
    totalValue=total.values[0];
    profitValue=gain.values.length?gain.values[0]:loss.values.length?-loss.values[0]:undefined;
    if (totalValue===undefined && profitValue===undefined) return review('結果の金額を読み取れませんでした');
    if (totalValue===undefined) totalValue=profitValue!+10000;
    if (profitValue===undefined) profitValue=totalValue-10000;
  }
  if (totalValue<0 || totalValue-profitValue!==10000 || totalValue%20!==0 || profitValue%20!==0) return review('獲得額・支払額・お得額の計算が一致しませんでした');
  Object.assign(result, {
    score:input.scoreType==='profit'?profitValue:totalValue,total:totalValue,profit:profitValue,
    fingerprint:`${input.scoreType}:10000:accuracy:${totalValue}:${profitValue}`,
  });
  if (result.confidence<82) return review('認識の確信度が足りないため確認が必要です');
  return {...result,kind:'score'};
}

/** Two separate, agreeing observations; repeated callbacks are not new evidence. */
export class StableScoreReader {
  private previous: { fingerprint:string;at:number;parsed:ParsedScore;count:number }|null=null;
  observe(parsed:ParsedScore,at:number):ParsedScore|null {
    if (parsed.kind==='none'||!parsed.fingerprint||!Number.isFinite(at)) {this.previous=null;return null;}
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
