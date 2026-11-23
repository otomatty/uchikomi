import type { Rect } from '../core/types';
import type { PixelFrame } from './auto-region';

export interface ResultRegions {
  panel: Rect; header: Rect; total: Rect; paid: Rect; profit: Rect; confidence: number;
}
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/**
 * Locate the result receipt by its dark course header, white paper and coloured
 * outlined amount. Text labels are verified by OCR afterwards; this detector
 * never interprets a leaderboard's generic "score" as a result total.
 */
export function detectResultRegions(frame: PixelFrame): ResultRegions | null {
  const { width, height, data } = frame;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 180 || height < 150 || data.length < width * height * 4) return null;
  const gray = new Uint8Array(width * height), white = new Uint8Array(width * height), colour = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const p = i * 4, r = data[p], g = data[p + 1], b = data[p + 2], lo = Math.min(r,g,b), hi = Math.max(r,g,b);
    if (data[p + 3] < 128) continue;
    gray[i] = +(lo >= 20 && hi <= 105 && hi - lo < 35);
    white[i] = +(lo >= 210 && hi - lo < 40);
    colour[i] = +(hi - lo > 65 && hi > 75 && lo < 170);
  }
  const rails: {x:number;y:number;w:number}[] = [];
  const minWidth = Math.max(160, width * .14);
  for (let y = 0; y < height; y += 2) {
    let start = -1;
    for (let x = 0; x <= width; x++) {
      if (x < width && gray[y * width + x]) { if (start < 0) start = x; }
      else if (start >= 0) {
        if (x - start >= minWidth) rails.push({x:start,y,w:x-start});
        start = -1;
      }
    }
  }
  rails.sort((a,b)=>b.w-a.w);
  const tried: {x:number;y:number;w:number}[]=[];
  for (const rail of rails.slice(0,120)) {
    if (tried.some(old=>Math.abs(old.x-rail.x)<5&&Math.abs(old.w-rail.w)<8&&Math.abs(old.y-rail.y)<rail.w*.16)) continue;
    const x0=rail.x,x1=rail.x+rail.w-1,w=rail.w;
    const rowFraction = (mask:Uint8Array,y:number,left=x0+2,right=x1-2) => {
      let count=0,total=0;
      for(let x=Math.ceil(left);x<=Math.floor(right);x+=2){count+=mask[y*width+x];total++;}
      return count/Math.max(1,total);
    };
    let top=rail.y,bottom=rail.y;
    while(top>0&&rail.y-top<w*.18&&rowFraction(gray,top-1)>.5)top--;
    while(bottom<height-1&&bottom-rail.y<w*.18&&rowFraction(gray,bottom+1)>.5)bottom++;
    const headerHeight=bottom-top+1;
    tried.push({x:x0,y:top,w});
    if(headerHeight<w*.045||headerHeight>w*.17||top<3||rowFraction(white,top-3)<.8)continue;
    const sideWhite=(y:number)=>rowFraction(white,y,x0+2,x0+Math.max(5,w*.013));
    let paperBottom=bottom+1,gaps=0;
    for(let y=bottom+1;y<Math.min(height,top+w*.95);y++){
      if(sideWhite(y)>.55){paperBottom=y;gaps=0;}
      else if(++gaps>Math.max(3,w*.008))break;
    }
    const bodyHeight=paperBottom-bottom;
    if(bodyHeight<w*.32||bodyHeight>w*.86)continue;
    // Profit/loss is enclosed in a wide, thin coloured frame with white inside.
    const colouredRails:{y:number;left:number;right:number}[]=[];
    for(let y=bottom+1;y<paperBottom;y++){
      let first=-1,last=-1;
      const finish=()=>{if(first>=0&&last-first>w*.55)colouredRails.push({y,left:first,right:last});first=last=-1;};
      for(let x=Math.ceil(x0+w*.025);x<x1-w*.025;x++){
        if(colour[y*width+x]){if(first<0)first=x;last=x;}
        else if(first>=0&&x-last>2)finish();
      }finish();
    }
    for(let a=0;a<colouredRails.length;a++)for(let b=a+1;b<colouredRails.length;b++){
      const upper=colouredRails[a],lower=colouredRails[b],hh=lower.y-upper.y+1;
      if(hh<w*.06||hh>w*.17||Math.abs(upper.left-lower.left)>w*.06||Math.abs(upper.right-lower.right)>w*.06)continue;
      const upperWidth=upper.right-upper.left+1;
      if(upperWidth/hh<5||upperWidth/hh>12)continue;
      let whiteCount=0,total=0;
      for(let y=Math.ceil(upper.y+hh*.12);y<lower.y-hh*.12;y+=3)for(let x=Math.ceil(upper.left+upperWidth*.04);x<upper.right-upperWidth*.04;x+=3){whiteCount+=white[y*width+x];total++;}
      if(whiteCount/Math.max(1,total)<.65)continue;
      const above=upper.y-bottom;
      if(above<w*.12||above>w*.32)continue;
      const paperTop=Math.max(0,top-headerHeight*.45);
      return {
        panel:rect(x0,paperTop,w,paperBottom-paperTop+1),
        header:rect(x0+2,top+1,w-4,headerHeight-2),
        total:rect(x0+w*.10,bottom+above*.08,w*.88,above*.46),
        paid:rect(x0+w*.10,bottom+above*.53,w*.88,above*.45),
        profit:rect(x0+w*.085,upper.y+hh*.1,w*.83,hh*.8),
        confidence:Math.min(.99,.85+.14*whiteCount/Math.max(1,total)),
      };
    }
  }
  return null;
  function rect(x:number,y:number,w:number,h:number):Rect {
    const left=clamp(Math.floor(x),0,width-1),top=clamp(Math.floor(y),0,height-1);
    return{x:left/width,y:top/height,width:Math.min(Math.ceil(w),width-left)/width,height:Math.min(Math.ceil(h),height-top)/height};
  }
}

