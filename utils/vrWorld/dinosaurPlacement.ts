import type { FishingMarketState, MarketActor } from './fishingMarket';
import { activeGardenMap, type DinoPose, type GardenProp, type GardenPropKind } from './dinosaurTypes';
import { DINO_GRID, snapDinoPose } from './dinosaurGrid';
import { assertGardenPose, editDino, editGardenProp, gardenCatchAvailable, gardenResidents } from './dinosaurGarden';
import { buildGardenActivities, INTERACTIVE_PROPS } from './dinosaurActivities';

/** A local draft. Never put this in IndexedDB or append events until confirmation. */
export interface GardenPlacement {
  kind: 'dino'|'prop';
  id: string;
  propKind?: GardenPropKind;
  isNew: boolean;
  mapId: string;
  revision: number;
  ownerId?: string;
  pose: DinoPose;
  /** Optional paired move, visibly previewed and saved in the same transaction. */
  companionProp?: GardenProp;
}
function withCompanionProp(s:FishingMarketState,d:GardenPlacement):FishingMarketState {
  if(!d.companionProp)return s;
  const g=s.dinosaurGarden!;
  return {...s,dinosaurGarden:{...g,maps:g.maps.map(m=>m.id!==d.mapId?m:{...m,props:m.props.map(p=>p.id===d.companionProp!.id?d.companionProp!:p)})}};
}
function withoutMovingToy(s:FishingMarketState,id:string):FishingMarketState {
  const g=s.dinosaurGarden!;return {...s,dinosaurGarden:{...g,toys:{...g.toys,[id]:{...g.toys[id],pose:null,mapId:null}}}};
}
export function beginGardenPlacement(s:FishingMarketState,kind:'dino'|'prop',id:string,propKind?:GardenPropKind):GardenPlacement {
  const g=s.dinosaurGarden!,map=activeGardenMap(g);
  const item=kind==='dino'?g.toys[id]:map.props.find(p=>p.id===id);
  if(!item&&!propKind)throw new Error('它已經不在這裡了，請重新選擇。');
  const existing=kind==='dino'?g.toys[id]?.mapId===map.id?g.toys[id].pose:null:map.props.find(p=>p.id===id);
  const draft:GardenPlacement={kind,id:id||'placement-preview',propKind:kind==='prop'?(item as {kind?:GardenPropKind})?.kind||propKind:undefined,isNew:!item,mapId:map.id,revision:g.revision,ownerId:s.inventory.find(c=>c.id===id)?.ownerId,pose:existing?{x:existing.x,z:existing.z,rotation:existing.rotation,...('slotId' in existing?{slotId:existing.slotId}:{})}:{x:0,z:1.9,slotId:'E3',rotation:0}};
  if(!existing){
    const free=DINO_GRID.slice().sort((a,b)=>Math.hypot(a.x,a.z-1.9)-Math.hypot(b.x,b.z-1.9)).find(c=>!placementError(s,{...draft,pose:{...c,slotId:c.id,rotation:0}}));
    if(free)draft.pose={x:free.x,z:free.z,slotId:free.id,rotation:0};
  }
  return draft;
}
export function moveGardenPlacement(draft:GardenPlacement,pose:DinoPose):GardenPlacement {
  return {...draft,pose:snapDinoPose({...pose,rotation:draft.pose.rotation})};
}
export function turnGardenPlacement(draft:GardenPlacement,direction:number):GardenPlacement {
  const rotation=((Math.round(draft.pose.rotation/(Math.PI/4))+direction)%8+8)%8*Math.PI/4;
  return {...draft,pose:{...draft.pose,rotation}};
}
export function placementError(s:FishingMarketState,d:GardenPlacement):string {
  try{
    const g=s.dinosaurGarden!,map=activeGardenMap(g);
    if(g.activeMapId!==d.mapId||g.revision!==d.revision)throw new Error('庭院剛剛有了新變化，請取消後重新擺放。');
    if(d.kind==='dino'){
      const t=g.toys[d.id],owner=s.inventory.find(c=>c.id===d.id)?.ownerId;
      if(!t||owner!==d.ownerId||!gardenCatchAvailable(s,d.id,owner))throw new Error('這隻恐龍的收藏狀態變了，請重新選擇。');
      if((!t.pose||t.mapId!==map.id)&&gardenResidents(s).length>=6)throw new Error('這裡已經住滿六隻了，先收起一隻或換張地圖。');
    }else{
      if(!d.isNew&&!map.props.some(p=>p.id===d.id))throw new Error('這個擺件已經收起來了。');
      if(d.isNew&&map.props.length>=12)throw new Error('這裡已經放滿十二件擺件了。');
    }
    if(d.companionProp){
      const p=d.companionProp;
      if(d.kind!=='dino'||!map.props.some(old=>old.id===p.id&&old.kind===p.kind))throw new Error('一起調整的擺件已經變了，請重新選擇。');
      assertGardenPose(withoutMovingToy(s,d.id),p,p.id,p.kind);
    }
    assertGardenPose(withCompanionProp(s,d),d.pose,d.id,d.kind==='prop'?d.propKind!:false);
    return '';
  }catch(e){return (e as Error).message;}
}
/** Render an invalid draft as well: its red ghost explains why it cannot be saved. */
export function previewGardenPlacement(s:FishingMarketState,d:GardenPlacement):FishingMarketState {
  s=withCompanionProp(s,d);
  const g=s.dinosaurGarden!;
  return {...s,dinosaurGarden:{...g,toys:d.kind==='dino'?{...g.toys,[d.id]:{...g.toys[d.id],pose:d.pose,mapId:d.mapId}}:g.toys,maps:d.kind==='prop'?g.maps.map(m=>m.id!==d.mapId?m:{...m,props:[...m.props.filter(p=>p.id!==d.id),{id:d.id,kind:d.propKind!,...d.pose}]}):g.maps}};
}
export function confirmGardenPlacement(s:FishingMarketState,actor:MarketActor,d:GardenPlacement):FishingMarketState {
  const error=placementError(s,d);if(error)throw new Error(error);
  if(d.companionProp)s=editGardenProp(withoutMovingToy(s,d.id),actor,{id:d.companionProp.id,pose:d.companionProp});
  return d.kind==='dino'?editDino(s,actor,d.id,{pose:d.pose}):editGardenProp(s,actor,{id:d.isNew?undefined:d.id,kind:d.propKind,pose:d.pose});
}

