import React,{useState} from 'react';
import {X} from '@phosphor-icons/react';
import {SARDialogueCast} from './SARNpcArt';
import {SARDialogueChoices} from './SARDialogueChoices';
import type {AivenExpression} from '../../utils/vrWorld/sarArt';

const GUIDES:Record<string,{expression:AivenExpression;text:string}>={
    start:{expression:'normal',text:'這裡的水很安靜。你可以先釣一會兒。'},
    fishing:{expression:'interested',text:'魚和漂來的東西都可以收起來。釣到橡皮泥恐龍的話，記得帶給我看看。'},
    garden:{expression:'happy',text:'茶几上那塊是恐龍箱庭。放好以後，還可以給它們換個顏色。'},
    rest:{expression:'sleeping',text:'……我坐一會兒。你隨意。'},
};
export function SARAivenDialogue({onClose,onOpen}:{onClose:()=>void;onOpen:(entry:'water'|'garden')=>void}){
    const [topic,setTopic]=useState('start'),guide=GUIDES[topic];
    return <div className="sar-npc-dialogue fixed inset-0 z-[370] overflow-hidden bg-[#090a12]/78 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label="與艾文交談">
        <button type="button" onClick={onClose} aria-label="暫時離開對話" className="absolute right-4 z-20 grid h-9 w-9 place-items-center rounded-full bg-black/35 text-white/65" style={{top:'calc(var(--chrome-top) + .5rem)'}}><X size={17}/></button>
        <div className="sar-dialogue-portraits"><SARDialogueCast speaker="aiven" expression={guide.expression}/></div>
        <div className="sar-dialogue-panel"><div>
            <div className="px-5 pt-4 pb-4"><b className="text-[12px] tracking-[.18em] text-indigo-100">艾文</b><p className="mt-2 text-[15px] leading-7 text-white/90">{guide.text}</p></div>
        </div></div>
        <SARDialogueChoices key={topic}>
            {(topic==='fishing'||topic==='garden')&&<button type="button" onClick={()=>onOpen(topic==='fishing'?'water':'garden')}>{topic==='fishing'?'去釣魚':'看看恐龍箱庭'}</button>}
            {topic==='start'?<>{[['fishing','聊聊釣魚'],['garden','聊聊恐龍'],['rest','先坐一會兒']].map(([id,label])=><button key={id} type="button" onClick={()=>setTopic(id)}>{label}</button>)}</>:<button type="button" onClick={()=>setTopic('start')}>換個話題</button>}
            <button type="button" onClick={onClose}>先去逛逛</button>
        </SARDialogueChoices>
    </div>;
}
