import test from 'node:test';
import assert from 'node:assert/strict';
import {detectPromptRegions,type PixelFrame} from '../src/capture/auto-region';
import type {Rect} from '../src/core/types';

type Colour=[number,number,number];
function canvas(width:number,height:number,colour:Colour=[4,4,4]):PixelFrame&{data:Uint8ClampedArray}{
  const data=new Uint8ClampedArray(width*height*4);
  for(let i=0;i<data.length;i+=4){data[i]=colour[0];data[i+1]=colour[1];data[i+2]=colour[2];data[i+3]=255;}
  return{data,width,height};
}
function fill(frame:PixelFrame&{data:Uint8ClampedArray},x:number,y:number,w:number,h:number,c:Colour){
  for(let yy=Math.max(0,Math.floor(y));yy<Math.min(frame.height,Math.ceil(y+h));yy++)for(let xx=Math.max(0,Math.floor(x));xx<Math.min(frame.width,Math.ceil(x+w));xx++){
    const i=(yy*frame.width+xx)*4;frame.data[i]=c[0];frame.data[i+1]=c[1];frame.data[i+2]=c[2];
  }
}
/** Original procedural fixture: rounded prompt shape and glyph-like strokes; no game assets. */
function prompt(frame:PixelFrame&{data:Uint8ClampedArray},p:Rect,options:{rows?:number;redRoman?:boolean;mergePlate?:boolean}={}){
  const {x,y,width:w,height:h}=p,rad=Math.round(h*.09),border=Math.max(2,Math.round(h*.04));
  if(options.mergePlate)fill(frame,x-w*.15,y-h*.07,w*.55,h*.1,[250,250,250]);
  const rounded=(xx:number,yy:number,inset:number)=>{
    const rr=Math.max(1,rad-inset),cx=Math.max(x+inset+rr,Math.min(x+w-inset-rr,xx)),cy=Math.max(y+inset+rr,Math.min(y+h-inset-rr,yy));
    return xx>=x+inset&&xx<x+w-inset&&yy>=y+inset&&yy<y+h-inset&&(xx-cx)**2+(yy-cy)**2<=rr**2;
  };
  for(let yy=Math.max(0,y);yy<Math.min(frame.height,y+h);yy++)for(let xx=Math.max(0,x);xx<Math.min(frame.width,x+w);xx++){
    if(!rounded(xx,yy,0))continue;fill(frame,xx,yy,1,1,rounded(xx,yy,border)?[43,34,17]:[249,249,249]);
  }
  const glyphs=[[.14,.115,11],[.33,.17,12],[.64,.16,16]];
  glyphs.slice(0,options.rows??3).forEach(([yy,hh,n],row)=>{
    const gw=h*(row===0?.07:.09),gap=gw*.45,total=n*(gw+gap)-gap,left=x+(w-total)/2;
    for(let i=0;i<n;i++){
      const gx=left+i*(gw+gap),gy=y+yy*h,gh=hh*h,stroke=Math.max(1,h*.014),c:Colour=row===2&&options.redRoman?[240,61,48]:[238,238,238];
      fill(frame,gx,gy,stroke,gh,c);fill(frame,gx,gy,gw,stroke,c);fill(frame,gx,gy+gh*.55,gw,stroke,c);fill(frame,gx+gw-stroke,gy+gh*.55,stroke,gh*.45,c);
    }
  });
}
function withinPixels(actual:Rect,expected:Rect,width:number,height:number,tolerance=4){
  for(const key of ['x','y','width','height'] as const){const scale=key==='x'||key==='width'?width:height;assert.ok(Math.abs(actual[key]*scale-expected[key])<=tolerance,`${key}: ${actual[key]*scale} expected ${expected[key]}`);}
}