export type GardenPlayPlan={draft:GardenPlacement;reason?:never}|{draft?:never;reason:string};
/** The collection and scene picking share one planner, including orientation and clear failures. */
export function planGardenPlay(s:FishingMarketState,id:string,propId:string):GardenPlayPlan {
  const g=s.dinosaurGarden,map=g&&activeGardenMap(g),toy=g?.toys[id],prop=map?.props.find(p=>p.id===propId);
  if(!g||!map||!prop)return {reason:'這個擺件已經不在庭院裡了。'};
  if(!toy||!gardenCatchAvailable(s,id,s.inventory.find(c=>c.id===id)?.ownerId))return {reason:'暫不可擺放：它已送出、正在孵化或掛板。'};
  if(toy.speciesId==='dinosaur-egg'||toy.speciesId==='dinosaur-fossil')return {reason:'這是靜態藏品，可以擺放，但不會玩玩具。'};
  if(!INTERACTIVE_PROPS.includes(prop.kind))return {reason:'這是裝飾擺件，不會觸發互動。'};
  const residents=gardenResidents(s);
  if((!toy.pose||toy.mapId!==map.id)&&residents.length>=6)return {reason:'這張庭院已住滿六隻，請選本庭院的恐龍。'};
  const occupied=Object.entries(buildGardenActivities(map,residents)).find(([other,a])=>other!==id&&a.propId===propId);
  if(occupied)return {reason:`${g.toys[occupied[0]].name}正在玩這個，先給它換個地方吧。`};
  const draft=beginGardenPlacement(s,'dino',id);
  const candidates=DINO_GRID.flatMap(c=>Array.from({length:8},(_,i)=>({x:c.x,z:c.z,slotId:c.id,rotation:i*Math.PI/4})))
    .sort((a,b)=>Math.hypot(a.x-prop.x,a.z-prop.z)-Math.hypot(b.x-prop.x,b.z-prop.z));
  const works=(d:GardenPlacement)=>!placementError(s,d)&&buildGardenActivities(activeGardenMap(withCompanionProp(s,d).dinosaurGarden!),[...residents.filter(t=>t.catchId!==id),{...toy,mapId:map.id,pose:d.pose}])[id]?.propId===propId;
  for(const pose of candidates){const d={...draft,pose};if(works(d))return {draft:d};}
  // Legacy free-position props can have no grid-aligned usable cell at all (especially stumps).
  // Propose moving just this unoccupied prop; never silently reset the map or another dinosaur.
  const spots=DINO_GRID.slice().sort((a,b)=>Math.hypot(a.x-prop.x,a.z-prop.z)-Math.hypot(b.x-prop.x,b.z-prop.z));
  for(const cell of spots){
    const companionProp={...prop,x:cell.x,z:cell.z};
    try{assertGardenPose(withoutMovingToy(s,id),companionProp,prop.id,prop.kind);}catch{continue;}
    const local=candidates.slice().sort((a,b)=>Math.hypot(a.x-cell.x,a.z-cell.z)-Math.hypot(b.x-cell.x,b.z-cell.z));
    for(const pose of local){const d={...draft,pose,companionProp};if(works(d))return {draft:d};}
  }
  return {reason:'這件玩具和恐龍暫時放不下。先收起一件附近的擺件，再來試試。'};
}
