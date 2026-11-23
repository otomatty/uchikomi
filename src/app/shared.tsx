import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { X, ArrowUpRight, Check, LoaderCircle, Command } from 'lucide-react';
import type { AppData, CaptureStatus } from '../core/types';
import { DEFAULT_SETTINGS, EMPTY_CAPTURE } from '../core/types';
import * as db from '../core/db';

export const isExtension = typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
export const isPanel = location.pathname.includes('sidepanel') || new URLSearchParams(location.search).has('panel');
export const fmt = (n:number) => new Intl.NumberFormat('ja-JP').format(Math.round(n));
export const day = (t:number) => new Intl.DateTimeFormat('ja-JP',{month:'numeric',day:'numeric',timeZone:'Asia/Tokyo'}).format(t);
export const time = (t:number) => new Intl.DateTimeFormat('ja-JP',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Tokyo'}).format(t);
export const uid = () => crypto.randomUUID();
export async function extensionMessage<T=any>(type:string, extra:Record<string,unknown>={}):Promise<T> {
  if(!isExtension) throw new Error('記録機能は、Chromeに読み込んだ拡張から利用できます。');
  const result = await chrome.runtime.sendMessage({type,...extra});
  if(!result?.ok) throw new Error(result?.error || '接続できませんでした。もう一度お試しください。');
  return result;
}
export async function openGame(){
  if(isExtension) return extensionMessage('UCHI_OPEN_GAME');
  window.open('https://sushida.net/play.html','_blank','noopener,noreferrer');
}
export function openWorkspace(path=''){
  const url = isExtension ? chrome.runtime.getURL(`index.html${path}`) : `./index.html${path}`;
  if(isExtension) void chrome.tabs.create({url}); else window.open(url,'_blank','noopener,noreferrer');
}
type AppContextValue={data:AppData;loaded:boolean;status:CaptureStatus;refresh:()=>Promise<void>;notify:(message:string,tone?:'success'|'error')=>void;error:string|null};
const AppContext = createContext<AppContextValue>(null!);
export function AppProvider({children}:{children:ReactNode}){
  const [data,setData]=useState<AppData>({phrases:[],attempts:[],sessions:[],settings:DEFAULT_SETTINGS});
  const [loaded,setLoaded]=useState(false);const [error,setError]=useState<string|null>(null);
  const [status,setStatus]=useState<CaptureStatus>(EMPTY_CAPTURE);
  const [toast,setToast]=useState<{message:string;tone:string}|null>(null);
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const refresh=async()=>{try{setData(await db.getData());setError(null);}catch(e){setError('記録を読み込めませんでした。ページを再読み込みしてください。');}finally{setLoaded(true);}};
  const notify=(message:string,tone:'success'|'error'='success')=>{setToast({message,tone});if(timer.current)clearTimeout(timer.current);timer.current=setTimeout(()=>setToast(null),5000);};
  useEffect(()=>{void refresh();const unsubscribe=db.subscribe(()=>void refresh());return()=>{unsubscribe();if(timer.current)clearTimeout(timer.current);};},[]);
  useEffect(()=>{
    if(!isExtension)return;
    const read=()=>extensionMessage('UCHI_STATUS').then(r=>setStatus(r.status)).catch(()=>{});
    void read();const id=setInterval(read,3000);
    const listener=(m:any)=>{if(m?.type==='UCHI_STATE'&&m.status)setStatus(m.status);};
    chrome.runtime.onMessage.addListener(listener);
    return()=>{clearInterval(id);chrome.runtime.onMessage.removeListener(listener);};
  },[]);
  return <AppContext.Provider value={{data,loaded,status,refresh,notify,error}}>{children}{toast&&<div className={`toast ${toast.tone}`} role={toast.tone==='error'?'alert':'status'}><span className="toast-icon">{toast.tone==='success'?<Check size={16}/>:<X size={16}/>}</span><span>{toast.message}</span><button aria-label="通知を閉じる" onClick={()=>setToast(null)}><X size={15}/></button></div>}</AppContext.Provider>;
}
export const useApp=()=>useContext(AppContext);
export function Brand({small=false}:{small?:boolean}){return <div className={`brand ${small?'small':''}`}><span className="brand-symbol" aria-hidden="true"><Command size={small?19:23} strokeWidth={2.6}/></span><div><strong>UCHIKOMI<span className="brand-dot">.</span></strong>{!small&&<span className="brand-caption">一打ずつ、強くなる。</span>}</div></div>;}
export function Spinner({size=18}:{size?:number}){return <LoaderCircle size={size} className="spin" aria-label="処理中"/>;}
export function Eyebrow({children}:{children:ReactNode}){return <span className="eyebrow">{children}</span>;}
export function SectionTitle({number,title,children}:{number?:string;title:string;children?:ReactNode}){return <div className="section-title"><h2>{number&&<span className="section-number">{number}</span>}{title}</h2>{children}</div>;}
export function EmptyState({symbol,title,body,action}:{symbol:ReactNode;title:string;body?:string;action?:ReactNode}){return <div className="empty-state"><span className="empty-symbol">{symbol}</span><h3>{title}</h3>{body&&<p>{body}</p>}{action}</div>;}
export function Modal({title,subtitle,children,onClose,wide=false}:{title:string;subtitle?:string;children:ReactNode;onClose:()=>void;wide?:boolean}){
  const ref=useRef<HTMLDivElement>(null);const close=useRef(onClose);close.current=onClose;
  useEffect(()=>{const prior=document.activeElement as HTMLElement|null;const old=document.body.style.overflow;document.body.style.overflow='hidden';const el=ref.current!;requestAnimationFrame(()=>el.querySelector<HTMLElement>('input,button,select,textarea,[tabindex="0"]')?.focus());
    const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.stopPropagation();close.current();}if(e.key==='Tab'){const nodes=[...el.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select,textarea,a[href],[tabindex="0"]')].filter(n=>n.offsetParent!==null);if(!nodes.length){e.preventDefault();return;}const first=nodes[0],last=nodes.at(-1)!;if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}};document.addEventListener('keydown',key,true);return()=>{document.body.style.overflow=old;document.removeEventListener('keydown',key,true);prior?.focus();};},[]);
  return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><div className={`modal ${wide?'wide':''}`} role="dialog" aria-modal="true" aria-labelledby="modal-heading" ref={ref}><header className="modal-header"><div><h2 id="modal-heading">{title}</h2>{subtitle&&<p>{subtitle}</p>}</div><button className="icon-button" aria-label="閉じる" onClick={onClose}><X size={20}/></button></header>{children}</div></div>;
}
export function ExternalArrow(){return <ArrowUpRight size={16}/>;}
export function Highlight({text,pattern}:{text:string;pattern?:string}){if(!pattern)return <>{text}</>;const parts=text.split(pattern);return <>{parts.map((s,i)=><span key={i}>{i>0&&<mark>{pattern}</mark>}{s}</span>)}</>;}
