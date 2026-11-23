import test from 'node:test';
import assert from 'node:assert/strict';
import { detectResultRegions, findAmountRect, preprocessResultPixels } from '../src/capture/auto-result';
import type { PixelFrame } from '../src/capture/auto-region';
import type { Rect } from '../src/core/types';

type Colour = [number, number, number];
type Frame = PixelFrame & {data:Uint8ClampedArray};
function canvas(width:number,height:number,colour:Colour=[12,16,14]):Frame {
  const data=new Uint8ClampedArray(width*height*4);
  for(let i=0;i<data.length;i+=4){data[i]=colour[0];data[i+1]=colour[1];data[i+2]=colour[2];data[i+3]=255;}
  return {width,height,data};
}
function fill(frame:Frame,x:number,y:number,w:number,h:number,c:Colour) {
  for(let yy=Math.max(0,Math.round(y));yy<Math.min(frame.height,Math.round(y+h));yy++)for(let xx=Math.max(0,Math.round(x));xx<Math.min(frame.width,Math.round(x+w));xx++){
    const i=(yy*frame.width+xx)*4;frame.data[i]=c[0];frame.data[i+1]=c[1];frame.data[i+2]=c[2];
  }
}
function glyphs(frame:Frame,x:number,y:number,count:number,size:number,c:Colour) {
  for(let i=0;i<count;i++){
    const left=x+i*size*.75,stroke=Math.max(1,size*.12);
    fill(frame,left,y,stroke,size,c);fill(frame,left,y,size*.5,stroke,c);
    fill(frame,left+size*.4,y+size*.5,stroke,size*.5,c);fill(frame,left,y+size-stroke,size*.5,stroke,c);
  }
}
/** Independent receipt geometry; no artwork or text copied from the game. */
function receipt(frame:Frame,box:Rect,options:{loss?:boolean;banner?:boolean;darkHeader?:boolean}={}) {
  const {x,y,width:w,height:h}=box;
  fill(frame,x,y,w,h,[255,255,255]);
  const top=y+w*.04,headerHeight=w*.09;
  if(options.darkHeader!==false)fill(frame,x,top,w,headerHeight,[53,53,53]);
  glyphs(frame,x+w*.25,top+headerHeight*.23,10,headerHeight*.55,[244,244,244]);
  glyphs(frame,x+w*.22,y+w*.18,6,w*.038,[15,15,15]);
  glyphs(frame,x+w*.22,y+w*.255,6,w*.038,[15,15,15]);
  if(options.banner!==false){
    const c:Colour=options.loss?[180,40,26]:[95,143,14];
    const left=x+w*.04,btop=y+w*.34,bw=w*.92,bh=w*.1,border=Math.max(2,w*.008);
    fill(frame,left,btop,bw,bh,c);fill(frame,left+border,btop+border,bw-2*border,bh-2*border,[255,255,255]);
    glyphs(frame,x+w*.18,btop+bh*.2,6,bh*.6,[15,15,15]);
    glyphs(frame,x+w*.53,btop+bh*.24,7,bh*.5,c);
  }
  glyphs(frame,x+w*.15,y+w*.5,7,w*.03,[70,70,70]);
}
function bounded(r:Rect) {
  assert.ok(r.x>=0&&r.y>=0&&r.width>0&&r.height>0);
  assert.ok(r.x+r.width<=1.001&&r.y+r.height<=1.001);
}

test('result receipt is detected independently of viewport placement and scale',()=>{
  for(const scale of [.5,.75,1,1.5]){
    const f=canvas(Math.round(1280*scale),Math.round(900*scale));
    const box={x:Math.round(245*scale),y:Math.round(95*scale),width:Math.round(700*scale),height:Math.round(500*scale)};
    receipt(f,box);
    const result=detectResultRegions(f);assert.ok(result,`scale ${scale}`);
    assert.ok(result.confidence>.8);
    for(const key of ['panel','header','total','paid','profit'] as const)bounded(result[key]);
    assert.ok(Math.abs(result.panel.x*f.width-box.x)<4);
    assert.ok(Math.abs(result.panel.width*f.width-box.width)<4);
    assert.ok(result.header.y<result.total.y&&result.total.y<result.paid.y&&result.paid.y<result.profit.y);
    assert.ok(result.total.x>result.panel.x,'skip the decorative stamp at the left of amount lines');
  }
  const moved=canvas(1500,960);receipt(moved,{x:65,y:210,width:600,height:430});
  assert.ok(detectResultRegions(moved));
});

