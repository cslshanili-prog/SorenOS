import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, CaretRight, X } from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import type { CharacterProfile, VRRoomId, VRSARActivity, VRWorldCharState } from '../../types';
import { ORDINARY_ACTIVITIES, SAR_ACTIVITIES } from '../../utils/vrWorld/activityChoices';
import './vr-activity-picker.css';

export function VRActivityPicker({char,libraryAvailable,gardenReason,onGo,onClose}:{
    char:CharacterProfile; libraryAvailable:boolean; gardenReason?:string;
    onGo:(room?:VRRoomId,activity?:VRSARActivity)=>void; onClose:()=>void;
}) {
    const [group,setGroup]=useState<'ordinary'|'sar'|null>(null);
    const panel=useRef<HTMLElement>(null), {registerBackHandler}=useOS();
    const back=()=>group?setGroup(null):onClose();
    const latestBack=useRef(back);latestBack.current=back;
    useEffect(()=>registerBackHandler(()=>{latestBack.current();return true;}),[registerBackHandler]);
    useEffect(()=>{
        const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();latestBack.current();}};
        window.addEventListener('keydown',escape,true);
        return ()=>window.removeEventListener('keydown',escape,true);
    },[]);
    useEffect(()=>{panel.current?.querySelector<HTMLButtonElement>('header button')?.focus();},[group]);
    useEffect(()=>{
        const previous=document.activeElement;
        panel.current?.querySelector<HTMLButtonElement>('header button')?.focus();
        return ()=>{if(previous instanceof HTMLElement&&previous.isConnected)previous.focus({preventScroll:true});};
    },[]);
    return <div className="vra-backdrop" onClick={onClose} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();back();}}}>
        <section ref={panel} className="vra-picker" role="dialog" aria-modal="true" aria-label={`邀請${char.name}活動`} onClick={e=>e.stopPropagation()} onKeyDown={e=>{
            if(e.key!=='Tab')return;
            const elements=Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled)')||[]);
            if(document.activeElement===(e.shiftKey?elements[0]:elements.at(-1))){e.preventDefault();(e.shiftKey?elements.at(-1):elements[0])?.focus();}
        }}>
            <header><button aria-label={group?'返回活動分類':'關閉活動選擇'} onClick={back}>{group?<ArrowLeft size={20}/>:<X size={20}/>}</button><div><small>KANATA · INVITATION</small><h2>{group==='ordinary'?'普通空間':group==='sar'?'SAR 活動室':`讓 ${char.name} 去哪裡？`}</h2></div></header>
            <main>{!group?<>
                <button className="vra-group" onClick={()=>setGroup('ordinary')}><span><b>普通空間</b><small>讀書、聽歌、版聊、寫信……</small></span><CaretRight size={18}/></button>
                <button className="vra-group" onClick={()=>setGroup('sar')}><span><b>SAR 活動室</b><small>芯片、模塊、釣魚、佈告板、箱庭</small></span><CaretRight size={18}/></button>
            </>:group==='ordinary'?ORDINARY_ACTIVITIES.map(a=><button className="vra-choice" key={a.id} disabled={a.id==='library'&&!libraryAvailable} onClick={()=>onGo(a.id)}><span><b>{a.name}</b><small>{a.id==='library'&&!libraryAvailable?'閱讀範圍內還沒有書':a.description}</small></span><CaretRight size={15}/></button>):SAR_ACTIVITIES.map(a=><button className="vra-choice" key={a.id} disabled={a.id==='garden'&&!!gardenReason} onClick={()=>onGo('sar',a.id)}><span><b>{a.name}</b><small>{a.id==='garden'&&gardenReason?gardenReason:a.description}</small></span><CaretRight size={15}/></button>)}</main>
            <footer><p>手動邀請可前往高級選項中限制的地方。</p>{!group?<button onClick={()=>onGo()}>隨便逛逛</button>:group==='sar'?<button onClick={()=>onGo('sar')}>在活動室隨便玩一樣</button>:null}</footer>
        </section>
    </div>;
}

export function VRActivityRestrictions({char,onChange}:{char:CharacterProfile;onChange:(update:(state:VRWorldCharState)=>VRWorldCharState)=>void}) {
    const rooms=char.vrState?.excludedAutoRooms||[], sar=char.vrState?.excludedAutoSARActivities||[];
    const sarBlocked=rooms.includes('sar');
    const count=ORDINARY_ACTIVITIES.filter(a=>rooms.includes(a.id)).length+(sarBlocked?SAR_ACTIVITIES.length:SAR_ACTIVITIES.filter(a=>sar.includes(a.id)).length);
    return <details className="vra-restrictions"><summary>高級選項 <span>{count?`${count} 項不自動前往`:'自由活動範圍'}</span></summary>
        <p>勾選不希望 ta 自動去的地方。僅限制自動活動，手動邀請仍然有效；正在進行的一輪可以完成。</p>
        <fieldset><legend>普通空間</legend>{ORDINARY_ACTIVITIES.map(a=><label key={a.id}><input type="checkbox" aria-label={`不自動去${a.name}`} checked={rooms.includes(a.id)} onChange={()=>onChange(s=>({...s,excludedAutoRooms:toggle(s.excludedAutoRooms,a.id)}))}/><span>{a.name}</span></label>)}</fieldset>
        <fieldset><legend>SAR 活動室</legend><label className="vra-whole"><input type="checkbox" aria-label="不自動去整個SAR活動室" checked={sarBlocked} onChange={()=>onChange(s=>({...s,excludedAutoRooms:toggle(s.excludedAutoRooms,'sar')}))}/><span>整個活動室都不去</span></label>{SAR_ACTIVITIES.map(a=><label key={a.id} className={sarBlocked?'is-inherited':''}><input type="checkbox" aria-label={`不自動玩${a.name}`} checked={sarBlocked||sar.includes(a.id)} disabled={sarBlocked} onChange={()=>onChange(s=>({...s,excludedAutoSARActivities:toggle(s.excludedAutoSARActivities,a.id)}))}/><span>{a.name}</span></label>)}</fieldset>
        {count===ORDINARY_ACTIVITIES.length+SAR_ACTIVITIES.length&&<p role="status">全部自動活動已排除；到點會跳過，不調用模型。你仍可手動邀請。</p>}
        <button type="button" disabled={!count} onClick={()=>onChange(s=>({...s,excludedAutoRooms:[],excludedAutoSARActivities:[]}))}>恢復全部可去</button>
    </details>;
}

function toggle<T extends string>(values:T[]|undefined,id:T):T[]{return values?.includes(id)?values.filter(x=>x!==id):[...(values||[]),id];}