test('automatic detector finds all three rows without assuming the viewport position',()=>{
  for(const fixture of [{width:960,height:720,panel:{x:175,y:310,width:600,height:168}},{width:1398,height:1010,panel:{x:394,y:526,width:614,height:173}},{width:1200,height:800,panel:{x:50,y:85,width:400,height:112}}]){
    const f=canvas(fixture.width,fixture.height);fill(f,0,0,f.width,45,[180,180,180]);fill(f,0,46,f.width,5,[250,250,250]);
    prompt(f,fixture.panel,{mergePlate:true});const result=detectPromptRegions(f);assert.ok(result);withinPixels(result.panel,fixture.panel,f.width,f.height);
    assert.ok(result.confidence>.9);assert.ok(result.reading.y+result.reading.height<result.japanese.y);
    assert.ok(result.japanese.y+result.japanese.height<result.roman.y);assert.ok(result.roman.y+result.roman.height<result.panel.y+result.panel.height);
  }
});

test('same layout is found at small and high DPI scales',()=>{
  for(const scale of [.4,.5,.75,1,1.5,3]){
    const f=canvas(Math.round(960*scale),Math.round(720*scale));const p={x:Math.round(180*scale),y:Math.round(320*scale),width:Math.round(600*scale),height:Math.round(168*scale)};
    prompt(f,p);const result=detectPromptRegions(f);assert.ok(result,`scale ${scale}`);withinPixels(result.panel,p,f.width,f.height,Math.max(4,scale*2));
  }
});

test('coloured completed roman characters still validate the roman row',()=>{
  const f=canvas(960,720),p={x:180,y:320,width:600,height:168};prompt(f,p,{redRoman:true});
  assert.ok(detectPromptRegions(f));
});

test('semantic crops stay fixed when glyph height changes between phrases',()=>{
  const f=canvas(960,720),p={x:180,y:320,width:600,height:168};prompt(f,p);
  const before=detectPromptRegions(f);assert.ok(before);
  fill(f,p.x+p.width*.4,p.y+p.height*.51,25,5,[245,245,245]);
  const after=detectPromptRegions(f);assert.ok(after);for(const key of ['panel','reading','japanese','roman'] as const)assert.deepEqual(after[key],before[key]);
});

test('blank screens, page rails and incomplete prompt states do not become OCR regions',()=>{
  for(const colour of [[0,0,0],[255,255,255],[110,165,70]] as Colour[])assert.equal(detectPromptRegions(canvas(960,720,colour)),null);
  for(const rows of [0,1,2]){const f=canvas(960,720);prompt(f,{x:180,y:320,width:600,height:168},{rows});assert.equal(detectPromptRegions(f),null);}
  const chrome=canvas(960,720);fill(chrome,0,50,960,6,[255,255,255]);fill(chrome,0,220,960,6,[255,255,255]);assert.equal(detectPromptRegions(chrome),null);
});

test('a clipped prompt is rejected until its full frame is visible',()=>{
  const f=canvas(600,400);prompt(f,{x:35,y:260,width:600,height:168});assert.equal(detectPromptRegions(f),null);
});

test('optional search bounds constrain the scan and returned coordinates remain frame-relative',()=>{
  const f=canvas(960,720),p={x:180,y:320,width:600,height:168};prompt(f,p);
  const result=detectPromptRegions(f,{searchBounds:{x:.1,y:.3,width:.8,height:.5}});assert.ok(result);withinPixels(result.panel,p,f.width,f.height);
  assert.equal(detectPromptRegions(f,{searchBounds:{x:0,y:0,width:1,height:.2}}),null);
});

test('invalid or transparent pixel buffers are ignored',()=>{
  assert.equal(detectPromptRegions({width:960,height:720,data:new Uint8Array(8)}),null);
  assert.equal(detectPromptRegions({width:NaN,height:720,data:new Uint8Array(8)}),null);
  const f=canvas(960,720);prompt(f,{x:180,y:320,width:600,height:168});for(let i=3;i<f.data.length;i+=4)f.data[i]=0;assert.equal(detectPromptRegions(f),null);
});
