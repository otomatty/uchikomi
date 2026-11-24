/** Kana-aware, deterministic romaji input. The accepted table is local; no claim of complete game parity. */
const TABLE: Record<string, string[]> = {
  'あ':['a'], 'い':['i','yi'], 'う':['u','wu','whu'], 'え':['e'], 'お':['o'],
  'か':['ka','ca'], 'き':['ki'], 'く':['ku','cu','qu'], 'け':['ke'], 'こ':['ko','co'],
  'さ':['sa'], 'し':['si','shi','ci'], 'す':['su'], 'せ':['se','ce'], 'そ':['so'],
  'た':['ta'], 'ち':['ti','chi'], 'つ':['tu','tsu'], 'て':['te'], 'と':['to'],
  'な':['na'], 'に':['ni'], 'ぬ':['nu'], 'ね':['ne'], 'の':['no'],
  'は':['ha'], 'ひ':['hi'], 'ふ':['hu','fu'], 'へ':['he'], 'ほ':['ho'],
  'ま':['ma'], 'み':['mi'], 'む':['mu'], 'め':['me'], 'も':['mo'],
  'や':['ya'], 'ゆ':['yu'], 'よ':['yo'], 'ら':['ra'], 'り':['ri'], 'る':['ru'], 'れ':['re'], 'ろ':['ro'],
  'わ':['wa'], 'ゐ':['wi'], 'ゑ':['we'], 'を':['wo'],
  'が':['ga'], 'ぎ':['gi'], 'ぐ':['gu'], 'げ':['ge'], 'ご':['go'],
  'ざ':['za'], 'じ':['zi','ji'], 'ず':['zu'], 'ぜ':['ze'], 'ぞ':['zo'],
  'だ':['da'], 'ぢ':['di'], 'づ':['du'], 'で':['de'], 'ど':['do'],
  'ば':['ba'], 'び':['bi'], 'ぶ':['bu'], 'べ':['be'], 'ぼ':['bo'],
  'ぱ':['pa'], 'ぴ':['pi'], 'ぷ':['pu'], 'ぺ':['pe'], 'ぽ':['po'], 'ゔ':['vu'],
  'ぁ':['xa','la'], 'ぃ':['xi','li','xyi','lyi'], 'ぅ':['xu','lu'], 'ぇ':['xe','le','xye','lye'], 'ぉ':['xo','lo'],
  'ゃ':['xya','lya'], 'ゅ':['xyu','lyu'], 'ょ':['xyo','lyo'], 'ゎ':['xwa','lwa'], 'ゕ':['xka','lka'], 'ゖ':['xke','lke'],
  'きゃ':['kya'], 'きゅ':['kyu'], 'きょ':['kyo'], 'きぇ':['kye'],
  'しゃ':['sya','sha'], 'しゅ':['syu','shu'], 'しょ':['syo','sho'], 'しぇ':['sye','she'],
  'ちゃ':['tya','cha','cya'], 'ちゅ':['tyu','chu','cyu'], 'ちょ':['tyo','cho','cyo'], 'ちぇ':['tye','che','cye'],
  'にゃ':['nya'], 'にゅ':['nyu'], 'にょ':['nyo'], 'にぇ':['nye'],
  'ひゃ':['hya'], 'ひゅ':['hyu'], 'ひょ':['hyo'], 'ひぇ':['hye'],
  'みゃ':['mya'], 'みゅ':['myu'], 'みょ':['myo'], 'みぇ':['mye'],
  'りゃ':['rya'], 'りゅ':['ryu'], 'りょ':['ryo'], 'りぇ':['rye'],
  'ぎゃ':['gya'], 'ぎゅ':['gyu'], 'ぎょ':['gyo'], 'ぎぇ':['gye'],
  'じゃ':['zya','ja','jya'], 'じゅ':['zyu','ju','jyu'], 'じょ':['zyo','jo','jyo'], 'じぇ':['zye','je','jye'],
  'ぢゃ':['dya'], 'ぢゅ':['dyu'], 'ぢょ':['dyo'], 'ぢぇ':['dye'],
  'びゃ':['bya'], 'びゅ':['byu'], 'びょ':['byo'], 'びぇ':['bye'],
  'ぴゃ':['pya'], 'ぴゅ':['pyu'], 'ぴょ':['pyo'], 'ぴぇ':['pye'],
  'ふぁ':['fa','fwa'], 'ふぃ':['fi','fyi','fwi'], 'ふぇ':['fe','fwe'], 'ふぉ':['fo','fwo'], 'ふゅ':['fyu'],
  'てぃ':['thi'], 'てゅ':['thu'], 'でぃ':['dhi'], 'でゅ':['dhu'], 'とぅ':['twu'], 'どぅ':['dwu'],
  'つぁ':['tsa'], 'つぃ':['tsi'], 'つぇ':['tse'], 'つぉ':['tso'],
  'うぁ':['wha'], 'うぃ':['wi','whi'], 'うぇ':['we','whe'], 'うぉ':['who'],
  'くぁ':['qa','kwa'], 'くぃ':['qi','qwi'], 'くぇ':['qe','qwe'], 'くぉ':['qo','qwo'], 'くゎ':['qwa','kwa'],
  'ぐぁ':['gwa'], 'ぐぃ':['gwi'], 'ぐぇ':['gwe'], 'ぐぉ':['gwo'], 'ぐゎ':['gwa'],
  'ゔぁ':['va'], 'ゔぃ':['vi','vyi'], 'ゔぇ':['ve','vye'], 'ゔぉ':['vo'], 'ゔゅ':['vyu'],
  'いぇ':['ye'], 'すぃ':['swi'], 'ずぃ':['zwi'],
  'ー':['-'], '、':[','], '。':['.'], '・':['/'], '「':['['], '」':[']'], '『':['['], '』':[']'],
};
export function normalizeRoman(value: string): string {
  return String(value ?? '').normalize('NFKC').replace(/[\u2018\u2019]/g, "'").toLowerCase().replace(/\s+/g,'');
}
export function hiragana(value: string): string {
  return String(value ?? '').normalize('NFKC').replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0)-0x60)).replace(/\s+/g,'');
}
interface Choice { text:string; end:number; keyKana?:number[]; }
// A single n or doubled consonant consumes the first kana of a multi-kana edge.
function prependKana(at:number, key:string, next:Choice):Choice {
  const following = next.keyKana ?? Array<number>(next.text.length).fill(at + 1);
  return {text:key + next.text, end:next.end, keyKana:[at, ...following]};
}
function regularChoices(text:string, at:number):Choice[] {
  const choices:Choice[]=[];
  for (const length of [2,1]) {
    const token=text.slice(at,at+length), options=TABLE[token];
    if(options && token.length===length) for(const roman of options) choices.push({text:roman,end:at+length});
  }
  if(!choices.length && /^[\x21-\x7e]$/.test(text[at]??'')) choices.push({text:text[at].toLowerCase(),end:at+1});
  return choices;
}
function choicesAt(text:string, at:number):Choice[] {
  const char=text[at];
  if(char==='ん') {
    const next=text[at+1];
    const choices:Choice[]=[{text:'nn',end:at+1},{text:"n'",end:at+1},{text:'xn',end:at+1}];
    if(next && next!=='ん') {
      const nextChoices=next==='っ' ? choicesAt(text,at+1) : regularChoices(text,at+1);
      // Bind a single n to the particular consonant-led continuation. An open
      // edge to the next kana would also allow its vowel path (e.g. んう → nu).
      choices.unshift(...nextChoices.filter(x=>/^[^aiueoy]/.test(x.text)).map(x=>prependKana(at,'n',x)));
    }
    return choices;
  }
  if(char==='っ') {
    const choices:Choice[]=[];
    for(const next of regularChoices(text,at+1)) {
      if(/^[bcdfghjklmpqrstvwxyz]/.test(next.text)) choices.push(prependKana(at,next.text[0],next));
      if(next.text.startsWith('ch')) choices.push(prependKana(at,'t',next));
    }
    for(const text of ['xtu','ltu','xtsu','ltsu']) choices.push({text,end:at+1});
    return choices;
  }
  return regularChoices(text,at);
}
type Node = Map<string,Set<number>>;
function makeGraph(reading:string, fallback:string) {
  const kana=hiragana(reading);
  const usable=!!kana && [...kana].every((_,i)=>choicesAt(kana,i).length>0);
  const text=usable ? kana : fallback;
  const nodes:Node[]=Array.from({length:text.length+1},()=>new Map());
  const kanaAt = Array.from({length:nodes.length}, (_, index) => index);
  const edge=(from:number,key:string,to:number)=>{const set=nodes[from].get(key)??new Set<number>();set.add(to);nodes[from].set(key,set);};
  for(let i=0;i<text.length;i++) {
    const choices=usable?choicesAt(text,i):[{text:text[i],end:i+1}];
    for(const choice of choices) {
      let previous=i;
      for(let j=0;j<choice.text.length;j++) {
        const next=j===choice.text.length-1?choice.end:nodes.push(new Map())-1;
        if (j + 1 < choice.text.length) kanaAt[next] = choice.keyKana?.[j+1] ?? i;
        edge(previous,choice.text[j],next); previous=next;
      }
    }
  }
  return {nodes,end:text.length,kanaAt,usable};
}
export interface MatchResult { accepted:boolean; complete:boolean; position:number; display:string; }
export interface RomanMatcher {
  feed(key:string):MatchResult; reset():void;
  readonly typed:string; readonly display:string; readonly complete:boolean; readonly position:number;
  readonly expectedKeys:string[];
}
export function createMatcher(reading:string, fallbackRoman:string):RomanMatcher {
  const fallback=normalizeRoman(fallbackRoman);
  const graph=makeGraph(reading,fallback), {nodes,end}=graph;
  let active=new Set([0]), typed='';
  const transition=(states:Set<number>,key:string)=>{
    const result=new Set<number>();for(const state of states)for(const next of nodes[state].get(key)??[])result.add(next);return result;
  };
  const accepts=(states:Set<number>,suffix:string)=>{
    let current=states;for(const key of suffix){current=transition(current,key);if(!current.size)return false;}return current.has(end);
  };
  const cache=new Map<number,string|null>();
  const shortest=(state:number):string|null=>{
    if(state===end)return '';if(cache.has(state))return cache.get(state)!;
    let result:string|null=null;
    for(const [key,nextStates] of nodes[state])for(const next of nextStates){const rest=shortest(next);if(rest!==null&&(result===null||rest.length+1<result.length))result=key+rest;}
    cache.set(state,result);return result;
  };
  const display=()=>{
    if(fallback.startsWith(typed)&&accepts(active,fallback.slice(typed.length)))return fallback;
    let rest:string|null=null;for(const state of active){const s=shortest(state);if(s!==null&&(rest===null||s.length<rest.length))rest=s;}
    return typed+(rest??'');
  };
  const expectedKeys=()=>{
    if(active.has(end))return [];
    const preferred=display()[typed.length];
    const keys=[...new Set([...active].flatMap(state=>[...nodes[state].keys()]))];
    return keys.sort((a,b)=>Number(b===preferred)-Number(a===preferred)||a.localeCompare(b));
  };
  return {
    feed(key:string):MatchResult {
      const normalized=normalizeRoman(key);
      if(active.has(end)||normalized.length!==1)return {accepted:false,complete:active.has(end),position:typed.length,display:display()};
      const next=transition(active,normalized),accepted=next.size>0;
      if(accepted){active=next;typed+=normalized;}
      return {accepted,complete:active.has(end),position:typed.length,display:display()};
    },
    reset(){active=new Set([0]);typed='';},
    get typed(){return typed;},get display(){return display();},get complete(){return active.has(end);},get position(){return typed.length;},get expectedKeys(){return expectedKeys();}
  };
}
export function kanaToRoman(kana:string):string {
  const text=hiragana(kana);if(!text)return '';
  if([...text].some((_,i)=>!choicesAt(text,i).length))return '';
  let result='';for(let i=0;i<text.length;){const choice=choicesAt(text,i)[0];result+=choice.text;i=choice.end;}
  return result;
}

/** Attribute actual accepted paths (including alternate spellings) to kana offsets.
 * A miss leaves every live path in place. Ambiguous offsets are returned together. */
export function createKanaTrace(reading:string) {
  const {nodes, end, kanaAt, usable} = makeGraph(reading, '');
  let active = new Set([0]);
  return {
    step(actual:string, accepted:boolean):number[] | null {
      if (!usable || active.has(end)) return null;
      const next = new Set<number>(), offsets = new Set<number>();
      const key = normalizeRoman(actual);
      for (const state of active) {
        const edges = nodes[state].get(key);
        if (!accepted || edges) offsets.add(kanaAt[state]);
        if (edges) for (const target of edges) next.add(target);
      }
      if (accepted !== (next.size > 0)) return null;
      if (accepted) active = next;
      return [...offsets];
    },
    get complete() { return usable && active.has(end); },
    reset() { active = new Set([0]); },
  };
}
