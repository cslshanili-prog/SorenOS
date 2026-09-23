import React, {useEffect, useId, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import './ChatDecorationAnnouncement.css';
import { useFirstUseGuideStep } from '../../utils/firstUseGuide';
const acknowledged = new Set<string>();
const prefix = 'sully-chat-decoration-announcement-v1:';
export default function ChatDecorationAnnouncement({surface}:{surface:'appearance'|'chat'}) {
 const guideActive=useFirstUseGuideStep()!==null;
 const key=prefix+surface;
 const legacyKey=surface==='chat'?prefix+'decoration':key;
 const [visible,setVisible]=useState(()=>{try{return !acknowledged.has(key)&&localStorage.getItem(key)!=='seen'&&localStorage.getItem(legacyKey)!=='seen';}catch{return !acknowledged.has(key);}});
 const dialog=useRef<HTMLDialogElement>(null);const title=useId();
 useEffect(()=>{if(visible&&!guideActive&&!dialog.current?.open)dialog.current?.showModal();},[visible,guideActive]);
 const dismiss=()=>{acknowledged.add(key);try{localStorage.setItem(key,'seen');}catch{/* Read-only storage: remember for this session. */}dialog.current?.close();setVisible(false);};
 if(!visible||guideActive)return null;
 return createPortal(<dialog ref={dialog} className="chat-decoration-announcement" aria-labelledby={title} onCancel={event=>{event.preventDefault();dismiss();}}>
  <small>CHATAPP · 裝扮更新</small>
  <h2 id={title}>喜歡的樣子，在一處調好。</h2>
  <p className="decoration-announcement-intro">聊天美化搬到一起了，原有設置會繼續保留。</p>
  <ol>
   <li><h3>一個入口，調整整套聊天</h3><p>打開聊天 →「＋」→「聊天裝扮」。外觀 App 的聊天界面與佈局、聊天設置裡的背景，以及加號裡的聊天裝扮、提示音和白框，都整合到這裡。白框在「進階」，提示音在「聲音」。</p></li>
   <li><h3>預設可以整套分享</h3><p>佈局、氣泡、背景、聲音和進階樣式，可以一起保存、導出，再整套導入；也能只勾選需要的部分。</p></li>
   <li><h3>導入文件，自動識別內容</h3><p>在「預設」導入整套裝扮、CSS / TXT、分享圖或普通圖片。系統會識別內容，再引導你選擇用途和應用範圍，確認後才修改。</p></li>
  </ol>
  <button type="button" onClick={dismiss} autoFocus>知道了</button>
 </dialog>,document.body);
}
