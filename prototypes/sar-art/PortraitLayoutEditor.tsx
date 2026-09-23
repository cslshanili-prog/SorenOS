import React,{useEffect,useState,type CSSProperties} from 'react';
import {SARCaianDialogue} from '../../apps/vrWorld/SARClubEvent';
import {SARAivenDialogue} from '../../apps/vrWorld/SARAivenDialogue';
import './portrait-layout-editor.css';

type Person='caian'|'aiven';
type Placement={scale:number;x:number;y:number};
type Layout={caian:Placement;aiven:Placement;front:'auto'|Person};
const KEY='sar-art:portrait-layout-draft:v1';
const INITIAL:Layout={caian:{scale:150,x:27,y:0},aiven:{scale:150,x:75,y:0},front:'auto'};
const ORIGINAL:Layout={caian:{scale:100,x:29.5,y:0},aiven:{scale:100,x:78,y:0},front:'auto'};
const clamp=(value:unknown,fallback:number,min:number,max:number)=>typeof value==='number'&&Number.isFinite(value)?Math.max(min,Math.min(max,value)):fallback;
function loadLayout():Layout{
    try{
        const data=JSON.parse(localStorage.getItem(KEY)||'null');if(!data)return INITIAL;
        const person=(who:Person):Placement=>({scale:clamp(data[who]?.scale,150,60,180),x:clamp(data[who]?.x,INITIAL[who].x,-10,110),y:clamp(data[who]?.y,0,-25,35)});
        return {caian:person('caian'),aiven:person('aiven'),front:['auto','caian','aiven'].includes(data.front)?data.front:'auto'};
    }catch{return INITIAL;}
}

/** Temporary artwork fixture; never mounted by VRWorldApp. */
export default function PortraitLayoutEditor(){
    const [layout,setLayout]=useState<Layout>(loadLayout),[person,setPerson]=useState<Person>('caian');
    const [speaker,setSpeaker]=useState<Person>('caian'),[expanded,setExpanded]=useState(true);
    const [saveState,setSaveState]=useState(''),[copyState,setCopyState]=useState('複製參數');
    useEffect(()=>{
        try{localStorage.setItem(KEY,JSON.stringify(layout));setSaveState('已自動保存到此瀏覽器');}catch{setSaveState('未能保存，請複製參數');}
    },[layout]);
    useEffect(()=>{
        Object.assign(window,{render_game_to_text:()=>JSON.stringify({mode:'sar-portrait-editor',layout,speaker}),advanceTime:()=>Promise.resolve()});
    },[layout,speaker]);
    const style={
        '--sar-caian-x':`${layout.caian.x}%`,'--sar-caian-y':`${layout.caian.y}%`,'--sar-caian-scale':layout.caian.scale/100,
        '--sar-aiven-x':`${layout.aiven.x}%`,'--sar-aiven-y':`${layout.aiven.y}%`,'--sar-aiven-scale':layout.aiven.scale/100,
        ...(layout.front==='auto'?{}:{'--sar-caian-depth':layout.front==='caian'?3:1,'--sar-aiven-depth':layout.front==='aiven'?3:1}),
    } as CSSProperties;
    const update=(key:keyof Placement,value:number)=>{setCopyState('複製參數');setLayout(old=>({...old,[person]:{...old[person],[key]:value}}));};
    const text=JSON.stringify(layout,null,2);
    return <main className={`sar-layout-editor ${expanded?'is-expanded':''}`}>
        <section className="sar-layout-preview" style={style} aria-label="雙人對話預覽">
            {speaker==='caian'?<SARCaianDialogue onClose={()=>location.assign('/prototypes/sar-art/index.html')} onComplete={()=>setSpeaker('aiven')}/>:<SARAivenDialogue onClose={()=>setSpeaker('caian')} onOpen={()=>setSpeaker('caian')}/>}
        </section>
        <aside className="sar-layout-tools" aria-label="立繪位置編輯器">
            <button type="button" className="sar-layout-handle" onClick={()=>setExpanded(v=>!v)} aria-expanded={expanded}>
                <span>立繪調節 <small>臨時預覽</small></span><span>{expanded?'收起 ↓':'展開 ↑'}</span>
            </button>
            <div className="sar-layout-controls">
                <p className="sar-layout-hint">從頂部安全線縮放，可重疊。上下正值向上。</p>
                <div className="sar-layout-tabs" aria-label="選擇要調整的角色">{(['caian','aiven'] as const).map(who=><button type="button" key={who} aria-pressed={person===who} onClick={()=>setPerson(who)}>{who==='caian'?'凱恩':'艾文'}</button>)}</div>
                {([{key:'scale',label:'大小',min:60,max:180,step:1},{key:'x',label:'左右',min:-10,max:110,step:.5},{key:'y',label:'上下',min:-25,max:35,step:.5}] as const).map(control=><label className="sar-layout-slider" key={control.key}>
                    <span>{control.label}<output>{layout[person][control.key]}%</output></span>
                    <input type="range" aria-label={`${person==='caian'?'凱恩':'艾文'}${control.label}`} min={control.min} max={control.max} step={control.step} value={layout[person][control.key]} onChange={event=>update(control.key,Number(event.target.value))}/>
                </label>)}
                <label className="sar-layout-select"><span>誰在前面</span><select aria-label="誰在前面" value={layout.front} onChange={event=>setLayout(old=>({...old,front:event.target.value as Layout['front']}))}><option value="caian">凱恩在前</option><option value="aiven">艾文在前</option><option value="auto">當前說話的人</option></select></label>
                <label className="sar-layout-select"><span>預覽對話</span><select aria-label="預覽對話" value={speaker} onChange={event=>setSpeaker(event.target.value as Person)}><option value="caian">凱恩的對話</option><option value="aiven">艾文的對話</option></select></label>
                <div className="sar-layout-actions"><button type="button" onClick={async()=>{try{await navigator.clipboard.writeText(text);setCopyState('已複製');}catch{setCopyState('請展開下方參數複製');}}}>{copyState}</button><button type="button" onClick={()=>setLayout(ORIGINAL)}>還原上一版</button></div>
                <p className="sar-layout-save" role="status">{saveState} · 調好後告訴我就行</p>
                <details><summary>查看參數</summary><textarea aria-label="立繪佈局參數" readOnly value={text} onFocus={event=>event.target.select()}/></details>
                <a className="sar-layout-back" href="/prototypes/sar-art/index.html">返回活動室預覽</a>
            </div>
        </aside>
    </main>;
}
