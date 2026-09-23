import React from 'react';
import { createRoot } from 'react-dom/client';
import GameApp from '../../apps/GameApp';
import { OSProvider } from '../../context/OSContext';
import { DB } from '../../utils/db';
const longText='第一段完整劇情。'.repeat(35)+'\n\n第二段結尾標記：舊塔的燈終於亮了。';
async function boot(){
    await DB.saveGame({id:'qa-archive',title:'完整原文測試',theme:'fantasy',worldSetting:'測試',playerCharIds:[],logs:[
        {id:'l1',role:'gm',content:longText,timestamp:1,archived:true},
        {id:'l2',role:'player',speakerName:'小雨',content:'舊版歸檔也保留的尾句。',timestamp:2,archived:true},
        {id:'l3',role:'gm',content:'當前劇情',timestamp:3},
    ],summaries:[{id:'s1',content:'前情總結',logCount:1,logIds:['l1'],createdAt:1},{id:'s2',content:'舊版總結',logCount:1,createdAt:2}],status:{location:'塔下',health:100,sanity:100,gold:0,inventory:[]},createdAt:1,lastPlayedAt:2});
    createRoot(document.getElementById('root')!).render(<OSProvider><GameApp/></OSProvider>);
}
void boot();