/** Explicit polarity avoids the decorative border being mistaken for a text background. */
export function preprocessResultPixels(data:Uint8ClampedArray|Uint8Array,width:number,height:number,dark:boolean):void {
  if(data.length<width*height*4)return;
  for(let i=0;i<width*height*4;i+=4){
    const value=dark?Math.max(data[i],data[i+1],data[i+2]):Math.min(data[i],data[i+1],data[i+2]);
    const ink=dark?value>=110:value<145;
    data[i]=data[i+1]=data[i+2]=ink?0:255;data[i+3]=255;
  }
}

/** First separated dark text group in an amount line; used for a second, numeric-only OCR pass. */
export function findAmountRect(frame:PixelFrame, kind:'profit'|'total'|'paid'):Rect|null {
  const {width,height,data}=frame;
  if(width<20||height<10||data.length<width*height*4)return null;
  const columns=new Uint16Array(width);let firstY=height,lastY=0;
  for(let y=2;y<height-2;y++)for(let x=1;x<width-1;x++){
    const i=(y*width+x)*4,r=data[i],g=data[i+1],b=data[i+2],hi=Math.max(r,g,b),lo=Math.min(r,g,b);
    // The official amount is black. Its coloured explanation and green/red
    // frame are excluded, so a typed label cannot add fabricated digits.
    if(hi<150&&hi-lo<Math.max(18,hi*.15)) {columns[x]++;firstY=Math.min(firstY,y);lastY=Math.max(lastY,y);}
  }
  if(firstY>=lastY)return null;
  const gap=Math.max(4,Math.round((lastY-firstY+1)*.30));
  let left=-1,right=-1;
  for(let x=1;x<width-1;x++){
    if(columns[x]>=2){if(left<0)left=x;right=x;}
    else if(left>=0&&x-right>gap)break;
  }
  if(left<3||right>=width-3||right-left<height*.45||right-left>width*.78)return null;
  const pad=Math.max(4,Math.round(height*.08));
  const x0=Math.max(0,left-pad),y0=Math.max(0,firstY-pad);
  return{x:x0/width,y:y0/height,width:Math.min(width-x0,right-left+1+pad*2)/width,height:Math.min(height-y0,lastY-firstY+1+pad*2)/height};
}
