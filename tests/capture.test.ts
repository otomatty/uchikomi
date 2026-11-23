import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedGameUrl, isCalibration, isCaptureStroke, normalizeJapanese, normalizeOcrRoman, normalizeReading, pixelRect, preprocessOcrPixels, signatureDistance, validJapanese, validRoman } from '../src/capture/helpers';

test('capture accepts only the exact official HTTPS origins, not lookalike URLs',()=>{
  for(const url of ['https://sushida.net/play.html','https://www.sushida.net/play/']) assert.equal(isAllowedGameUrl(url),true);
  for(const url of ['https://sushida.net.evil.example/play','https://evil.example/?host=sushida.net','http://sushida.net/play.html','javascript:alert(1)','about:blank','']) assert.equal(isAllowedGameUrl(url),false);
});

test('OCR normalization removes spacing without replacing observed spelling',()=>{
  assert.equal(normalizeJapanese(' ペ ア ル ッ ク\n'),'ペアルック');
  assert.equal(normalizeReading('ペアルック'),'ぺあるっく');
  assert.equal(normalizeOcrRoman('Ｓｈｉ ｎ’'),'shin\'');
  assert.equal(validJapanese('10,000'),false);
  assert.equal(validRoman('30000'),false);
  assert.equal(validRoman('pearukku'),true);
});

test('calibration rejects missing, nonfinite and out-of-viewport rectangles',()=>{
  const valid={japanese:{x:.1,y:.2,width:.7,height:.1},roman:{x:.1,y:.4,width:.7,height:.1},updatedAt:Date.now()};
  assert.equal(isCalibration(valid),true);
  assert.equal(isCalibration({...valid,roman:undefined}),false);
  assert.equal(isCalibration({...valid,japanese:{...valid.japanese,x:-.2}}),false);
  assert.equal(isCalibration({...valid,roman:{...valid.roman,width:1}}),false);
  assert.equal(isCalibration({...valid,roman:{...valid.roman,y:Number.NaN}}),false);
  const pixels=pixelRect({x:.9,y:.9,width:.1,height:.1},1920,1080);
  assert.ok(pixels.x>=0&&pixels.y>=0&&pixels.x+pixels.width<=1920&&pixels.y+pixels.height<=1080);
});

test('key bridge rejects stale, multi-character and nonfinite events',()=>{
  const at=Date.now();
  assert.equal(isCaptureStroke({key:'s',code:'KeyS',at}),true);
  for(const event of [{key:'Enter',at},{key:'abc',at},{key:'s',at:at-300000},{key:'s',at:Infinity},{key:'あ',at},{key:'s'}]) assert.equal(isCaptureStroke(event),false);
});

test('sparse glyph changes remain detectable inside a wide crop',()=>{
  const previous=new Uint8Array(192*32),next=new Uint8Array(192*32);
  previous.fill(255,1000,1040);next.fill(255,1000,1040);next.fill(255,1040,1050);
  assert.equal(signatureDistance(previous,previous),0);
  assert.equal(signatureDistance(new Uint8Array(6144),new Uint8Array(6144)),0);
  assert.ok(signatureDistance(previous,next)>.018, 'one small character change must not vanish into the whitespace');
  assert.equal(signatureDistance(new Uint8Array(6144),next),1);
});

test('OCR keeps a coloured typed prefix and white suffix while suppressing the dark panel',()=>{
  const width=5,height=2;
  const data=new Uint8ClampedArray(width*height*4);
  for(let i=0;i<width*height;i++)data.set([35,27,16,255],i*4);
  const pixels=[[240,61,48,255],[250,135,36,255],[240,240,240,255],[80,90,110,255],[35,27,16,255]];
  pixels.forEach((pixel,i)=>data.set(pixel,(width+i)*4));
  preprocessOcrPixels(data,width,height);
  for(const i of [0,1,2])assert.deepEqual([...data.slice((width+i)*4,(width+i)*4+4)],[0,0,0,255]);
  for(const i of [3,4])assert.deepEqual([...data.slice((width+i)*4,(width+i)*4+4)],[255,255,255,255]);
});
