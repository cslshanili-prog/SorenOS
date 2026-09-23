import React, { useEffect, useMemo, useState } from 'react';
import { Copy, DownloadSimple, X, ArrowLeft, ArrowCounterClockwise } from '@phosphor-icons/react';
import { SAR_EXPRESSIONS, SAR_NPC_NAMES, type SARCastExpressions, type SARExpression } from '../../utils/vrWorld/sarArt';
import { dialogueSentences } from '../../utils/vrWorld/sarFamiliarity/dialogueText';
import type { FamiliarityNpc, FamiliarityScene } from '../../utils/vrWorld/sarFamiliarity/types';
import { exportExpressionEdits, resetExpressionEdit, writeExpressionEdit, type ExpressionEdit } from '../../utils/vrWorld/sarFamiliarity/expressionReview';
import { SARPortrait } from './SARNpcArt';
import './sar-expression-review.css';

const LABELS: Record<SARExpression,string> = {normal:'平常',happy:'開心',curious:'好奇',embarrassed:'尷尬',serious:'認真',shy:'害羞',aboutaster:'回憶 Aster','Enduring Pain':'忍痛',avoidant:'迴避',normal2:'平常 2',warm:'溫柔',interested:'感興趣',sad:'低落',sleeping:'睏倦'};

export function SARExpressionExport({edits}:{edits:ExpressionEdit[]}) {
    const [message,setMessage]=useState(''),[manual,setManual]=useState(false);
    const serialized=useMemo(()=>exportExpressionEdits(edits),[edits]);
    useEffect(()=>setMessage(''),[serialized]);
    const copy=async()=>{try{await navigator.clipboard.writeText(serialized);setMessage('已複製，可以直接發給我');setManual(false);}catch{setManual(true);setMessage('請複製下方清單，或下載文件');}};
    const download=()=>{
        const url=URL.createObjectURL(new Blob([serialized],{type:'application/json;charset=utf-8'}));
        const a=document.createElement('a');a.href=url;a.download='SAR-兩人表情修改.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setMessage('已下載，改完把 JSON 文件發給我');
    };
    return <div className="sar-expression-export">
        <span>兩人共 <b>{edits.length}</b> 處修改</span>
        <div><button type="button" onClick={()=>void copy()}><Copy size={15}/>複製修改清單</button><button type="button" onClick={download}><DownloadSimple size={15}/>下載修改清單</button></div>
        {message&&<small role="status">{message}</small>}
        {manual&&<textarea aria-label="表情修改清單" readOnly value={serialized} onFocus={e=>e.currentTarget.select()}/>}
    </div>;
}

export function SARExpressionReview({scene,nodeId,lineIndex,sentence,text,speaker,cast,originalCast,edits,canBack,onBack,onJump,onClose,choices}:{
    scene:FamiliarityScene;nodeId:string;lineIndex:number;sentence:number;text:string;speaker:FamiliarityNpc;
    cast:Partial<SARCastExpressions>;originalCast:Partial<SARCastExpressions>;edits:ExpressionEdit[];canBack:boolean;
    onBack:()=>void;onJump:(nodeId:string,line:number,sentence:number)=>void;onClose:()=>void;
    choices?:Array<{label:string;onSelect:()=>void}>;
}) {
    const [target,setTarget]=useState<FamiliarityNpc>(speaker),[error,setError]=useState('');
    useEffect(()=>{setTarget(speaker);setError('');},[scene.id,nodeId,lineIndex,sentence,speaker]);
    const options=useMemo(()=>Object.entries(scene.nodes).flatMap(([id,node])=>node.lines.flatMap((line,i)=>dialogueSentences(line.text).map((sentence,j)=>({key:`${id}:${i}:${j}`,node:id,line:i,sentence:j,label:`${line.speaker==='caian'?'凱恩':line.speaker==='aiven'?'艾文':line.speaker==='sully'?'Sully':'旁白'} · ${sentence}`})))),[scene]);
    const address={sceneId:scene.id,nodeId,line:lineIndex,sentence,npc:target};
    const changed=edits.some(e=>e.sceneId===scene.id&&e.nodeId===nodeId&&e.line===lineIndex&&e.sentence===sentence&&e.npc===target);
    const selected=cast[target]||'normal',original=originalCast[target]||'normal';
    const hasLine=!!scene.nodes[nodeId]?.lines[lineIndex];
    const canEdit=scene.nodes[nodeId]?.lines[lineIndex]?.speaker===target;
    const change=(expression:SARExpression)=>{try{writeExpressionEdit(address,original,expression);setError('');}catch(e){setError(e instanceof Error?e.message:'修改沒有保存，請重試');}};
    const reset=()=>{try{resetExpressionEdit(address);setError('');}catch(e){setError(e instanceof Error?e.message:'恢復失敗，請重試');}};
    return <aside className="sar-expression-review" aria-label="表情校對" onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();onClose();}}}>
        <header><div><small>臨時校對</small><strong>這一句的表情</strong></div><button type="button" onClick={onClose} aria-label="收起表情校對"><X size={19}/></button></header>
        <div className="sar-expression-review-scroll">
            <div className="sar-expression-navigation"><button type="button" onClick={onBack} disabled={!canBack}><ArrowLeft size={15}/>上一句</button><select aria-label="跳轉台詞" value={hasLine?`${nodeId}:${lineIndex}:${sentence}`:''} onChange={e=>{const value=options.find(o=>o.key===e.target.value);if(value)onJump(value.node,value.line,value.sentence);}}><option value="" disabled>選擇台詞或分支</option>{options.map((o,i)=><option key={o.key} value={o.key}>{i+1}. {o.label}</option>)}</select></div>
            <p className="sar-expression-current">{text}</p>
            <small className="sar-expression-address">{scene.id} / {nodeId} · 第 {lineIndex+1} 行，第 {sentence+1} 句</small>
            <nav aria-label="校對角色">{(['caian','aiven'] as const).map(npc=><button type="button" key={npc} aria-label={`校對${SAR_NPC_NAMES[npc]}`} aria-pressed={target===npc} onClick={()=>setTarget(npc)}>{SAR_NPC_NAMES[npc]}</button>)}</nav>
            {!canEdit&&<small>此時沿用上次發言的表情，請跳到該角色的台詞修改。</small>}
            <div className="sar-expression-options">{SAR_EXPRESSIONS[target].map(expression=><button key={expression} type="button" aria-label={`表情：${expression}`} aria-pressed={selected===expression} disabled={!canEdit} onClick={()=>change(expression)}><div><SARPortrait who={target} expression={expression}/></div><span>{LABELS[expression]}</span><small>{expression}</small></button>)}</div>
            <div className="sar-expression-reset"><small>{changed?'這句已修改':'當前：'+LABELS[selected]}</small><button type="button" disabled={!changed} onClick={reset}><ArrowCounterClockwise size={14}/>恢復這句原表情</button></div>
            {!hasLine&&<small>此處只有演出，請跳到一句台詞再修改。</small>}
            {error&&<p className="sar-expression-error" role="alert">{error}</p>}
            {!!choices?.length&&<details className="sar-expression-choices"><summary>選擇回應 · {choices.length}</summary><div role="group" aria-label="校對中選擇回應">{choices.map((choice,i)=><button type="button" key={i} onClick={choice.onSelect}>{choice.label}</button>)}</div></details>}
            <SARExpressionExport edits={edits}/>
            <p className="sar-expression-footnote">自動保存在此瀏覽器。修改只作用於校對回顧，導出包含兩人的全部修改。</p>
        </div>
    </aside>;
}
