import React, {useState} from 'react';
import {createPortal} from 'react-dom';
import type {CharacterProfile, ChatTheme, OSTheme} from '../../types';
import ChatLayoutSettings from './ChatLayoutSettings';
import ChromeCssEditor from './ChromeCssEditor';
import WhiteboxSoundEditor from './WhiteboxSoundEditor';
import {mergeChatFineTune,CHAT_FINE_TUNE_KEYS} from '../../utils/chatFineTuneCss';
import {parseWhiteboxSound,upsertWhiteboxSound,stripWhiteboxSoundDirective,WhiteboxSound} from '../../utils/whiteboxSound';
import './ChatDecorationPanel.css';
import ChatDecorationPresets from './ChatDecorationPresets';
import {exportDecoration,decorationPatches,resolveDecorationTheme,decorationCssPatch} from '../../utils/chatDecoration';
import {useBlobRefUrl,putImageBlob} from '../../utils/blobRef';

export type DecorationTab = 'layout'|'bubbles'|'background'|'sound'|'css'|'presets';
const tabs: {id:DecorationTab;name:string}[] = [{id:'layout',name:'佈局'},{id:'bubbles',name:'氣泡'},{id:'background',name:'背景'},{id:'sound',name:'聲音'},{id:'css',name:'進階'},{id:'presets',name:'預設'}];
interface Props {
 character: CharacterProfile; theme: OSTheme; themes: ChatTheme[];
 updateCharacter: (patch:Partial<CharacterProfile>)=>void|Promise<void>;
 onSaveBubble:(bubble:ChatTheme)=>void|Promise<void>;
 updateTheme:(patch:Partial<OSTheme>)=>void|Promise<void>;
 onBgUpload:(file:File)=>void; backgroundUrl?:string|null;
 onOpenWorkshop:()=>void; onClose:()=>void; initialTab?:DecorationTab;
}
export default function ChatDecorationPanel({character:char,theme,themes,updateCharacter,updateTheme,onBgUpload,backgroundUrl,onOpenWorkshop,onClose,onSaveBubble,initialTab='layout'}:Props){
 const [tab,setTab]=useState<DecorationTab>(initialTab);
 const [scope,setScope]=useState<'character'|'global'>('character');
 const [collapsed,setCollapsed]=useState(false);
 const [presetBusy,setPresetBusy]=useState(false);
 const [panelOpacity,setPanelOpacity]=useState(100);
 const global=scope==='global';
 const override=char.chatFineTune;
 const customized=override?.enabled===true;
 const characterTheme=resolveDecorationTheme(theme,char);
 const effective=global?theme:{...characterTheme,...mergeChatFineTune(characterTheme,override)};
 const displayedBackground=useBlobRefUrl(global?theme.chatBackground:(char.chatBackground??theme.chatBackground));
 const css=global?theme.chatChromeCustomCss:char.chromeCustomCss;
 const boundSound=parseWhiteboxSound(css);
 const bound=global?!!boundSound:!!char.chatSoundBound||!!boundSound;
 const sound:WhiteboxSound|null=bound?boundSound:((global?theme.chatSound:char.chatSound)||null);
 const setCss=(value:string,reset=false)=>{const patch=decorationCssPatch(value,scope,char,theme,reset);return global?updateTheme(patch):updateCharacter(patch);};
 const changeSound=(value:WhiteboxSound|null)=>{
   if(global) updateTheme(bound?{chatChromeCustomCss:upsertWhiteboxSound(css||'',value),chatSound:undefined}:{chatSound:value||undefined});
   else updateCharacter(bound?{chromeCustomCss:upsertWhiteboxSound(css||'',value),chatSound:undefined}:{chatSound:value||undefined});
 };
 const changeBound=(value:boolean)=>updateCharacter(value
   ?{chromeCustomCss:upsertWhiteboxSound(css||'',sound),chatSound:undefined,chatSoundBound:true}
   :{chromeCustomCss:stripWhiteboxSoundDirective(css||''),chatSound:sound||undefined,chatSoundBound:false});
 const activeBubble=themes.find(t=>t.id===((global?theme.chatDefaultBubbleStyle:char.bubbleStyle||theme.chatDefaultBubbleStyle)||'default'))||themes[0];
 const switchTab=(next:DecorationTab)=>setTab(next);
 return createPortal(<>
  {collapsed&&<button type="button" className="chat-decoration-return" onClick={()=>setCollapsed(false)}>返回裝扮</button>}
  <aside className={`chat-decoration ${collapsed?'is-collapsed':''}`} aria-label="ChatApp 裝扮" style={{backgroundColor:`rgba(250,249,252,${panelOpacity/100})`}}>
   <header className="chat-decoration-heading">
    <div><small>CHATAPP</small><h2>裝扮</h2></div>
    <label className="chat-decoration-opacity"><span>透明度 <output>{panelOpacity}%</output></span><input type="range" aria-label="面板透明度" min="30" max="100" step="5" value={panelOpacity} style={{['--slider-fill' as string]:`${(panelOpacity-30)/70*100}%`}} onChange={event=>setPanelOpacity(Number(event.target.value))}/></label>
    <div className="chat-decoration-tools"><button type="button" disabled={presetBusy} onClick={()=>setCollapsed(!collapsed)}>{collapsed?'展開':'看效果'}</button><button type="button" disabled={presetBusy} onClick={onClose}>完成</button></div>
   </header>
   {!collapsed&&<>
    <div className="chat-decoration-scope"><span>正在設置</span><div className="chat-decoration-scope-buttons" role="group" aria-label="正在設置"><button type="button" aria-pressed={!global} disabled={presetBusy} onClick={()=>setScope('character')} title={`${char.name}專屬`}>{char.name}專屬</button><button type="button" aria-pressed={global} disabled={presetBusy} onClick={()=>setScope('global')}>全局默認</button></div></div>
    <p className="chat-decoration-summary">{global?'全局修改會影響未單獨定製的聊天。':`佈局${customized?'已單獨定製':'跟隨全局'} · 氣泡 ${activeBubble?.name||'默認'}`}</p>
    <nav className="chat-decoration-tabs" aria-label="裝扮分類">{tabs.map(item=><button key={item.id} type="button" aria-pressed={tab===item.id} disabled={presetBusy} onClick={()=>switchTab(item.id)}>{item.name}</button>)}</nav>
    <div className="chat-decoration-body" key={tab}>
     {tab==='presets'&&<ChatDecorationPresets onBusyChange={setPresetBusy} target={global?'全局默認':`${char.name}專屬`} scope={scope} currentBubble={activeBubble} exportCurrent={name=>exportDecoration(name,theme,global?undefined:char,activeBubble)} onApply={async(preset,parts)=>{const changes=await decorationPatches(preset,parts,scope,char,theme);if(changes.bubble)await onSaveBubble(changes.bubble);if(global)await updateTheme(changes.theme);else await updateCharacter(changes.character);}}/>}
     {tab==='layout'&&<>
      <h3>界面與頭像</h3>
      {!global&&<label className="chat-decoration-toggle"><span>為 {char.name} 單獨調整佈局<small>關閉後跟隨全局，已調好的內容會保留。</small></span><input type="checkbox" checked={customized} onChange={()=>updateCharacter({chatFineTune:{...override,enabled:!customized}})}/></label>}
      {(global||customized)?<ChatLayoutSettings theme={effective} updateTheme={patch=>{if(global){void updateTheme(patch);return;}const fine=Object.fromEntries(Object.entries(patch).filter(([key])=>(CHAT_FINE_TUNE_KEYS as readonly string[]).includes(key)));void updateCharacter({chatAppearance:{...char.chatAppearance,...patch},chatFineTune:{...override,...fine,enabled:true}});}}/>:<p className="chat-decoration-note">想一起調整所有聊天，可以在上方切換到「全局默認」。</p>}
      <p className="chat-decoration-note">{char.chromeCustomCss||theme.chatChromeCustomCss?'當前有進階 CSS，可能覆蓋佈局和氣泡的部分效果。可在「進階」查看。':'佈局調整會實時顯示在聊天中。'}</p>
     </>}
     {tab==='bubbles'&&<>
      <h3>氣泡主題</h3>
      {!global&&<button className="chat-decoration-link" onClick={()=>updateCharacter({bubbleStyle:undefined})}>跟隨全局氣泡</button>}
      {<div className="chat-decoration-bubbles">{themes.map(item=><button key={item.id} type="button" aria-pressed={activeBubble?.id===item.id} onClick={()=>global?updateTheme({chatDefaultBubbleStyle:item.id}):updateCharacter({bubbleStyle:item.id})}><span className="chat-decoration-bubble-sample" style={{background:item.user.backgroundColor,color:item.user.textColor,borderRadius:Math.min(item.user.borderRadius,16)}}>你好呀</span><span>{item.name}</span></button>)}</div>}
      <button className="chat-decoration-link" onClick={onOpenWorkshop}>打開氣泡工坊 · 製作與導入 →</button>
     </>}
     {tab==='background'&&<>
      <h3>聊天背景</h3>
      {global&&<label className="chat-decoration-field">默認背景底紋<select value={theme.chatBackgroundStyle||'plain'} onChange={e=>updateTheme({chatBackgroundStyle:e.target.value as OSTheme['chatBackgroundStyle']})}>{[['plain','純色'],['grid','網格'],['paper','紙張'],['mesh','柔光']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>}
       {displayedBackground?<img className="chat-decoration-background" src={displayedBackground} alt="當前聊天背景"/>:<p className="chat-decoration-note">當前使用全局背景；可以為這個角色換一張圖片。</p>}
       <label className="chat-decoration-upload">選擇背景圖片<input aria-label="選擇背景圖片" type="file" accept="image/*" onChange={e=>{const f=e.target.files?.[0];if(f){if(global)void putImageBlob(f).then(ref=>updateTheme({chatBackground:ref}));else onBgUpload(f);}e.target.value='';}}/></label>
       {(global?theme.chatBackground:char.chatBackground!==undefined)&&<button className="chat-decoration-link" onClick={()=>global?updateTheme({chatBackground:undefined}):updateCharacter({chatBackground:undefined})}>{global?'移除全局背景圖片':'移除專屬背景，跟隨全局'}</button>}
     </>}
     {tab==='sound'&&<>
      <h3>消息提示音</h3>
      <WhiteboxSoundEditor key={scope} sound={sound} bound={bound} showBind={!global} onChangeSound={changeSound} onChangeBound={changeBound} hint={global?'未設置專屬提示音的角色會使用這裡的聲音。':'角色的新回覆到達時響一次。不設置則跟隨全局提示音。'}/>
     </>}
     {tab==='css'&&<>
      <h3>進階 CSS <span className="chat-decoration-former">原白框</span></h3>
      <p className="chat-decoration-note">{global?'全局 CSS 先應用，再疊加角色 CSS。':char.chatDecorationCssIsolated?'當前使用導入預設的獨立 CSS，不疊加全局 CSS。':'角色 CSS 疊加在全局之上；原來的預設與分享文件仍可使用。'}</p>
      <details className="chat-decoration-sources"><summary>查看生效來源</summary><p>全局 CSS：{theme.chatChromeCustomCss?.trim()?'已設置':'未設置'}<br/>角色 CSS：{char.chromeCustomCss?.trim()?'已設置':'未設置'}<br/>氣泡主題：{activeBubble?.name||'默認'}{activeBubble?.customCss?'（含 CSS）':''}</p></details>
      <ChromeCssEditor key={scope} value={css||''} onChange={value=>setCss(value)}/>
     </>}
    </div>
   </>}
  </aside>
  {tab==='css'&&<>
   <style>{`#sully-safe-reset{position:fixed!important;top:calc(var(--safe-top,0px) + 6px)!important;left:50%!important;transform:translateX(-50%)!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important;display:flex!important;z-index:2147483647!important;}`}</style>
   <button id="sully-safe-reset" style={{padding:'7px 12px',borderRadius:20,background:'#272537',color:'#fff',border:'1px solid #fff6',fontSize:11}} onClick={()=>setCss('',true)}>還原{global?'全局':'此角色'} CSS</button>
  </>}
 </>,document.body);
}