test('red loss banner uses the same receipt layout without becoming positive evidence',()=>{
  const f=canvas(1280,900);receipt(f,{x:245,y:95,width:700,height:500},{loss:true});
  assert.ok(detectResultRegions(f));
  // The detector returns geometry only. Profit/loss sign must be established by text parsing.
  assert.equal('score' in detectResultRegions(f)!,false);
});

test('blank, ranking-like and gameplay-like screens are not result receipts',()=>{
  for(const colour of [[0,0,0],[255,255,255],[100,150,80]] as Colour[])assert.equal(detectResultRegions(canvas(1280,900,colour)),null);
  const ranking=canvas(1280,900);receipt(ranking,{x:245,y:95,width:700,height:500},{banner:false});
  assert.equal(detectResultRegions(ranking),null);
  const noHeader=canvas(1280,900);receipt(noHeader,{x:245,y:95,width:700,height:500},{darkHeader:false});
  assert.equal(detectResultRegions(noHeader),null);
  const game=canvas(1280,900,[160,183,75]);
  fill(game,200,400,600,175,[255,255,255]);fill(game,207,407,586,161,[40,31,15]);
  for(const y of [426,462,512])glyphs(game,370,y,10,22,[255,255,255]);
  assert.equal(detectResultRegions(game),null);
});

test('clipped, invalid and fully transparent result images are rejected',()=>{
  const clipped=canvas(700,550);receipt(clipped,{x:245,y:95,width:700,height:500});
  assert.equal(detectResultRegions(clipped),null);
  assert.equal(detectResultRegions({width:1280,height:900,data:new Uint8Array(20)}),null);
  assert.equal(detectResultRegions({width:NaN,height:900,data:new Uint8Array(20)}),null);
  const transparent=canvas(1280,900);receipt(transparent,{x:245,y:95,width:700,height:500});
  for(let i=3;i<transparent.data.length;i+=4)transparent.data[i]=0;
  assert.equal(detectResultRegions(transparent),null);
});

test('result OCR preprocessing uses explicit polarity and preserves coloured explanatory text',()=>{
  const light=new Uint8ClampedArray([255,255,255,255,20,20,20,255,100,145,15,255,190,32,24,255]);
  preprocessResultPixels(light,4,1,false);
  assert.deepEqual([...light],[255,255,255,255,0,0,0,255,0,0,0,255,0,0,0,255]);
  const dark=new Uint8ClampedArray([53,53,53,255,245,245,245,255,210,190,15,255]);
  preprocessResultPixels(dark,3,1,true);
  assert.deepEqual([...dark],[255,255,255,255,0,0,0,255,0,0,0,255]);
});

test('numeric cross-check crop isolates black digits from green labels and the border',()=>{
  const f=canvas(640,70,[255,255,255]);
  fill(f,0,0,640,4,[95,143,14]);fill(f,0,66,640,4,[95,143,14]);
  glyphs(f,60,14,6,38,[15,15,15]);glyphs(f,300,14,10,38,[95,143,14]);
  const result=findAmountRect(f,'profit');assert.ok(result);bounded(result);
  assert.ok(result.x*f.width<=60&&result.x*f.width>40);
  assert.ok((result.x+result.width)*f.width<300,'the green label must not enter numeric OCR');
  assert.equal(findAmountRect(canvas(640,70,[255,255,255]),'profit'),null);
  const onlyLabel=canvas(640,70,[255,255,255]);glyphs(onlyLabel,60,14,10,38,[95,143,14]);
  assert.equal(findAmountRect(onlyLabel,'profit'),null);
});
