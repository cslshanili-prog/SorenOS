import React,{useEffect,useRef,useState} from 'react';
import {FileOrImageImport} from '../share/FileOrImageImport';
import {DB} from '../../utils/db';
import {shareOrDownloadFile} from '../../utils/shareExport';
import {safeShareFileName} from '../../utils/pngShare';
import {readDecorationFile,validateDecoration,PART_LABELS,DecorationPart,DecorationPreset,DecorationImport} from '../../utils/chatDecoration';
import type {ChatTheme} from '../../types';
const STORE='chat_decoration_presets_v1';
interface Props{onBusyChange:(busy:boolean)=>void;target:string;scope:'character'|'global';currentBubble:ChatTheme;exportCurrent:(name:string)=>Promise<DecorationPreset>;onApply:(preset:DecorationPreset,parts:DecorationPart[])=>Promise<void>}
export default function ChatDecorationPresets({target,scope,currentBubble,exportCurrent,onApply,onBusyChange}:Props){
 const [name,setName]=useState('我的聊天裝扮');const [saved,setSaved]=useState<DecorationPreset[]>([]);const [pending,setPending]=useState<DecorationImport|null>(null);const [parts,setParts]=useState<DecorationPart[]>([]);const [imageUse,setImageUse]=useState<'background'|'user'|'ai'>('background');const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');const saveReady=useRef(false);
 useEffect(()=>{let alive=true;DB.getAsset(STORE).then(raw=>{if(!alive)return;const list=raw?JSON.parse(raw):[];setSaved(Array.isArray(list)?list.map(validateDecoration):[]);saveReady.current=true;}).catch(()=>{if(alive)setError('預設列表讀取失敗，請重新打開後再保存。');});return()=>{alive=false;};},[]);
 const run=async(work:()=>Promise<void>)=>{setBusy(true);onBusyChange(true);setError('');setNotice('');try{await work();}catch(e){setError(e instanceof Error?e.message:'操作失敗，請重試');}finally{setBusy(false);onBusyChange(false);}};
 const stage=(item:DecorationImport)=>{setPending(item);setError('');setNotice('');if(item.kind==='preset')setParts(Object.keys(item.preset.parts) as DecorationPart[]);else setImageUse('background');};
 const save=()=>run(async()=>{if(!saveReady.current)throw Error('預設列表尚未加載，請稍後再試');const preset=await exportCurrent(name.trim()||'我的聊天裝扮');const next=[preset,...saved];await DB.saveAsset(STORE,JSON.stringify(next));setSaved(next);setNotice('整套裝扮已存入我的預設。');});
 const share=()=>run(async()=>{const preset=await exportCurrent(name.trim()||'我的聊天裝扮');await shareOrDownloadFile({content:JSON.stringify(preset,null,2),fileName:safeShareFileName(preset.name)+'.json',mimeType:'application/json',card:{kind:'chat-decoration',title:preset.name}});setNotice('裝扮文件已交給系統分享或下載。');});
 const apply=()=>run(async()=>{
  if(!pending)return;
  let preset:DecorationPreset;let selected=parts;
  if(pending.kind==='preset')preset=pending.preset;
  else if(imageUse==='background'){preset={format:'sullyos-chat-decoration',version:1,name:pending.name,parts:{background:{image:pending.image,style:'plain'}}};selected=['background'];}
  else{const bubble=(await exportCurrent(name)).parts.bubbles!;bubble.name=pending.name;bubble[imageUse].backgroundImage=pending.image;bubble[imageUse].backgroundImageOpacity=1;preset={format:'sullyos-chat-decoration',version:1,name:pending.name,parts:{bubbles:bubble}};selected=['bubbles'];}
  if(!selected.length)throw Error('請至少選擇一項內容');await onApply(preset,selected);setPending(null);setNotice(`已應用到${target}。可以繼續調整，或點「看效果」。`);
 });
 return <div className="chat-decoration-presets">
  <h3>預設</h3><p className="chat-decoration-note">把佈局、氣泡、背景、聲音和進階樣式存成一套，隨時換上或導出分享。CSS、TXT 和圖片也能從這裡導入，再選擇用途。</p><p className="chat-decoration-note">確認後才會應用到 <b>{target}</b>，沒有勾選的部分保持原樣。</p>
  <FileOrImageImport className="chat-decoration-import" disabled={busy} imageAccept="image/*" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void run(async()=>stage(await readDecorationFile(file)));}}/>
  {error&&<p role="alert" className="chat-decoration-error">{error}</p>}{notice&&<p role="status" className="chat-decoration-note">{notice}</p>}
  {pending&&<section className="chat-decoration-import-review">
   <h3>{pending.kind==='image'?'這張圖片用在哪裡？':pending.preset.name}</h3>
   {pending.kind==='image'?<><img src={pending.image} className="chat-decoration-background" alt="待導入圖片"/><div className="chat-decoration-image-choices">{([['background','聊天背景'],['user','我的氣泡貼圖'],['ai','角色氣泡貼圖']] as const).map(([id,label])=><button disabled={busy} key={id} aria-pressed={imageUse===id} onClick={()=>setImageUse(id)}>{label}</button>)}</div></>:<>
    {(Object.keys(pending.preset.parts) as DecorationPart[]).map(key=><label key={key} className="chat-decoration-part"><input disabled={busy} type="checkbox" checked={parts.includes(key)} onChange={()=>setParts(value=>value.includes(key)?value.filter(k=>k!==key):[...value,key])}/><span>{PART_LABELS[key]} <small>{pending.preset.parts[key]===null?'清除 / 靜音':key==='css'&&!pending.preset.parts.css?'清空 CSS':'替換這一項'}</small></span></label>)}
    <details className="chat-decoration-sources"><summary>查看導入內容</summary>{pending.preset.parts.background?.image&&<img className="chat-decoration-background" alt="預設背景" src={pending.preset.parts.background.image}/>}<p>佈局：{pending.preset.parts.layout?Object.keys(pending.preset.parts.layout).length+' 項':'未包含'}<br/>氣泡：{pending.preset.parts.bubbles?.name||'未包含'}<br/>提示音：{pending.preset.parts.sound?.src?.startsWith('data:')?'內嵌音頻':pending.preset.parts.sound?.src||'未包含或靜音'}</p>{pending.preset.parts.css!==undefined&&<pre className="chat-decoration-code-preview">{pending.preset.parts.css||'（空）'}</pre>}</details>
   </>}
   <p className="chat-decoration-note">應用範圍：{target}{scope==='global'?'，已有專屬設置的角色仍保留自己的選擇。':''}</p>
   <div className="chat-decoration-preset-actions"><button disabled={busy||(pending.kind==='preset'&&!parts.length)} onClick={apply}>{busy?'處理中…':'確認應用'}</button><button disabled={busy} onClick={()=>setPending(null)}>取消</button></div>
  </section>}
  <section className="chat-decoration-preset-save"><h3>保存當前整套裝扮</h3><label className="chat-decoration-field">預設名稱<input value={name} maxLength={60} onChange={e=>setName(e.target.value)} aria-label="裝扮預設名稱"/></label><p className="chat-decoration-note">包含當前佈局、氣泡、背景、聲音和 CSS。本地圖片會打包進文件，外鏈素材仍需聯網。</p><div className="chat-decoration-preset-actions"><button disabled={busy} onClick={save}>存為預設</button><button disabled={busy} onClick={share}>導出分享</button></div></section>
  <section className="chat-decoration-preset-save"><h3>我的預設</h3>{saved.length?saved.map((preset,index)=><div key={index} className="chat-decoration-saved"><button disabled={busy} onClick={()=>stage({kind:'preset',preset})}>{preset.name}<small>查看並應用 →</small></button><button aria-label={`刪除預設 ${preset.name}`} disabled={busy} onClick={()=>run(async()=>{const next=saved.filter((_,i)=>i!==index);await DB.saveAsset(STORE,JSON.stringify(next));setSaved(next);})}>刪除</button></div>):<p className="chat-decoration-note">保存喜歡的搭配，下次可以整套換上。</p>}</section>
 </div>;
}
