import type { DinoPaint, GardenPropKind, GardenProp, GardenMap } from './dinosaurTypes';
export const DINO_CATALOG = [
  {id:'tyrannosaurus',name:'霸王龍',nickname:'莓莓',body:'#cd8f8b',accent:'#e8d9ba',fact:'霸王龍有兩根手指。眼前這隻用橡皮泥捏成，手還是有一點短。'},
  {id:'triceratops',name:'三角龍',nickname:'小角',body:'#85a6b2',accent:'#f3e5c9',fact:'三角龍是植食恐龍，三隻角和大頸盾讓它很好認。這隻的角也是軟軟的橡皮泥。'},
  {id:'stegosaurus',name:'劍龍',nickname:'曲奇',body:'#c9b477',accent:'#c18a89',fact:'劍龍背上有兩排骨板，尾巴還有尖刺。橡皮泥背板很像一排餅乾。'},
  {id:'brachiosaurus',name:'腕龍',nickname:'薄荷',body:'#87b3a5',accent:'#e8d9ba',fact:'腕龍的前肢比後肢長，肩膀因此更高。這根脖子是艾文慢慢搓出來的。'},
  {id:'velociraptor',name:'迅猛龍',nickname:'小灰',body:'#aaa5b2',accent:'#e8d9ba',fact:'伶盜龍常被叫作迅猛龍，它有羽毛，也沒有電影裡那麼大。模型腳上留了彎彎的小爪。'},
  {id:'spinosaurus',name:'棘龍',nickname:'葡萄',body:'#9685a6',accent:'#786889',fact:'棘龍有長吻和高高的背帆。我們對它如何在水裡活動的認識還在更新。'},
  {id:'ankylosaurus',name:'甲龍',nickname:'栗子',body:'#b6a18c',accent:'#a48f7b',fact:'甲龍身披骨甲，尾端有骨錘。這隻身上的小疙瘩是一顆顆按上去的。'},
  {id:'parasaurolophus',name:'副櫛龍',nickname:'桃桃',body:'#d3a6a4',accent:'#e8d9ba',fact:'副櫛龍有向後伸出的中空頭冠，與發聲有關。它是鴨嘴龍類的一員。'},
  {id:'pteranodon',name:'無齒翼龍',nickname:'風箏',body:'#a5bac5',accent:'#ddd2b9',fact:'翼龍是會飛的爬行動物，並不屬於恐龍。艾文還是讓它加入了這盒橡皮泥模型。'},
  {id:'plesiosaur',name:'蛇頸龍',nickname:'泡泡',body:'#95b6c8',accent:'#dddcca',fact:'蛇頸龍是海生爬行動物，也不屬於恐龍。四隻槳狀鰭很適合擺在淺水旁邊。'},
  {id:'dinosaur-egg',name:'恐龍蛋',nickname:'咕嚕',body:'#e5dcc5',accent:'#98ad8b',fact:'一個橡皮泥小蛋。“孵化”是箱庭的揭曉小遊戲，裡面也是橡皮泥模型。'},
  {id:'dinosaur-fossil',name:'恐龍骨架',nickname:'小骨',body:'#dfd2b4',accent:'#aa967b',fact:'這是一副用橡皮泥拼出的骨架模型。真實化石與橡皮泥的成分和來歷都不一樣。'},
  {id:'aiven-chimera',name:'？？？',nickname:'？？？',body:'#b784b5',accent:'#9ebdc9',fact:'霸王龍的身體、三角龍的角、劍龍的骨板、腕龍的脖子。發現於 SAR 活動室水域。艾文：「不知道是什麼。」「所以不用糾正。」'},
] as const;
export const dinoDefinition=(id:string)=>DINO_CATALOG.find(d=>d.id===id);
export const defaultDinoPaint=(id:string):DinoPaint=>{const d=dinoDefinition(id)||DINO_CATALOG[0];return {body:d.body,accent:d.accent};};
export const DINO_PALETTES = [
  {name:'草莓奶',body:'#d69a9f',accent:'#f3ddba'}, {name:'薄荷糖',body:'#87b5a4',accent:'#e5d6ae'},
  {name:'藍莓酪',body:'#9295bf',accent:'#dab2c2'}, {name:'小奶油',body:'#dec48e',accent:'#b38488'},
  {name:'雨天藍',body:'#8dabbc',accent:'#e8e0ce'}, {name:'可可豆',body:'#aa8a72',accent:'#e5c9a2'},
];
export const PROP_LABELS:Record<GardenPropKind,string>={tree:'小樹',rock:'小石頭',tent:'小帳篷',stump:'木樁',volcano:'火山',fence:'柵欄',sign:'路牌',house:'玩具小屋',picnic:'野餐墊',puddle:'小水窪',flowers:'花叢'};
export const PROP_RADIUS:Record<GardenPropKind,number>={tree:.43,rock:.42,tent:.65,stump:.35,volcano:.9,fence:.55,sign:.26,house:.6,picnic:.65,puddle:.65,flowers:.46};
/** Ground mats and the small perch support a dinosaur; other solid scenery blocks placement. */
export const GARDEN_FLOOR_PROPS:readonly GardenPropKind[]=['picnic','puddle','flowers','stump'];
export const PROP_ACTIVITIES:Record<GardenPropKind,string>={tree:'夠一夠樹葉',rock:'靠著歇一會兒',tent:'在門口蜷起來睡覺',stump:'爬上去放哨',volcano:'裝飾 · 探險小景',fence:'裝飾 · 圍出小院',sign:'裝飾 · 指個方向',house:'裝飾 · 一間小屋',picnic:'守著餅乾吃點心',puddle:'踩水玩',flowers:'低頭聞花，花朵輕晃'};
export const DEFAULT_PROPS:GardenProp[]=[
  {id:'tree-a',kind:'tree',x:-3.25,z:-3.35,rotation:0},{id:'tree-b',kind:'tree',x:-2.15,z:-3.55,rotation:.6},
  {id:'tent-a',kind:'tent',x:-1.05,z:-3.3,rotation:.2},{id:'rock-a',kind:'rock',x:3.15,z:1.7,rotation:0},
  {id:'stump-a',kind:'stump',x:-3.25,z:.1,rotation:0},{id:'sign-a',kind:'sign',x:-3.05,z:3.5,rotation:0},
  {id:'picnic-a',kind:'picnic',x:-1.3,z:1.9,rotation:0},{id:'flowers-a',kind:'flowers',x:0,z:-.6,rotation:0},
];
export const createGardenMaps = (): GardenMap[] => [
  {id:'grassland',name:'溪邊草原',theme:'grassland',artVersion:3,props:DEFAULT_PROPS.map(p=>({...p})).concat([{id:'grass-house',kind:'house',x:3.15,z:-2.8,rotation:-.3}])},
  {id:'coast',name:'貝殼海岸',theme:'coast',artVersion:3,props:[
    {id:'coast-tree',kind:'tree',x:-3.2,z:-1.8,rotation:0},{id:'coast-palm',kind:'tree',x:-2.15,z:-3.5,rotation:.7},
    {id:'coast-house',kind:'house',x:-2.95,z:.3,rotation:.15},{id:'coast-rock',kind:'rock',x:.3,z:3.3,rotation:.2},
    {id:'coast-sign',kind:'sign',x:-3.2,z:3.6,rotation:0}]},
  {id:'volcano',name:'火山探險',theme:'volcano',artVersion:3,props:[
    {id:'volcano-main',kind:'volcano',x:-2.8,z:-3,rotation:0},{id:'volcano-rock',kind:'rock',x:-1.4,z:-3.4,rotation:.4},
    {id:'volcano-tent',kind:'tent',x:3.1,z:-2.8,rotation:-.3},{id:'volcano-sign',kind:'sign',x:-3.2,z:3.4,rotation:0},
    {id:'volcano-stump',kind:'stump',x:-3.25,z:0,rotation:0},{id:'volcano-stone',kind:'rock',x:3.25,z:2.6,rotation:0}]},
];
