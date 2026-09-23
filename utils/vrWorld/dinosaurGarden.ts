import { recordFishingAcquisition, addCatchToState, logMarketEvent, marketId, speciesById, type FishingMarketState, type MarketActor, type FishingCatch } from './fishingMarket';
import { createGardenMaps, GARDEN_FLOOR_PROPS, PROP_LABELS, PROP_RADIUS, defaultDinoPaint, dinoDefinition } from './dinosaurCatalog';
import { gardenActivityAt } from './dinosaurActivities';
import { activeGardenMap, DINO_ACTIONS, type DinoToy, type DinoPose, type DinoPaint, type DinoAction, type GardenEvent, type GardenPropKind } from './dinosaurTypes';
import { DINO_GRID, snapDinoPose } from './dinosaurGrid';
import { gardenSceneryBlocked } from './dinosaurTerrain';
export { DINO_ACTIONS } from './dinosaurTypes';
export const MAX_GARDEN_TOYS=6, MAX_GARDEN_PROPS=12;
const trim=(value:string,max:number)=>String(value||'').trim().slice(0,max);
const garden=(s:FishingMarketState)=>{if(!s.dinosaurGarden)throw new Error('請先打開恐龍箱庭');return s.dinosaurGarden;};
export const gardenCatchAvailable=(s:FishingMarketState,id:string,owner='user',now=Date.now())=>s.inventory.some(c=>c.id===id&&c.ownerId===owner&&!!dinoDefinition(c.speciesId)&&!c.incubatingUntil&&!s.fishingTrips?.some(t=>t.catch.id===id&&t.status==='pending'))&&!s.listings.some(l=>l.catchId===id&&l.status==='open'&&l.expiresAt>now);
const catchOwner=(s:FishingMarketState,id:string)=>s.inventory.find(c=>c.id===id)?.ownerId||'';
export const gardenResidents=(s:FishingMarketState,mapId=s.dinosaurGarden?.activeMapId)=>Object.values(s.dinosaurGarden?.toys||{}).filter(t=>t.pose&&t.mapId===mapId&&gardenCatchAvailable(s,t.catchId,catchOwner(s,t.catchId)));
export function ensureDinosaurGarden(s:FishingMarketState,user:MarketActor,now=Date.now()):FishingMarketState {
  if(s.dinosaurGarden)return syncGardenToys(s);
  const starterId='clay-starter-'+s.seed;
  const given=s.ledger.some(e=>e.id==='caught_'+starterId);
  let next=s;
  if(!given){const c:FishingCatch={id:starterId,speciesId:'tyrannosaurus',ownerId:'user',ownerName:user.name,caughtAt:now,weather:'clear',weatherLabel:'艾文的贈禮',weatherSource:'simulated',sizeCm:12,quality:1,origin:{kind:'gift',actorId:'sar-evan',actorName:'艾文',at:now}};next=addCatchToState(s,c);}
  next={...next,dinosaurGarden:{version:2,gridVersion:1,activeMapId:'grassland',maps:createGardenMaps(),toys:{},events:[],visitsEnabled:false,revision:0}};
  next=syncGardenToys(next);
  if(gardenCatchAvailable(next,starterId))next=editDino(next,user,starterId,{pose:{x:-1.5,z:1.45,rotation:-.45}},now);
  return record(next,{actorId:'sar-evan',actorName:'艾文',actorKind:'system',kind:'welcome',summary:'艾文在水域旁擺好了一桌橡皮泥恐龍。',words:given?'盒子和原來的收藏都還在。':'先送你一隻。名字你來取。'},now);
}
export function syncGardenToys(s:FishingMarketState):FishingMarketState {
  if(!s.dinosaurGarden)return s;
  const toys={...s.dinosaurGarden.toys};let changed=false;
  for(const c of s.inventory){if(!dinoDefinition(c.speciesId))continue;const old=toys[c.id];
    if(!old){const d=dinoDefinition(c.speciesId)!;const stage={action:'發呆' as const,text:'',byId:c.ownerId,byName:c.ownerName,at:c.caughtAt};
      toys[c.id]={catchId:c.id,speciesId:c.speciesId,name:d.nickname,paint:defaultDinoPaint(c.speciesId),pose:null,mapId:null,fixed:false,revision:0,userStage:stage,stage,origin:c.origin||{kind:'unknown',at:c.caughtAt}};changed=true;
    }else if(old.speciesId!==c.speciesId){toys[c.id]={...old,speciesId:c.speciesId,paint:defaultDinoPaint(c.speciesId),pose:null,mapId:null,revision:old.revision+1};changed=true;}
    if(toys[c.id].pose&&!gardenCatchAvailable(s,c.id,c.ownerId)){toys[c.id]={...toys[c.id],pose:null,mapId:null,revision:toys[c.id].revision+1};changed=true;}
  }
  for(const t of Object.values(toys))if(t.pose&&!s.inventory.some(c=>c.id===t.catchId)){toys[t.catchId]={...t,pose:null,revision:t.revision+1};changed=true;}
  return changed?{...s,dinosaurGarden:{...s.dinosaurGarden,toys,revision:s.dinosaurGarden.revision+1}}:s;
}
function record(s:FishingMarketState,e:Omit<GardenEvent,'id'|'at'>,now:number):FishingMarketState {
  const g=garden(s);return {...s,dinosaurGarden:{...g,revision:g.revision+1,events:[...g.events,{...e,mapId:e.mapId||g.activeMapId,id:marketId('garden'),at:now}]}};
}
const actorFields=(a:MarketActor)=>({actorId:a.id,actorName:a.name,actorKind:a.kind==='character'?'character' as const:'user' as const});
export function assertGardenPose(s:FishingMarketState,pose:DinoPose,skipId:string,isProp:boolean|GardenPropKind=false) {
  if(![pose.x,pose.z,pose.rotation].every(Number.isFinite)||Math.abs(pose.x)>3.4||Math.abs(pose.z)>3.65)throw new Error('請擺在沙盤裡面');
  if(!isProp){const snapped=snapDinoPose(pose);if(snapped.x!==pose.x||snapped.z!==pose.z||Math.abs(snapped.rotation-pose.rotation)>1e-6)throw new Error('恐龍只能放在固定落點，轉向每次 45 度');}
  const map=activeGardenMap(garden(s)),radius=isProp?(PROP_RADIUS[typeof isProp==='string'?isProp:map.props.find(p=>p.id===skipId)?.kind||'rock']):.56;
  if(!(typeof isProp==='string'&&GARDEN_FLOOR_PROPS.includes(isProp))&&gardenResidents(s).some(t=>t.catchId!==skipId&&Math.hypot(t.pose!.x-pose.x,t.pose!.z-pose.z)<radius+.55))throw new Error('離另一隻恐龍太近了');
  if(map.props.some(p=>p.id!==skipId&&(isProp||!GARDEN_FLOOR_PROPS.includes(p.kind))&&Math.hypot(p.x-pose.x,p.z-pose.z)<radius+PROP_RADIUS[p.kind]))throw new Error('這裡有擺件，換一塊空地吧');
  if(!isProp&&map.props.some(p=>p.id!==skipId&&p.kind==='stump'&&Math.hypot(p.x-pose.x,p.z-pose.z)<.91&&Math.hypot(p.x-pose.x,p.z-pose.z)>.32))throw new Error('要站在木樁中央，或離它遠一點。');
  if(isProp==='stump'&&gardenResidents(s).some(t=>Math.hypot(t.pose!.x-pose.x,t.pose!.z-pose.z)<.91&&Math.hypot(t.pose!.x-pose.x,t.pose!.z-pose.z)>.32))throw new Error('把木樁放在恐龍腳下，或離它遠一點。');
  if(gardenSceneryBlocked(map.theme,pose,radius))throw new Error('這裡有場景擺設，換一塊空地吧');
}
export function findGardenSpace(s:FishingMarketState,id:string,anchor={x:0,z:1},isProp:boolean|GardenPropKind=false):DinoPose {
  const candidates:DinoPose[]=isProp?[]:DINO_GRID.map(c=>({x:c.x,z:c.z,slotId:c.id,rotation:0}));if(isProp)for(let x=-3.3;x<=3.3;x+=.45)for(let z=-3.5;z<=3.5;z+=.45)candidates.push({x:+x.toFixed(2),z:+z.toFixed(2),rotation:0});
  candidates.sort((a,b)=>Math.hypot(a.x-anchor.x,a.z-anchor.z)-Math.hypot(b.x-anchor.x,b.z-anchor.z));
  for(const p of candidates){try{assertGardenPose(s,p,id,isProp);return p;}catch{/* next spot */}}
  throw new Error('桌面有些擠，先收起一個擺件或一隻恐龍');
}
export function gardenSlots(s:FishingMarketState,skipId='') {
  return DINO_GRID.map(c=>{let available=true;try{assertGardenPose(s,{...c,slotId:c.id,rotation:0},skipId);}catch{available=false;}return {...c,available};});
}
export function editDino(s:FishingMarketState,actor:MarketActor,id:string,patch:{name?:string;paint?:DinoPaint;pose?:DinoPose|null;fixed?:boolean;stage?:{action?:DinoAction;text:string;targetId?:string}},now=Date.now()):FishingMarketState {
  s=syncGardenToys(s);const g=garden(s),map=activeGardenMap(g),toy=g.toys[id];
  if(patch.pose)patch={...patch,pose:snapDinoPose(patch.pose)};
  // The shared tabletop can arrange a character's catch without transferring ownership.
  if(!toy||!gardenCatchAvailable(s,id,actor.id==='user'?catchOwner(s,id):actor.id))throw new Error('這隻恐龍已不在收藏、正在孵化或已經掛板');
  let kind:GardenEvent['kind']='name',summary='';const next={...toy,revision:toy.revision+1};
  if(patch.name!==undefined){next.name=trim(patch.name,16);if(!next.name)throw new Error('給它取個名字吧');summary=`${actor.name}給${dinoDefinition(toy.speciesId)?.name}取名「${next.name}」。`;}
  if(patch.paint){for(const color of Object.values(patch.paint))if(!/^#[0-9a-f]{6}$/i.test(color))throw new Error('請選擇有效的橡皮泥顏色');next.paint={...patch.paint};kind='paint';summary=`${actor.name}給「${toy.name}」換了一身橡皮泥配色。`;}
  if(patch.pose!==undefined){if(patch.pose){if((!toy.pose||toy.mapId!==map.id)&&gardenResidents(s).length>=MAX_GARDEN_TOYS)throw new Error('這張地圖最多放六隻，可以去另一張地圖擺放');assertGardenPose(s,patch.pose,id);}next.pose=patch.pose;next.mapId=patch.pose?map.id:null;kind='move';summary=`${actor.name}${patch.pose?'在'+map.name+'擺好了':'收起了'}「${toy.name}」。`;}
  if(patch.fixed!==undefined){next.fixed=patch.fixed;kind='fixed';summary=`${actor.name}${patch.fixed?'固定了':'允許角色擺弄'}「${toy.name}」。`;}
  if(patch.stage){const action=patch.stage.action||(toy.pose?gardenActivityAt(map,toy.pose).action:'發呆');if(!DINO_ACTIONS.includes(action))throw new Error('請選擇它正在做什麼');const target=patch.stage.targetId;
    if(target&&target!==id&&!gardenResidents(s).some(t=>t.catchId===target)&&!map.props.some(p=>p.id===target))throw new Error('指定的對象已不在這張地圖');
    next.userStage={...patch.stage,action,text:trim(patch.stage.text,160),targetId:target===id?undefined:target,byId:actor.id,byName:actor.name,at:now};next.stage={...next.userStage};kind='stage';summary=next.stage.text?`${actor.name}給「${toy.name}」寫下了一句話。`:`${actor.name}讓「${toy.name}」繼續自己的小日常。`;
  }
  return record({...s,dinosaurGarden:{...g,toys:{...g.toys,[id]:next}}},{...actorFields(actor),kind,toyId:id,toyName:next.name,speciesId:toy.speciesId,summary,words:patch.stage?next.stage.text:undefined},now);
}
export function gardenComment(s:FishingMarketState,actor:MarketActor,id:string|undefined,words:string,now=Date.now()):FishingMarketState {
  const g=garden(s),toy=id?g.toys[id]:undefined;if(id&&!toy)throw new Error('這隻恐龍的記錄不存在');if(!trim(words,240))throw new Error('先寫一句話');
  return record(s,{...actorFields(actor),kind:'comment',toyId:id,toyName:toy?.name,speciesId:toy?.speciesId,summary:`${actor.name}給${toy?'「'+toy.name+'」':'箱庭'}留了一張便籤。`,words:trim(words,240)},now);
}
export function setGardenMap(s:FishingMarketState,mapId:string) {
  const g=garden(s);if(!g.maps.some(m=>m.id===mapId))throw new Error('這張地圖還不存在');
  return {...s,dinosaurGarden:{...g,activeMapId:mapId}};
}
export function setGardenVisits(s:FishingMarketState,enabled:boolean,actor:MarketActor,now=Date.now()) {
  return record({...s,dinosaurGarden:{...garden(s),visitsEnabled:enabled}},{...actorFields(actor),kind:'visits',summary:enabled?'允許已接入彼方的角色來擺弄箱庭。':'箱庭暫時只由你來佈置。'},now);
}
export function editGardenProp(s:FishingMarketState,actor:MarketActor,input:{id?:string;kind?:GardenPropKind;pose?:DinoPose;remove?:boolean},now=Date.now()) {
  const g=garden(s),map=activeGardenMap(g),old=map.props.find(p=>p.id===input.id),id=old?.id||marketId('prop');
  const withProps=(props:typeof map.props)=>({...s,dinosaurGarden:{...g,maps:g.maps.map(m=>m.id===map.id?{...m,props}:m)}});
  if(input.remove){if(!old)throw new Error('擺件已經收起來了');return record(withProps(map.props.filter(p=>p.id!==id)),{...actorFields(actor),kind:'prop',summary:`收起了${PROP_LABELS[old.kind]}。`},now);}
  if(!old&&map.props.length>=MAX_GARDEN_PROPS)throw new Error('這張地圖最多放十二件擺件');const kind=old?.kind||input.kind;if(!kind||!Object.hasOwn(PROP_LABELS,kind))throw new Error('請選擇擺件');
  const pose=input.pose||findGardenSpace(s,id,{x:2,z:2},kind);assertGardenPose(s,pose,id,kind);
  const p={id,kind,...pose};return record(withProps(old?map.props.map(o=>o.id===id?p:o):[...map.props,p]),{...actorFields(actor),kind:'prop',summary:`擺好了${PROP_LABELS[kind]}。`},now);
}
export function giftDino(s:FishingMarketState,actor:MarketActor,id:string,to:MarketActor,now=Date.now()) {
  if(actor.id===to.id||!gardenCatchAvailable(s,id,actor.id,now))throw new Error('這件藏品現在不能贈送');const c=s.inventory.find(c=>c.id===id)!;
  s=recordFishingAcquisition(s,to,c.speciesId,marketId('gift'),now);
  const summary=`${actor.name}把${speciesById(c.speciesId)?.name}送給了${to.name}，原來的名字、配色和經歷都保留。`;
  return logMarketEvent(record(syncGardenToys({...s,inventory:s.inventory.map(t=>t.id===id?{...t,ownerId:to.id,ownerName:to.name,displayed:false}:t)}),{...actorFields(actor),kind:'gift',toyId:id,toyName:garden(s).toys[id]?.name,speciesId:c.speciesId,summary},now),summary,[actor.id,to.id],undefined,now);
}
export function undoGardenVisit(s:FishingMarketState,eventId:string,actor:MarketActor,now=Date.now()) {
  const g=garden(s),e=g.events.find(e=>e.id===eventId),toy=e?.toyId?g.toys[e.toyId]:undefined;
  if(!e||e.actorKind!=='character'||!e.before||!toy||toy.revision!==e.afterRevision||!gardenCatchAvailable(s,toy.catchId,catchOwner(s,toy.catchId))||g.events.some(n=>n.undoOf===eventId))throw new Error('這隻恐龍後來又有變化，不能覆蓋新的佈置');
  const activeMapId=g.activeMapId;if(e.mapId&&e.mapId!==activeMapId){s=setGardenMap(s,e.mapId);}
  if(e.before.pose)assertGardenPose(s,e.before.pose,toy.catchId);const next={...toy,...e.before,revision:toy.revision+1};
  return record({...s,dinosaurGarden:{...g,toys:{...g.toys,[toy.catchId]:next}}},{...actorFields(actor),mapId:e.mapId,kind:'undo',toyId:toy.catchId,toyName:toy.name,speciesId:toy.speciesId,undoOf:eventId,summary:`${actor.name}還原了${e.actorName}對「${toy.name}」的改動。`},now);
}
export function appendGardenVisit(s:FishingMarketState,actor:MarketActor,id:string,change:{pose?:DinoPose;stage?:DinoToy['stage']},expectedRevision:number,words:string,now=Date.now()) {
  const g=garden(s),toy=g.toys[id];if(!g.visitsEnabled)throw new Error('共同擺弄已經關閉');if(!toy||!toy.pose||toy.mapId!==g.activeMapId||!gardenCatchAvailable(s,id,catchOwner(s,id))||toy.fixed)throw new Error('這隻恐龍已被固定或收起');if(toy.revision!==expectedRevision)throw new Error('恐龍剛有了新佈置，這次沒有覆蓋它');
  if(change.pose)change={...change,pose:snapDinoPose(change.pose)};
  if(change.pose)assertGardenPose(s,change.pose,id);const updated={...toy,...change,revision:toy.revision+1};
  return record({...s,dinosaurGarden:{...g,toys:{...g.toys,[id]:updated}}},{...actorFields(actor),kind:change.pose?'move':'stage',toyId:id,toyName:toy.name,speciesId:toy.speciesId,summary:change.pose?`${actor.name}移動了「${toy.name}」。`:`${actor.name}續寫了「${toy.name}」：正在${change.stage!.action}。`,words:trim(words,240),before:change.pose?{pose:toy.pose}:{stage:toy.stage},afterRevision:updated.revision},now);
}
