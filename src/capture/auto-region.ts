import type { Rect } from '../core/types';

/** Pixel-only prompt detection. All returned rectangles use the input frame's 0..1 coordinates. */
export interface AutoRegions { panel: Rect; japanese: Rect; reading: Rect; roman: Rect; confidence: number; }
export interface PixelFrame { data: ArrayLike<number>; width: number; height: number; }
export interface DetectOptions { searchBounds?: Rect; }
interface Run { x0: number; x1: number; y0: number; y1: number; }
const clamp=(v:number,lo:number,hi:number)=>Math.max(lo,Math.min(hi,v));

/**
 * Locate Sushi-da's white, rounded prompt frame rather than assuming a canvas or viewport position.
 * White horizontal rails propose rectangles; both vertical rails, a dark interior and the three
 * text rows must agree. Menus, black letterboxing and bright page chrome are therefore ignored.
 * Work is bounded by sampling large frames. No DOM, OCR, storage or game internals are needed.
 */
export function detectPromptRegions(frame:PixelFrame,options:DetectOptions={}):AutoRegions|null {
  const {width,height,data}=frame;
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<100||height<60||data.length<width*height*4)return null;
  const stride=Math.max(1,Math.floor(Math.max(width,height)/1280));
  const w=Math.ceil(width/stride),h=Math.ceil(height/stride);
  const white=new Uint8Array(w*h),bright=new Uint8Array(w*h),dark=new Uint8Array(w*h);
  let sx0=0,sy0=0,sx1=w,sy1=h;
  const bounds=options.searchBounds;
  if(bounds&&[bounds.x,bounds.y,bounds.width,bounds.height].every(Number.isFinite)&&bounds.width>0&&bounds.height>0){
    sx0=clamp(Math.floor(bounds.x*w),0,w);sy0=clamp(Math.floor(bounds.y*h),0,h);
    sx1=clamp(Math.ceil((bounds.x+bounds.width)*w),sx0,w);sy1=clamp(Math.ceil((bounds.y+bounds.height)*h),sy0,h);
  }
  for(let y=sy0;y<sy1;y++)for(let x=sx0;x<sx1;x++){
    const p=(Math.min(height-1,y*stride)*width+Math.min(width-1,x*stride))*4;
    const r=data[p],g=data[p+1],b=data[p+2],lo=Math.min(r,g,b),hi=Math.max(r,g,b),i=y*w+x;
    if(data[p+3]<128)continue;
    white[i]=+(lo>=180&&hi-lo<70);
    bright[i]=+(hi>=160&&(lo>=125||hi-lo>=55));
    dark[i]=+(.2126*r+.7152*g+.0722*b<130);
  }
  // Keep long horizontal rails. Small gaps tolerate antialiasing at noninteger browser zoom.
  const minRail=Math.max(70,Math.floor((sx1-sx0)*.08)),gap=Math.max(1,Math.round(2/stride));
  const runs:Run[]=[];
  for(let y=sy0;y<sy1;y++){
    let first=-1,last=-1;
    const finish=()=>{
      if(first>=0&&last-first+1>=minRail){
        let previous:Run|undefined;
        for(let i=runs.length-1;i>=0;i--){
          const r=runs[i];if(y-r.y1>3)break;
          const overlap=Math.min(last,r.x1)-Math.max(first,r.x0)+1;
          const ratio=(last-first+1)/(r.x1-r.x0+1);
          if(overlap/Math.min(last-first+1,r.x1-r.x0+1)>.88&&ratio>.8&&ratio<1.25){previous=r;break;}
        }
        if(previous){previous.y1=y;previous.x0=Math.min(previous.x0,first);previous.x1=Math.max(previous.x1,last);}
        else runs.push({x0:first,x1:last,y0:y,y1:y});
      }
      first=-1;last=-1;
    };
    for(let x=sx0;x<sx1;x++){
      if(white[y*w+x]){if(first<0)first=x;last=x;}
      else if(first>=0&&x-last>gap)finish();
    }
    finish();
  }
  // A dense, unrelated image must not cause unbounded candidate work.
  const rails=runs.filter(r=>r.y1-r.y0<Math.max(12,(r.x1-r.x0)*.07)).sort((a,b)=>(b.x1-b.x0)-(a.x1-a.x0)).slice(0,80);
  let best:AutoRegions|null=null;
  for(let a=0;a<rails.length;a++)for(let b=a+1;b<rails.length;b++){
    let top=rails[a],bottom=rails[b];if(top.y0>bottom.y0)[top,bottom]=[bottom,top];
    const y0=top.y0,y1=bottom.y1,dh=y1-y0+1;
    const overlap=Math.min(top.x1,bottom.x1)-Math.max(top.x0,bottom.x0)+1;
    const reference=Math.min(top.x1-top.x0+1,bottom.x1-bottom.x0+1);
    if(dh<24||overlap/reference<.72||reference/dh<2.7||reference/dh>4.8)continue;
    const insideTop=Math.ceil(y0+dh*.2),insideBottom=Math.floor(y1-dh*.2);
    const radius=Math.ceil(dh*.2);
    const side=(seed:number):{outer0:number;outer1:number;quality:number}|null=>{
      const lo=clamp(seed-radius,sx0,sx1-1),hi=clamp(seed+radius,sx0,sx1-1);
      let peak=-1,quality=0;const scores:number[]=[];
      for(let x=lo;x<=hi;x++){
        let sum=0;for(let y=insideTop;y<=insideBottom;y++)sum+=white[y*w+x];
        const q=sum/(insideBottom-insideTop+1);scores.push(q);
        if(q>quality){quality=q;peak=x;}
      }
      if(quality<.7)return null;
      let outer0=peak,outer1=peak;
      while(outer0>lo&&scores[outer0-1-lo]>=.65)outer0--;
      while(outer1<hi&&scores[outer1+1-lo]>=.65)outer1++;
      if(outer1-outer0>dh*.12)return null;
      return{outer0,outer1,quality};
    };
    const left=side(Math.max(top.x0,bottom.x0)),right=side(Math.min(top.x1,bottom.x1));
    if(!left||!right)continue;
    const x0=left.outer0,x1=right.outer1,dw=x1-x0+1;
    if(dw/dh<3.0||dw/dh>4.4||dw<95)continue;
    // Recover a thin top or bottom edge that shared a scanline with a nearby white plate.
    const railQuality=(y:number)=>{let n=0,total=0;for(let x=Math.ceil(x0+dw*.08);x<=x1-dw*.08;x++){n+=white[y*w+x];total++;}return n/Math.max(1,total);};
    let panelTop=y0,panelBottom=y1;
    while(panelTop>sy0&&y0-panelTop<dh*.08&&railQuality(panelTop-1)>.75)panelTop--;
    while(panelBottom<sy1-1&&panelBottom-y1<dh*.08&&railQuality(panelBottom+1)>.75)panelBottom++;
    const ph=panelBottom-panelTop+1;
    if(railQuality(top.y1)<.7||railQuality(bottom.y0)<.7)continue;
    let darkCount=0,total=0;
    for(let y=Math.ceil(panelTop+ph*.1);y<panelBottom-ph*.1;y+=2)for(let x=Math.ceil(x0+dw*.06);x<x1-dw*.06;x+=2){darkCount+=dark[y*w+x];total++;}
    const darkness=darkCount/Math.max(1,total);if(darkness<.65)continue;
    const cropLeft=Math.ceil(x0+dw*.025),cropRight=Math.floor(x1-dw*.025);
    const line=(from:number,to:number,coloured=false):Rect|null=>{
      const lo=Math.ceil(panelTop+ph*from),hi=Math.floor(panelTop+ph*to),mask=coloured?bright:white;
      let first=-1,last=-1,pixels=0,active=0;
      const minInk=Math.max(2,Math.floor(dw*.004));
      for(let y=lo;y<=hi;y++){
        let sum=0;for(let x=cropLeft;x<=cropRight;x++)sum+=mask[y*w+x];
        if(sum>=minInk){if(first<0)first=y;last=y;active++;pixels+=sum;}
      }
      if(first<0||active<Math.max(3,ph*.035)||pixels<Math.max(10,dw*.06))return null;
      // Keep semantic bands stable across words; glyph-dependent boxes would clip later accents
      // or descenders and make the Japanese change signature move when only the text changed.
      return rect(cropLeft,lo,cropRight-cropLeft+1,hi-lo+1);
    };
    const reading=line(.085,.29),japanese=line(.295,.56),roman=line(.575,.89,true);
    if(!reading||!japanese||!roman)continue;
    const confidence=Math.min(1,.4+.2*Math.min(left.quality,right.quality)+.2*darkness+.2*Math.min(railQuality(top.y1),railQuality(bottom.y0)));
    if(!best||confidence>best.confidence)best={panel:rect(x0,panelTop,dw,ph),reading,japanese,roman,confidence};
  }
  return best;
  function rect(x:number,y:number,rw:number,rh:number):Rect{
    const px=clamp(x*stride,0,width-1),py=clamp(y*stride,0,height-1);
    return{x:px/width,y:py/height,width:Math.min(rw*stride,width-px)/width,height:Math.min(rh*stride,height-py)/height};
  }
}
