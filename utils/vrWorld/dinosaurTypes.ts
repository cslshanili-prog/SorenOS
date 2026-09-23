export type GardenTheme = 'grassland' | 'coast' | 'volcano';
export const DINO_ACTIONS = ['睡覺','吃飯','發呆','散步','觀察','躲藏','玩耍','吵架','追逐','保護','等待','探險'] as const;
export type DinoAction = typeof DINO_ACTIONS[number];
export interface DinoPose { x:number; z:number; rotation:number; slotId?:string }
export interface DinoPaint { body:string; accent:string }
export interface DinoStage { action:DinoAction; text:string; targetId?:string; byId:string; byName:string; at:number }
export interface DinoOrigin { kind:'fished'|'gift'|'unknown'; actorId?:string; actorName?:string; at:number }
export interface DinoToy {
  catchId:string; speciesId:string; name:string; paint:DinoPaint; pose:DinoPose|null; mapId:string|null; fixed:boolean;
  revision:number; userStage:DinoStage; stage:DinoStage; origin:DinoOrigin;
}
export type GardenPropKind = 'tree'|'rock'|'tent'|'stump'|'volcano'|'fence'|'sign'|'house'|'picnic'|'puddle'|'flowers';
export interface GardenProp extends DinoPose { id:string; kind:GardenPropKind }
export interface GardenEvent {
  id:string; at:number; actorId:string; actorName:string; actorKind:'user'|'character'|'system'; mapId?:string;
  kind:'welcome'|'name'|'paint'|'move'|'stage'|'comment'|'fixed'|'theme'|'prop'|'undo'|'visits'|'gift';
  toyId?:string; toyName?:string; speciesId?:string; summary:string; words?:string;
  before?:{pose?:DinoPose|null;stage?:DinoStage}; afterRevision?:number; undoOf?:string;
}
export interface DinosaurGarden {
  version:2; gridVersion:1; activeMapId:string; maps:GardenMap[]; toys:Record<string,DinoToy>;
  events:GardenEvent[]; visitsEnabled:boolean; revision:number; seenEventId?:string;
}
export interface GardenMap { id:string; name:string; theme:GardenTheme; props:GardenProp[]; artVersion?:number }
export const activeGardenMap = (g: DinosaurGarden): GardenMap => {
  const map = g.maps.find(m => m.id === g.activeMapId);
  if (!map) throw new Error('找不到這張箱庭地圖，請先導出備份');
  return map;
};
