import type {APIConfig} from '../../types';
import {safeFetchJson} from '../safeApi';
import {getVRApi,logVRApiCall} from './vrApi';
import {mutateFishingMarket,readFishingMarketState} from './fishingMarket';
import {sarNpcContentEnabled} from './sarNpcPreference';
import {applyMarketNPCs,MARKET_NPC_SYSTEM,parseMarketNPCs,prepareMarketNPCs} from './marketNPCs';
let running=false;
/** One foreground request for the entire crowd, no background timer or per-NPC model loop. */
export async function runMarketNPCSession(chatApi?:APIConfig,signal?:AbortSignal){
 if(running)throw Error('路人正在來訪，請等這一輪結束。');
 const run=async()=>{
  const check=()=>{if(signal?.aborted)throw Error('已離開佈告板，本輪停止。');if(!sarNpcContentEnabled())throw Error('已關閉彼方 NPC，路人來訪已停止。');};
  check();const vrApi=await getVRApi(),api=vrApi?.baseUrl?vrApi:chatApi;
  if(!api?.baseUrl||!api.model)throw Error('請先在彼方「API」或聊天默認 API 中配置模型，路人來訪需要一次模型調用。');
  check();const snapshot=prepareMarketNPCs(readFishingMarketState()),baseUrl=api.baseUrl.replace(/\/+$/,''),start=Date.now();
  let content:string;
  try{
   const data=await safeFetchJson(baseUrl+'/chat/completions',{
    method:'POST',signal,headers:{'Content-Type':'application/json',Authorization:'Bearer '+(api.apiKey||'sk-none')},
    body:JSON.stringify({model:api.model,temperature:.95,stream:false,messages:[{role:'system',content:MARKET_NPC_SYSTEM},{role:'user',content:snapshot.prompt}]}),
   },0,0,{appName:'彼方',purpose:'佈告板路人來訪'});
   content=data.choices?.[0]?.message?.content;
   await logVRApiCall({ts:start,room:'sar',charName:'佈告板路人（整輪）',model:api.model,baseUrl,ok:true,ms:Date.now()-start});
  }catch(e){await logVRApiCall({ts:start,room:'sar',charName:'佈告板路人（整輪）',model:api.model,baseUrl,ok:false,ms:Date.now()-start,error:(e instanceof Error?e.message:'調用失敗').slice(0,160)});throw e;}
  check();if(typeof content!=='string')throw Error('模型沒有返回路人發言，這輪沒有寫入便箋。');
  const actions=parseMarketNPCs(content,snapshot);let result:ReturnType<typeof applyMarketNPCs>|undefined;
  await mutateFishingMarket(current=>{check();result=applyMarketNPCs(current,snapshot,actions);return result.state;});
  return result!;
 };
 running=true;
 try{
  if(typeof navigator!=='undefined'&&navigator.locks)return await navigator.locks.request('vr-market-npc-generation',{ifAvailable:true},async lock=>{if(!lock)throw Error('另一頁正在生成路人來訪，請稍後再看。');return run();});
  return await run();
 }finally{running=false;}
}
