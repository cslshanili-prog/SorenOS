// Isolated browser QA only. Never open this fixture with production user storage.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SARAssemblyCabinetOverlay } from '../../apps/vrWorld/SARAssemblyCabinet';
import { DB } from '../../utils/db';
import { getSARSimulationThreadId, SAR_SIMULATION_STORAGE_KEY } from '../../utils/vrWorld/sarSimulation';

const char = { id:'sar-reader-char',name:'阿嵐',avatar:'',systemPrompt:'說話溫和，做事有主見。',vrState:{enabled:true,api:{baseUrl:'http://127.0.0.1:5177/sar-qa-api',model:'qa-model',apiKey:'fixture-only'}} } as any;
const runId='sar-reader-run';
async function boot(){
    if(!localStorage.getItem(SAR_SIMULATION_STORAGE_KEY)){
        const card={id:'sar-reader-card',charId:char.id,charName:char.name,variantId:'variant-01',storyId:'story-01',createdAt:1,updatedAt:1,profile:{
            title:'雨停之前',logline:'在一座總是下雨的城裡，他替你留了一盞燈。',identity:'城南修傘鋪的主人，能聽見雨水裡的舊聲音。',lifePatch:'他沒有離開這座城，而是接下了家中的小店。',relationship:'你是他願意留燈等候的人。',steelSeal:'答應等的人，我會等到。',patchCost:'他能聽見許多故事，卻很少說自己的事。',behaviorShift:'習慣先替別人安頓好眼前的小事。',userMaskTitle:'借住的人',userIdentity:'你暫住在修傘鋪樓上，有一把還沒修好的舊傘。',userLifePatch:'你帶著少量行李來到城南，去留由你決定。',worldName:'長雨城',worldPremise:'雨水偶爾會帶來遠處的聲音，居民早已習慣與雨生活。',arrivalPoint:'黃昏，你回到修傘鋪。',activeCrisis:'送信的人沒有像往常一樣來，阿嵐把留給他的茶重新溫了一遍。',sharedObjective:'阿嵐想請鄰居順路問問送信人的情況，你可以陪他，也可以留在店裡。',countdown:'雨夜緩緩過去，今晚沒有必須趕上的期限。',hiddenTruth:'HIDDEN_QA_SECRET：雨裡保存著城外舊車站的聲音。',climaxChoice:'HIDDEN_QA_CHOICE：他可能再次面對離城的機會。',openingScene:'雨沿著屋簷落下來，把街對面的招牌洗得模糊。\n\n修傘鋪還亮著燈。阿嵐聽見門響，將桌邊那杯熱茶往你這邊推了推。',openingLine:'回來啦。先坐，外面冷。',playerPrompt:'你可以坐下來，或做自己想做的事。'
        }};
        localStorage.setItem(SAR_SIMULATION_STORAGE_KEY,JSON.stringify({version:2,cards:[card],runs:[{id:runId,cardId:card.id,createdAt:1,updatedAt:2,status:'active',interactionsUsed:2,maxInteractions:50}]}));
        const base={charId:getSARSimulationThreadId(runId),type:'text' as const};
        await DB.saveMessage({...base,role:'user',content:'我坐到他身邊，把凍涼的手遞過去。',metadata:{source:'sar_simulation',sarRunId:runId,sarTurn:1,sarMode:'offline'}});
        await DB.saveMessage({...base,role:'assistant',content:'阿嵐用掌心包住你的手，沒有急著鬆開。\n\n“怎麼涼成這樣。”他將椅子往你這邊挪了一點，“茶還燙，等一會兒再喝。”',metadata:{source:'sar_simulation',sarRunId:runId,sarTurn:1,sarMode:'offline',sarWorldNarration:'門外的腳步聲遠了。簷下那盞燈，在雨裡輕輕晃著。'}});
        await DB.saveMessage({...base,role:'user',content:'先不管別的了，陪我待一會兒。',metadata:{source:'sar_simulation',sarRunId:runId,sarTurn:2,sarMode:'offline'}});
        await DB.saveMessage({...base,role:'assistant',content:'“好。”\n\n他應得很快，伸手把半開的窗合上。雨聲隔著一層玻璃，忽然變得很遠。\n\n阿嵐重新坐回你身邊，將你的手放進自己的口袋裡。',metadata:{source:'sar_simulation',sarRunId:runId,sarTurn:2,sarMode:'offline',sarWorldNarration:'',sarDirectorState:{sceneFacts:['兩人在修傘鋪相伴，只過去幾分鐘'],openThreads:['送信人未到；鄰居稍後會順路詢問'],offscreenFacts:['HIDDEN_QA_FACT：鄰居尚未出發'],declinedHooks:['用戶此刻不想追問送信人的事'],revealedFacts:['雨夜裡送信人還沒出現']}}});
    }
    createRoot(document.getElementById('root')!).render(<SARAssemblyCabinetOverlay onClose={()=>{}} characters={[char]} userProfile={{name:'我'} as any} groups={[]} apiConfig={{baseUrl:'',model:''} as any}/>);
    // The official game client can inspect the reader without a canvas click target.
    if(new URLSearchParams(location.search).get('open')==='story'){
        let step=0;
        const observer=new MutationObserver(()=>{
            const button=document.querySelector<HTMLButtonElement>(step===0?'.sarc-library-book':'.sarc-card-start button');
            if(button){step++;if(step===2)observer.disconnect();button.click();}
        });
        observer.observe(document.getElementById('root')!,{childList:true,subtree:true});
    }
}
void boot();
