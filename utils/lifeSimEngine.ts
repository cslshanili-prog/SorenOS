/**
 * LifeSim Engine — 都市模擬人生 · 2026 現代版
 * 現代都市戲劇沙盒：公寓合租、職場社交、城市生活
 */

import {
    LifeSimState, SimFamily, SimNPC, SimAction, SimActionType,
    SimEventType, SimPendingEffect, SimEffectCode, NPCDesire,
    SimSeason, SimWeather, SimTimeOfDay, SimProfession, SimFestival,
    SimGender,
} from '../types';
import { equalsAnyScript } from './scriptKey';

const genId = () => Math.random().toString(36).slice(2, 10);

// ── NPC 素材庫 ──────────────────────────────────────────────

const NPC_EMOJIS = ['👩‍💻','👨‍💼','👩‍🎨','🧑‍🍳','👨‍⚕️','👩‍🔬','🧑‍🎤','👨‍✈️','👩‍💼','🧑‍🏫',
                    '🕶️','💅','🎧','📱','💼','🎬','🎸','☕','🍸','✨'];

const NPC_NAMES = [
    '蘇然','林夜','沈默','陸北','顧言','葉青','許晚','秦川','白露','溫笛',
    '程漫','江行','宋雨','韓城','方瑾','鍾離','楚安','裴南','何時','唐緒',
    '黎明','蕭然','周也','孟晚','趙雪','馮遙','魏嵐','傅遠','曲星','賀年',
];

const PERSONALITIES = [
    ['社牛','愛玩','話多'],
    ['社恐','宅','敏感'],
    ['卷王','上進','焦慮'],
    ['摸魚','佛系','隨緣'],
    ['文青','矯情','有品味'],
    ['話題女王','八卦','消息靈通'],
    ['職場精英','高冷','目標明確'],
    ['暖男/暖女','熱心','老好人'],
    ['叛逆','獨立','不按常理出牌'],
    ['精緻','自戀','外貌協會'],
];

const FAMILY_EMOJIS = ['🏢','🏙️','🏬','🏨','🌃','🌆','🏗️','🌇','🎪','🏛️'];
const FAMILY_NAMES = ['星河公寓','雲頂閣','都會花園','摩登大廈','城市之光','天際線','霓虹坊'];

const PROFESSIONS: SimProfession[] = [
    'programmer','designer','finance','influencer','lawyer','freelancer','barista','musician',
    'internet_troll','fanfic_writer','fan_artist','college_student','tired_worker','old_fashioned','fashion_designer',
];
const PROFESSION_LABELS: Record<SimProfession, { zh: string; emoji: string; color: string }> = {
    programmer:      { zh: '碼農', emoji: '💻', color: '#22d3ee' },
    designer:        { zh: '設計師', emoji: '🎨', color: '#f472b6' },
    finance:         { zh: '金融', emoji: '📊', color: '#a78bfa' },
    influencer:      { zh: '網紅', emoji: '📱', color: '#fb923c' },
    lawyer:          { zh: '律師', emoji: '⚖️', color: '#fbbf24' },
    freelancer:      { zh: '自由職業', emoji: '☕', color: '#34d399' },
    barista:         { zh: '咖啡師', emoji: '🧋', color: '#a3845c' },
    musician:        { zh: '音樂人', emoji: '🎸', color: '#c084fc' },
    internet_troll:  { zh: '互聯網噴子', emoji: '🔥', color: '#ef4444' },
    fanfic_writer:   { zh: '同人文作者', emoji: '✍️', color: '#818cf8' },
    fan_artist:      { zh: '同人畫師', emoji: '🖌️', color: '#f0abfc' },
    college_student: { zh: '大學生', emoji: '🎓', color: '#60a5fa' },
    tired_worker:    { zh: '疲憊社畜', emoji: '😮‍💨', color: '#78716c' },
    old_fashioned:   { zh: '老古板', emoji: '🧐', color: '#a8a29e' },
    fashion_designer:{ zh: '服裝設計師', emoji: '👗', color: '#e879f9' },
};

// ── NPC 角色原型（archetype）─────────────────────────────────

interface NPCArchetype {
    profession: SimProfession;
    personalityPool: string[][];
    bioTemplates: string[];
    backstoryTemplates: string[];
}

const NPC_ARCHETYPES: NPCArchetype[] = [
    {
        profession: 'internet_troll',
        personalityPool: [['社牛','暴躁','話多'], ['叛逆','嘴毒','愛槓'], ['傲嬌','毒舌','表面嫌棄']],
        bioTemplates: [
            '鍵盤俠出身，在各大論壇留下無數戰績，現實中其實有點社恐。',
            '退休水軍，如今在小區群裡發揮餘熱，誰都噴過一遍。',
            '前豆瓣鵝組資深成員，擅長花式陰陽怪氣。',
        ],
        backstoryTemplates: [
            '曾因一條微博和半個互聯網對線三天，帳號被封了七個。搬進公寓後發現隔壁住著當年的論戰對手。',
            '大學時是校園BBS的風雲人物，畢業後把戰場轉移到微博和知乎。最近被公司優化，有大把時間上網衝浪。',
            '自稱"互聯網考古學家"，手機裡存了三百多張截圖等著秋後算帳。在公寓群裡經常"友善"地提醒大家注意素質。',
        ],
    },
    {
        profession: 'fanfic_writer',
        personalityPool: [['文青','敏感','腦洞大'], ['社恐','宅','有品味'], ['話多','熱情','不按常理出牌']],
        bioTemplates: [
            '日更三千字的同人文寫手，AO3和LOFTER雙平台運營。',
            '擅長刀人的BE作者，寫完自己先哭。白天上班族，晚上產糧機器。',
            '多CP戰士，牆頭眾多但每個都愛得真誠。夢想出一本同人誌。',
        ],
        backstoryTemplates: [
            '高中在貼吧寫的第一篇同人文意外爆火，從此走上不歸路。搬來是因為舊房東嫌TA半夜敲鍵盤太吵。',
            '寫的一篇文被原作者翻牌，至今是人生高光時刻。正在籌備線下同好聚會。',
            '和畫師室友是網上認識的，為了一起搞創作才合租。最近正在肝十萬字長篇。',
        ],
    },
    {
        profession: 'fan_artist',
        personalityPool: [['精緻','有品味','獨立'], ['社恐','宅','敏感'], ['叛逆','不按常理出牌','有品味']],
        bioTemplates: [
            '半夜兩點還在趕稿的同人畫師，iPad是生命。約稿排到半年後。',
            '擅長畫甜餅的太太，筆下人物自帶濾鏡。偶爾接商稿補貼生活。',
            '從塗鴉到板繪自學成才，風格獨特辨識度極高。夢想開畫展。',
        ],
        backstoryTemplates: [
            '美院畢業後在二次元圈混得風生水起。父母至今以為TA在正經畫畫。',
            '一張同人圖在推特上被轉了兩萬次，從此打開新世界。和文手室友是靈魂夥伴。',
            '曾因畫風之爭和另一個畫師在超話大戰三百回合。搬進公寓後發現對方就住樓上。',
        ],
    },
    {
        profession: 'college_student',
        personalityPool: [['社牛','愛玩','好奇'], ['卷王','上進','焦慮'], ['摸魚','佛系','隨緣']],
        bioTemplates: [
            '大三學生，在考研和擺爛之間反覆橫跳。室友覺得TA是隱藏學霸。',
            '剛轉來的交換生，對一切充滿好奇。社交能力驚人但考試成謎。',
            '研二在讀，課題做不下去就來樓下串門。論文deadline是永遠的痛。',
        ],
        backstoryTemplates: [
            '高考超常發揮考進985，發現身邊的人都比自己強。租了單間想安靜學習，結果天天被鄰居熱鬧吸引。',
            '社團參加了八個，績點在及格線徘徊。父母以為TA在認真讀書，其實每天參加各種局。',
            '被導師催論文催到搬出宿舍，發現公寓比宿舍還熱鬧。論文進度為零，八卦儲量為滿。',
        ],
    },
    {
        profession: 'tired_worker',
        personalityPool: [['佛系','喪','敏感'], ['社恐','宅','焦慮'], ['上進','焦慮','卷王']],
        bioTemplates: [
            '996是日常，每天地鐵通勤兩小時。最大願望是睡到自然醒。',
            '互聯網大廠螺絲釘，工牌上的微笑是最後的體面。週末只想躺平。',
            '從大廠跳到創業公司又跳回大廠，發現哪裡都一樣累。養了只貓當精神支柱。',
        ],
        backstoryTemplates: [
            '曾是充滿理想的應屆生，三年社畜磨平了稜角。搬來是因為離公司近，能多睡半小時。',
            '上份工作太拼進了醫院，辭職後因為房貸不得不立刻找下家。在公寓裡是最安靜的存在。',
            '工作之餘在B站吐槽職場意外火了。白天社畜晚上UP主，比以前更累了。',
        ],
    },
    {
        profession: 'old_fashioned',
        personalityPool: [['嚴肅','固執','講原則'], ['高冷','獨立','要強'], ['嘮叨','熱心','老好人']],
        bioTemplates: [
            '堅持看報紙的最後一代人，覺得年輕人不靠譜。但誰有困難都幫。',
            '退休教師，自封"樓長"。作息規律到能當鐘錶。',
            '前國企中層，說話永遠端著。最看不慣年輕人熬夜和點外賣。',
        ],
        backstoryTemplates: [
            '在這棟樓住最久，見證無數住戶來去。嘴上說受不了年輕人吵鬧，每次有人搬走都偷偷難過。',
            '老伴去世後獨居，每天最大樂趣是樓下和老人下棋。對隔壁年輕人又好奇又嫌棄。',
            '子女都在外地，逢年過節才回來。在公寓群最愛發早安圖和養生鏈接。年輕人嘴上嫌煩，其實都挺喜歡TA。',
        ],
    },
    {
        profession: 'programmer',
        personalityPool: [['宅','社恐','理性'], ['卷王','上進','焦慮'], ['摸魚','佛系','話少']],
        bioTemplates: [
            '寫代碼比說話流利，GitHub綠得像草原。冰箱裡永遠只有可樂和外賣。',
            '全棧工程師，從前端寫到運維。頭髮是唯一軟肋。',
            '35歲危機提前到來的碼農，正在偷偷學新技術準備跳槽。',
        ],
        backstoryTemplates: [
            '從小就拆電腦，大學自學編程拿了ACM銀牌。工作後發現寫業務代碼和競賽完全不同。',
            '創業失敗兩次，現在老實在大廠搬磚。偶爾半夜打開side project看看，嘆口氣關掉。',
            '上次因需求變更和產品經理在會議室吵了一架，現在是公寓裡"社恐但吵架很厲害的人"。',
        ],
    },
    {
        profession: 'fashion_designer',
        personalityPool: [['精緻','自戀','外貌協會'], ['叛逆','獨立','有品味'], ['話多','熱情','不按常理出牌']],
        bioTemplates: [
            '獨立設計師，小紅書上有死忠粉。衣櫃比臥室大。',
            '從快時尚跳出做獨立品牌，審美在線但餘額不在線。',
            '海歸設計師，巴黎學的高定回來做淘寶店。但每天穿得像走紅毯。',
        ],
        backstoryTemplates: [
            '從小愛把媽媽衣服剪了重縫，被打無數次。現在媽媽成了TA最大粉絲。',
            '在某時裝週後台實習過，回來後對公寓所有人的穿搭都看不下去。自願當造型顧問。',
            '為省錢租了最小的房間，預算全砸在面料上。工作台從臥室延伸到客廳，室友習慣了滿地布料。',
        ],
    },
    {
        profession: 'influencer',
        personalityPool: [['社牛','話多','自戀'], ['精緻','外貌協會','上進'], ['話題女王','八卦','消息靈通']],
        bioTemplates: [
            '小紅書十萬粉博主，每頓飯先拍照。生活的每刻都是素材。',
            '從素人到網紅只用一條視頻，但維持流量需要每天營業。',
            '直播帶貨新手，正在搭建自己的IP。室友經常被拉去當群演。',
        ],
        backstoryTemplates: [
            '辭掉穩定工作全職自媒體，父母以為TA還在上班。每天最緊張的是看後台數據。',
            '一條吐槽視頻上了熱搜，從此開啟網紅之路。把公共區域變成拍攝場地，引發了小型內戰。',
            '曾在直播間翻車掉了兩萬粉。現在做內容如履薄冰，但表面永遠元氣滿滿。',
        ],
    },
    {
        profession: 'barista',
        personalityPool: [['文青','有品味','獨立'], ['佛系','隨緣','暖男/暖女'], ['社牛','熱心','話多']],
        bioTemplates: [
            '咖啡鑑賞師，能從拿鐵判斷豆子產地。夢想開精品咖啡館。',
            '前白領轉行做咖啡師，覺得拉花比做PPT有意義。',
            '在樓下咖啡店工作，是公寓所有人的"續命恩人"。',
        ],
        backstoryTemplates: [
            '辭掉高薪金融工作學咖啡，所有人覺得TA瘋了。兩年後拿下SCA認證。',
            '在樓下咖啡店打工，是公寓消息最靈通的人。誰吵架誰暗戀，TA比當事人都清楚。',
            '在意大利學了半年咖啡，回來發現國內精品咖啡已經卷得不行。正在攢錢開店。',
        ],
    },
];

// ── NPC 關係模板 ─────────────────────────────────────────────

interface NPCRelationshipSeed {
    type: string;
    relValue: number;
    addGrudge?: boolean;
    addCrush?: boolean;
}

const RELATIONSHIP_SEEDS: NPCRelationshipSeed[] = [
    { type: 'friends', relValue: 40 },
    { type: 'rivals', relValue: -20, addGrudge: true },
    { type: 'crush', relValue: 50, addCrush: true },
    { type: 'strangers', relValue: 5 },
    { type: 'exes', relValue: -30, addGrudge: true },
    { type: 'childhood_friends', relValue: 60 },
    { type: 'online_friends', relValue: 30 },
];

function pickRandom<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}

function rollGender(): SimGender {
    const r = Math.random();
    return r < 0.45 ? 'male' : r < 0.9 ? 'female' : 'nonbinary';
}

const GENDER_LABELS: Record<SimGender, string> = { male: '♂', female: '♀', nonbinary: '⚧' };
export function getGenderLabel(g?: SimGender): string { return g ? GENDER_LABELS[g] : ''; }

/** 根據原型生成一個完整的NPC（帶故事） */
function rollNPCFromArchetype(name: string, archetype: NPCArchetype): SimNPC {
    const personality = pickRandom(archetype.personalityPool);
    const bio = pickRandom(archetype.bioTemplates);
    const backstory = pickRandom(archetype.backstoryTemplates);
    const gender = rollGender();

    return {
        id: genId(),
        name,
        emoji: '',
        personality,
        mood: Math.floor(Math.random() * 40) + 30,
        familyId: null,
        profession: archetype.profession,
        gold: Math.floor(Math.random() * 30) + 20,
        gender,
        bio,
        backstory,
        desires: [],
        grudges: [],
        crushes: [],
    };
}

/** 為一組NPC隨機roll關係 */
function rollRelationships(npcs: SimNPC[], families: SimFamily[]): void {
    if (npcs.length < 2) return;
    const pairCount = Math.floor(npcs.length * 0.6) + 1;
    const usedPairs = new Set<string>();

    for (let i = 0; i < pairCount; i++) {
        const a = npcs[Math.floor(Math.random() * npcs.length)];
        const b = npcs[Math.floor(Math.random() * npcs.length)];
        if (a.id === b.id) continue;
        const key = [a.id, b.id].sort().join('-');
        if (usedPairs.has(key)) continue;
        usedPairs.add(key);

        const seed = pickRandom(RELATIONSHIP_SEEDS);
        if (seed.addGrudge) {
            if (!a.grudges) a.grudges = [];
            a.grudges.push(b.id);
        }
        if (seed.addCrush) {
            if (!a.crushes) a.crushes = [];
            a.crushes.push(b.id);
        }

        // 更新家庭關係值
        for (const fam of families) {
            if (fam.memberIds.includes(a.id) && fam.memberIds.includes(b.id)) {
                if (!fam.relationships[a.id]) fam.relationships[a.id] = {};
                if (!fam.relationships[b.id]) fam.relationships[b.id] = {};
                fam.relationships[a.id][b.id] = clamp(seed.relValue + Math.floor(Math.random() * 20 - 10));
                fam.relationships[b.id][a.id] = clamp(seed.relValue + Math.floor(Math.random() * 20 - 10));
            }
        }
    }
}

// ── 四季系統 ──────────────────────────────────────────────────

export const SEASON_INFO: Record<SimSeason, { zh: string; emoji: string; color: string; skyGrad: [string,string] }> = {
    spring: { zh: '春', emoji: '🌸', color: '#c4b5fd', skyGrad: ['#1e1b4b','#312e81'] },
    summer: { zh: '夏', emoji: '🌆', color: '#fbbf24', skyGrad: ['#0c0a3e','#1e1b4b'] },
    fall:   { zh: '秋', emoji: '🍁', color: '#f97316', skyGrad: ['#1c1917','#292524'] },
    winter: { zh: '冬', emoji: '🌃', color: '#94a3b8', skyGrad: ['#0f172a','#1e293b'] },
};

export const TIME_INFO: Record<SimTimeOfDay, { zh: string; emoji: string }> = {
    dawn:      { zh: '黎明', emoji: '🌅' },
    morning:   { zh: '上午', emoji: '🌤️' },
    afternoon: { zh: '下午', emoji: '☀️' },
    evening:   { zh: '傍晚', emoji: '🌇' },
    night:     { zh: '夜晚', emoji: '🌙' },
};

const TIME_ORDER: SimTimeOfDay[] = ['dawn','morning','afternoon','evening','night'];

export const WEATHER_INFO: Record<SimWeather, { zh: string; emoji: string }> = {
    sunny:  { zh: '晴天', emoji: '☀️' },
    cloudy: { zh: '多雲', emoji: '⛅' },
    rainy:  { zh: '小雨', emoji: '🌧️' },
    stormy: { zh: '暴風雨', emoji: '⛈️' },
    snowy:  { zh: '飄雪', emoji: '🌨️' },
    windy:  { zh: '大風', emoji: '🌬️' },
};

// ── 節日曆法 ──────────────────────────────────────────────────

export const FESTIVALS: SimFestival[] = [
    { name: '新年倒計時', season: 'spring', day: 1,  emoji: '🎆', description: '新年了！全城煙花綻放，朋友圈刷爆。', moodBonus: 20, relBonus: 15, chaosChange: -10 },
    { name: '音樂節', season: 'spring', day: 8,  emoji: '🎵', description: '城市音樂節開幕，live house場場爆滿。', moodBonus: 15, relBonus: 10, chaosChange: -5 },
    { name: '創業路演', season: 'spring', day: 20, emoji: '💡', description: '創業圈路演日，社交名片瘋狂交換中。', moodBonus: 10, relBonus: 5, chaosChange: 0 },
    { name: '泳池派對', season: 'summer', day: 6,  emoji: '🏖️', description: '天台泳池派對！全公寓的人都來了。', moodBonus: 10, relBonus: 8, chaosChange: -3 },
    { name: '啤酒節', season: 'summer', day: 20, emoji: '🍻', description: '夏夜啤酒節！大家喝高了什麼都敢說。', moodBonus: 25, relBonus: 15, chaosChange: 8 },
    { name: '雙十一', season: 'fall',   day: 14, emoji: '🛒', description: '購物狂歡節！所有人都在比拼購物車。', moodBonus: 15, relBonus: 10, chaosChange: -5 },
    { name: '萬聖夜', season: 'fall',   day: 21, emoji: '🎃', description: '萬聖節變裝派對，面具下曖昧升溫。', moodBonus: 12, relBonus: 18, chaosChange: 5 },
    { name: '跨年演唱會', season: 'winter', day: 10, emoji: '🎤', description: '冬日跨年演唱會，燈光和溫暖交織。', moodBonus: 8, relBonus: 5, chaosChange: -3 },
    { name: '年終盛典', season: 'winter', day: 27, emoji: '🎊', description: '年末盛典！老闆發紅包，同事們嗨翻。', moodBonus: 25, relBonus: 20, chaosChange: -20 },
];

// ── 向後兼容存根 ──────────────────────────────────────────────

/** @deprecated 物品系統已移除，保留空對象供舊代碼兼容 */
export const ITEM_DEFS: Record<string, { zh: string; emoji: string; basePrice: number; category: string }> = {};

/** @deprecated 活動系統已移除，保留存根供舊代碼兼容 */
export function getActivityLabel(_a: any): { zh: string; emoji: string } {
    return { zh: '?', emoji: '?' };
}

/** @deprecated 活動結果系統已移除，保留存根供舊代碼兼容 */
export function applyActivityResult(
    state: LifeSimState,
    _npcId: string,
    _activity: any,
    _isFestival: boolean
): { newState: LifeSimState; resultDesc: string } {
    return { newState: deepClone(state), resultDesc: '活動系統已移除。' };
}

/** @deprecated 世界庫存系統已移除，保留存根供舊代碼兼容 */
export function sellWorldInventory(
    state: LifeSimState,
    _isFestivalDay: boolean
): { newState: LifeSimState; goldEarned: number; desc: string } {
    return { newState: deepClone(state), goldEarned: 0, desc: '庫存系統已移除。' };
}

// ── 天氣生成 ──────────────────────────────────────────────────

export function generateWeather(season: SimSeason): SimWeather {
    const r = Math.random();
    switch (season) {
        case 'spring': return r < 0.40 ? 'sunny' : r < 0.70 ? 'cloudy' : r < 0.92 ? 'rainy' : 'stormy';
        case 'summer': return r < 0.50 ? 'sunny' : r < 0.72 ? 'cloudy' : r < 0.85 ? 'rainy' : r < 0.95 ? 'stormy' : 'windy';
        case 'fall':   return r < 0.30 ? 'sunny' : r < 0.58 ? 'cloudy' : r < 0.80 ? 'rainy' : r < 0.88 ? 'stormy' : 'windy';
        case 'winter': return r < 0.22 ? 'sunny' : r < 0.48 ? 'cloudy' : r < 0.82 ? 'snowy' : 'stormy';
    }
}

// ── 遷移舊存檔 ────────────────────────────────────────────────

/** 為舊存檔補全默認值，同時清除已移除的字段 */
export function migrateLifeSimState(state: LifeSimState): LifeSimState {
    const s = deepClone(state);
    if (!s.season) s.season = 'spring';
    if (!s.day) s.day = 1;
    if (!s.year) s.year = 1;
    if (!s.timeOfDay) s.timeOfDay = 'morning';
    if (!s.weather) s.weather = generateWeather(s.season);
    if (s.lastActiveTimestamp === undefined) s.lastActiveTimestamp = Date.now();
    if (s.useIndependentApiConfig === undefined) s.useIndependentApiConfig = false;

    // 清除已移除的舊字段
    delete (s as any).buildings;
    delete (s as any).worldInventory;
    delete (s as any).worldGold;

    for (const npc of s.npcs) {
        if (!npc.profession) npc.profession = PROFESSIONS[Math.floor(Math.random() * PROFESSIONS.length)];
        if (npc.gold === undefined) npc.gold = Math.floor(Math.random() * 50) + 10;
        // 添加新的戲劇系統字段
        if (!npc.desires) npc.desires = [];
        if (!npc.grudges) npc.grudges = [];
        if (!npc.crushes) npc.crushes = [];
        // 遷移：為舊NPC補充故事字段
        if (!npc.gender) npc.gender = rollGender();
        if (!npc.bio) {
            const arch = NPC_ARCHETYPES.find(a => a.profession === npc.profession);
            npc.bio = arch ? pickRandom(arch.bioTemplates) : undefined;
        }
        if (!npc.backstory) {
            const arch = NPC_ARCHETYPES.find(a => a.profession === npc.profession);
            npc.backstory = arch ? pickRandom(arch.backstoryTemplates) : undefined;
        }
        // 清除已移除的舊字段
        delete (npc as any).energy;
        delete (npc as any).skills;
        delete (npc as any).inventory;
        delete (npc as any).currentActivity;
        delete (npc as any).activityResult;
    }
    return s;
}

// ── 初始化 ───────────────────────────────────────────────────

/** 創建全新遊戲狀態，默認3個家庭各2個NPC，使用角色原型系統 */
export function createNewLifeSimState(): LifeSimState {
    const families: SimFamily[] = [];
    const npcs: SimNPC[] = [];

    const usedNames = new Set<string>();
    const pickName = () => {
        const shuffled = [...NPC_NAMES].sort(() => Math.random() - 0.5);
        for (const n of shuffled) {
            if (!usedNames.has(n)) { usedNames.add(n); return n; }
        }
        return `小人${genId().slice(0,3)}`;
    };

    // 從原型池中隨機抽取6個不同原型
    const shuffledArchetypes = [...NPC_ARCHETYPES].sort(() => Math.random() - 0.5);
    const selectedArchetypes = shuffledArchetypes.slice(0, 6);

    for (let i = 0; i < 3; i++) {
        const familyId = genId();
        const memberIds: string[] = [];

        for (let j = 0; j < 2; j++) {
            const archetype = selectedArchetypes[i * 2 + j];
            const npc = rollNPCFromArchetype(pickName(), archetype);
            npc.familyId = familyId;
            npcs.push(npc);
            memberIds.push(npc.id);
        }

        const relationships: Record<string, Record<string, number>> = {};
        for (const a of memberIds) {
            relationships[a] = {};
            for (const b of memberIds) {
                if (a !== b) relationships[a][b] = Math.floor(Math.random() * 40) + 20;
            }
        }

        const INITIAL_POSITIONS = [
            { x: 20, y: 25 },
            { x: 75, y: 30 },
            { x: 46, y: 63 },
        ];
        const pos = INITIAL_POSITIONS[i] || { x: 15 + i * 30, y: 30 };

        const family: SimFamily = {
            id: familyId,
            name: FAMILY_NAMES[i],
            emoji: FAMILY_EMOJIS[i],
            memberIds,
            relationships,
            homeX: pos.x,
            homeY: pos.y,
        };
        families.push(family);
    }

    // 為NPC們隨機roll初始關係網
    rollRelationships(npcs, families);

    return {
        id: genId(),
        createdAt: Date.now(),
        turnNumber: 1,
        currentActorId: 'user',
        families,
        npcs,
        actionLog: [],
        pendingEffects: [],
        chaosLevel: 0,
        charQueue: [],
        replayPending: [],
        useIndependentApiConfig: false,
        isProcessingCharTurn: false,
        gameOver: false,
        season: 'spring',
        day: 1,
        year: 1,
        timeOfDay: 'morning',
        weather: 'sunny',
        lastActiveTimestamp: Date.now(),
    };
}

// ── 工具函數 ─────────────────────────────────────────────────

export function getNPC(state: LifeSimState, id: string): SimNPC | undefined {
    return state.npcs.find(n => n.id === id);
}

export function getFamily(state: LifeSimState, id: string): SimFamily | undefined {
    return state.families.find(f => f.id === id);
}

export function getFamilyMembers(state: LifeSimState, familyId: string): SimNPC[] {
    return state.npcs.filter(n => n.familyId === familyId);
}

export function getIndependentNPCs(state: LifeSimState): SimNPC[] {
    return state.npcs.filter(n => n.familyId === null);
}

export function getRelationship(family: SimFamily, npcA: string, npcB: string): number {
    return family.relationships?.[npcA]?.[npcB] ?? 0;
}

export function clamp(v: number, min = -100, max = 100): number {
    return Math.max(min, Math.min(max, v));
}

export function getProfessionInfo(p: SimProfession) {
    return PROFESSION_LABELS[p] ?? PROFESSION_LABELS.freelancer;
}

/** 計算兩個NPC的性格兼容性 (-1 to 1) */
function personalityCompatibility(a: SimNPC, b: SimNPC): number {
    const conflictPairs = [
        ['暴躁', '暴躁'], ['暴躁', '傲嬌'], ['暴躁', '要強'],
        ['衝動', '衝動'], ['衝動', '腹黑'],
        ['嚴肅', '懶散'], ['完美主義', '懶散'],
    ];
    const synergyPairs = [
        ['善良', '單純'], ['溫柔', '單純'], ['熱情', '活潑'],
        ['隨和', '善良'], ['樂天', '活潑'], ['理性', '嚴肅'],
        ['腹黑', '腹黑'],
    ];
    // 舊存檔的性格標籤可能是簡體，比對簡繁都認
    const hasTrait = (npc: typeof a, trait: string) => npc.personality.some(p => equalsAnyScript(p, trait));
    let score = 0;
    for (const [x, y] of conflictPairs) {
        if ((hasTrait(a, x) && hasTrait(b, y)) ||
            (hasTrait(a, y) && hasTrait(b, x))) {
            score -= 0.4;
        }
    }
    for (const [x, y] of synergyPairs) {
        if ((hasTrait(a, x) && hasTrait(b, y)) ||
            (hasTrait(a, y) && hasTrait(b, x))) {
            score += 0.3;
        }
    }
    return clamp(score, -1, 1);
}

// ── 時間推進 ──────────────────────────────────────────────────

/**
 * 推進時間：用戶每結束一個回合，時間前進一格
 * dawn -> morning -> afternoon -> evening -> night -> dawn(次日)
 */
export function advanceTimeOfDay(state: LifeSimState): {
    newState: LifeSimState;
    newDay: boolean;
    newSeason: boolean;
    festival?: SimFestival;
    events: string[];
} {
    const s = deepClone(state);
    const events: string[] = [];
    let newDay = false;
    let newSeason = false;
    let festival: SimFestival | undefined;

    const currentIdx = TIME_ORDER.indexOf(s.timeOfDay ?? 'morning');
    const nextIdx = (currentIdx + 1) % TIME_ORDER.length;
    s.timeOfDay = TIME_ORDER[nextIdx];

    // 到黎明 = 新的一天
    if (s.timeOfDay === 'dawn') {
        newDay = true;
        s.day = (s.day ?? 1) + 1;

        // 新天氣
        s.weather = generateWeather(s.season ?? 'spring');
        events.push(`${TIME_INFO.dawn.emoji} 新的一天開始了——今日天氣：${WEATHER_INFO[s.weather].zh} ${WEATHER_INFO[s.weather].emoji}`);

        // 檢查節日
        const fest = FESTIVALS.find(f => f.season === s.season && f.day === s.day);
        if (fest) {
            festival = fest;
            s.lastFestival = fest.name;
            // 應用節日效果
            for (const npc of s.npcs) {
                npc.mood = clamp(npc.mood + fest.moodBonus);
            }
            for (const fam of s.families) {
                for (const aId of fam.memberIds) {
                    for (const bId of fam.memberIds) {
                        if (aId !== bId) {
                            if (!fam.relationships[aId]) fam.relationships[aId] = {};
                            fam.relationships[aId][bId] = clamp((fam.relationships[aId][bId] ?? 0) + fest.relBonus);
                        }
                    }
                }
            }
            s.chaosLevel = clamp(s.chaosLevel + fest.chaosChange, 0, 100);
            events.push(`${fest.emoji} 節日：${fest.name}！${fest.description}`);
        }

        // 檢查季節切換（28天一個季節）
        if ((s.day ?? 1) > 28) {
            newSeason = true;
            s.day = 1;
            const seasonOrder: SimSeason[] = ['spring', 'summer', 'fall', 'winter'];
            const currentSeasonIdx = seasonOrder.indexOf(s.season ?? 'spring');
            const nextSeasonIdx = (currentSeasonIdx + 1) % seasonOrder.length;
            s.season = seasonOrder[nextSeasonIdx];
            if (nextSeasonIdx === 0) s.year = (s.year ?? 1) + 1; // 冬→春 = 新年
            s.weather = generateWeather(s.season);
            const si = SEASON_INFO[s.season];
            events.push(`${si.emoji} 季節交替！迎來${si.zh}季。`);
        }
    }

    return { newState: s, newDay, newSeason, festival, events };
}

// ── 後果引擎 ────────────────────────────────────────────────

export interface ActionResult {
    newState: LifeSimState;
    immediateResult: string;
    pendingDesc?: string;
}

export function createNPC(name?: string, emoji?: string, personality?: string[]): SimNPC {
    const n = name || NPC_NAMES[Math.floor(Math.random() * NPC_NAMES.length)];
    const e = emoji || NPC_EMOJIS[Math.floor(Math.random() * NPC_EMOJIS.length)];
    const p = personality || PERSONALITIES[Math.floor(Math.random() * PERSONALITIES.length)];
    // 如果有匹配的原型就用原型生成故事，否則隨機
    const matchedArchetype = NPC_ARCHETYPES.find(a => p.some(trait => a.personalityPool.flat().includes(trait)));
    const profession = matchedArchetype?.profession || PROFESSIONS[Math.floor(Math.random() * PROFESSIONS.length)];
    const gender = rollGender();
    const bio = matchedArchetype ? pickRandom(matchedArchetype.bioTemplates) : undefined;
    const backstory = matchedArchetype ? pickRandom(matchedArchetype.backstoryTemplates) : undefined;
    return {
        id: genId(),
        name: n,
        emoji: e,
        personality: p,
        mood: Math.floor(Math.random() * 30) + 40,
        familyId: null,
        profession,
        gold: Math.floor(Math.random() * 20) + 10,
        gender,
        bio,
        backstory,
        desires: [],
        grudges: [],
        crushes: [],
    };
}

export function applyAddNPC(
    state: LifeSimState,
    npc: SimNPC,
    targetFamilyId: string
): ActionResult {
    const s = deepClone(state);
    const family = s.families.find(f => f.id === targetFamilyId);
    if (!family) return { newState: s, immediateResult: '公寓不存在，什麼都沒發生。' };

    npc.familyId = targetFamilyId;
    s.npcs.push(npc);
    family.memberIds.push(npc.id);

    const existing = family.memberIds.filter(id => id !== npc.id);
    for (const memberId of existing) {
        const member = s.npcs.find(n => n.id === memberId);
        if (!member) continue;
        const compat = personalityCompatibility(npc, member);
        const base = Math.floor(compat * 40 + (Math.random() * 20 - 10));
        if (!family.relationships[npc.id]) family.relationships[npc.id] = {};
        if (!family.relationships[memberId]) family.relationships[memberId] = {};
        family.relationships[npc.id][memberId] = clamp(base);
        family.relationships[memberId][npc.id] = clamp(base + Math.floor(Math.random() * 20 - 10));
    }

    const avgRel = existing.length > 0
        ? existing.reduce((sum, id) => sum + (family.relationships[npc.id]?.[id] ?? 0), 0) / existing.length
        : 50;

    const profInfo = getProfessionInfo(npc.profession ?? 'freelancer');
    let result = '';
    let pendingDesc: string | undefined;

    if (avgRel < -20) {
        result = `${npc.emoji}${npc.name}（${profInfo.emoji}${profInfo.zh}）搬進了${family.name}，但氣場完全不對，室友們的表情很微妙……`;
        const eff: SimPendingEffect = {
            id: genId(),
            triggerTurn: s.turnNumber + 3,
            npcId: npc.id,
            familyId: targetFamilyId,
            description: `${npc.name}和${family.name}室友的矛盾持續積累，快要爆發了`,
            effectCode: 'fight_break',
            effectValue: -20,
        };
        s.pendingEffects.push(eff);
        s.chaosLevel = clamp(s.chaosLevel + 10, 0, 100);
        pendingDesc = eff.description;
    } else if (avgRel > 30) {
        result = `${npc.emoji}${npc.name}（${profInfo.emoji}${profInfo.zh}）搬進了${family.name}，大家聊得很來，直接約了週末聚餐！`;
        npc.mood = clamp(npc.mood + 10);
    } else {
        result = `${npc.emoji}${npc.name}（${profInfo.emoji}${profInfo.zh}）搬進了${family.name}，室友們在客廳偷偷打量中……`;
    }

    return { newState: s, immediateResult: result, pendingDesc };
}

export function applyMoveNPC(
    state: LifeSimState,
    npcId: string,
    targetFamilyId: string | null
): ActionResult {
    const s = deepClone(state);
    const npc = s.npcs.find(n => n.id === npcId);
    if (!npc) return { newState: s, immediateResult: '找不到這個NPC。' };

    const oldFamilyId = npc.familyId;
    const oldFamily = oldFamilyId ? s.families.find(f => f.id === oldFamilyId) : null;
    const newFamily = targetFamilyId ? s.families.find(f => f.id === targetFamilyId) : null;

    if (oldFamily) {
        oldFamily.memberIds = oldFamily.memberIds.filter(id => id !== npcId);
        for (const memberId of oldFamily.memberIds) {
            const rel = oldFamily.relationships?.[npcId]?.[memberId] ?? 0;
            const member = s.npcs.find(n => n.id === memberId);
            if (member) member.mood = clamp(member.mood + (rel < 0 ? 15 : -5));
        }
    }

    if (newFamily) {
        npc.familyId = targetFamilyId;
        newFamily.memberIds.push(npcId);
        for (const memberId of newFamily.memberIds.filter(id => id !== npcId)) {
            const member = s.npcs.find(n => n.id === memberId);
            if (!member) continue;
            const compat = personalityCompatibility(npc, member);
            const base = Math.floor(compat * 30 + (Math.random() * 20 - 10));
            if (!newFamily.relationships[npcId]) newFamily.relationships[npcId] = {};
            if (!newFamily.relationships[memberId]) newFamily.relationships[memberId] = {};
            newFamily.relationships[npcId][memberId] = clamp(base);
            newFamily.relationships[memberId][npcId] = clamp(base);
        }
    } else {
        npc.familyId = null;
        s.chaosLevel = clamp(s.chaosLevel + 5, 0, 100);
    }

    const from = oldFamily ? oldFamily.name : '獨居';
    const to = newFamily ? newFamily.name : '獨居';
    return { newState: s, immediateResult: `${npc.emoji}${npc.name}從${from}搬到了${to}。` };
}

export function applyGoSolo(
    state: LifeSimState,
    npcId: string,
    newFamilyName?: string
): ActionResult {
    const s = deepClone(state);
    const npc = s.npcs.find(n => n.id === npcId);
    if (!npc) return { newState: s, immediateResult: '找不到這個NPC。' };

    const oldFamily = npc.familyId ? s.families.find(f => f.id === npc.familyId) : null;
    if (oldFamily) oldFamily.memberIds = oldFamily.memberIds.filter(id => id !== npcId);

    const newFamilyId = genId();
    const familyName = newFamilyName || `${npc.name}的單人公寓`;
    const SOLO_POSITIONS = [
        { x: 12, y: 55 }, { x: 85, y: 20 }, { x: 50, y: 12 },
        { x: 88, y: 68 }, { x: 8, y: 72 }, { x: 60, y: 82 },
    ];
    const soloPos = SOLO_POSITIONS[s.families.length % SOLO_POSITIONS.length];
    const newFamily: SimFamily = {
        id: newFamilyId,
        name: familyName,
        emoji: '🏢',
        memberIds: [npcId],
        relationships: {},
        homeX: Math.max(5, Math.min(93, soloPos.x + Math.floor(Math.random() * 8 - 4))),
        homeY: Math.max(5, Math.min(90, soloPos.y + Math.floor(Math.random() * 8 - 4))),
    };
    s.families.push(newFamily);
    npc.familyId = newFamilyId;
    s.chaosLevel = clamp(s.chaosLevel + 8, 0, 100);

    return { newState: s, immediateResult: `${npc.emoji}${npc.name}搬出去單住了，在"${familyName}"開始獨居生活！${oldFamily ? `${oldFamily.name}的室友們都沒想到。` : ''}` };
}

/** 根據NPC特徵生成世界故事敘述 */
function buildWorldStoryNarration(eventType: SimEventType, involvedNpcs: SimNPC[], description: string): string {
    const names = involvedNpcs.map(n => {
        const prof = getProfessionInfo(n.profession ?? 'freelancer');
        return `${n.name}（${prof.zh}）`;
    });
    const nameStr = names.join('、');

    // 根據NPC的職業和性格生成更豐富的故事
    const storyTemplates: Record<SimEventType, string[]> = {
        fight: [
            `💢 ${nameStr}之間爆發了一場激烈的衝突！${description ? description + '。' : ''}整棟樓都能聽到爭吵聲，其他住戶紛紛關上門假裝沒聽到……`,
            `💢 因為一件小事，${nameStr}徹底撕破了臉！${description ? description + '。' : ''}公寓群裡的氣氛驟然緊張，大家開始站隊。`,
            `💢 ${nameStr}在公共區域大吵了一架！${description ? description + '。' : ''}有人在群裡直播了全程，評論區已經炸了。`,
        ],
        party: [
            `🎉 ${nameStr}決定一起辦一場聚會！${description ? description + '。' : ''}歡聲笑語從客廳傳到走廊，連平時不出門的住戶都探出了頭。`,
            `🎉 一場突如其來的聚會在公寓裡展開——${nameStr}是主要參與者。${description ? description + '。' : ''}大家的關係在推杯換盞中悄悄升溫。`,
            `🎉 ${nameStr}組了個局！${description ? description + '。' : ''}氣氛熱烈到隔壁樓都來打聽發生了什麼。`,
        ],
        romance: [
            `💕 ${nameStr}之間的氣氛突然變得微妙起來……${description ? description + '。' : ''}其他住戶開始在背後竊竊私語，公寓裡的八卦值直線上升。`,
            `💕 有眼尖的住戶發現${nameStr}最近走得特別近！${description ? description + '。' : ''}這到底是友情還是愛情？整棟樓都在吃瓜。`,
            `💕 某個深夜，${nameStr}被發現在樓頂天台聊了很久……${description ? description + '。' : ''}第二天公寓群裡炸開了鍋。`,
        ],
        gossip: [
            `🤫 一條關於${nameStr}的八卦開始在公寓裡瘋傳……${description ? description + '。' : ''}沒人知道消息源頭在哪，但每個人都繪聲繪色地在轉述。`,
            `🤫 ${nameStr}的一些"秘密"突然在公寓群裡被爆了出來！${description ? description + '。' : ''}當事人的心情急轉直下，其他人卻看得津津有味。`,
            `🤫 有人在匿名樹洞裡爆料了關於${nameStr}的猛料！${description ? description + '。' : ''}整棟樓的吃瓜群眾都坐不住了。`,
        ],
        rivalry: [
            `⚔️ ${nameStr}之間的暗中較勁浮上了水面！${description ? description + '。' : ''}從此公寓裡多了一層劍拔弩張的氣氛。`,
            `⚔️ 不知不覺間，${nameStr}開始了一場無聲的競爭。${description ? description + '。' : ''}其他住戶夾在中間左右為難。`,
            `⚔️ ${nameStr}正式宣戰了！${description ? description + '。' : ''}公寓的和平日子一去不復返……`,
        ],
        alliance: [
            `🤝 ${nameStr}悄悄達成了某種默契……${description ? description + '。' : ''}他們開始頻繁地碰頭密談，其他人感到了一絲不安。`,
            `🤝 出人意料地，${nameStr}居然聯手了！${description ? description + '。' : ''}這個同盟將改變公寓裡的力量格局。`,
            `🤝 ${nameStr}結成了同盟！${description ? description + '。' : ''}有了彼此的支持，他們在公寓裡的話語權明顯增強。`,
        ],
    };

    const templates = storyTemplates[eventType] || [`${description}`];
    return templates[Math.floor(Math.random() * templates.length)];
}

export function applyTriggerEvent(
    state: LifeSimState,
    eventType: SimEventType,
    involvedIds: string[],
    description: string
): ActionResult {
    const s = deepClone(state);
    const involvedNpcs = involvedIds.map(id => s.npcs.find(n => n.id === id)).filter((n): n is SimNPC => !!n);
    let result = '';

    switch (eventType) {
        case 'fight': {
            for (let i = 0; i < involvedIds.length; i++) {
                const npc = s.npcs.find(n => n.id === involvedIds[i]);
                if (npc) npc.mood = clamp(npc.mood - 20);
                for (let j = i + 1; j < involvedIds.length; j++) {
                    const npcA = involvedIds[i]; const npcB = involvedIds[j];
                    for (const fam of s.families) {
                        if (fam.memberIds.includes(npcA) && fam.memberIds.includes(npcB)) {
                            if (!fam.relationships[npcA]) fam.relationships[npcA] = {};
                            if (!fam.relationships[npcB]) fam.relationships[npcB] = {};
                            fam.relationships[npcA][npcB] = clamp((fam.relationships[npcA][npcB] ?? 0) - 30);
                            fam.relationships[npcB][npcA] = clamp((fam.relationships[npcB][npcA] ?? 0) - 30);
                        }
                    }
                }
            }
            s.chaosLevel = clamp(s.chaosLevel + 15, 0, 100);
            break;
        }
        case 'party': {
            for (const npcId of involvedIds) {
                const npc = s.npcs.find(n => n.id === npcId);
                if (npc) npc.mood = clamp(npc.mood + 15);
            }
            for (let i = 0; i < involvedIds.length; i++) {
                for (let j = i + 1; j < involvedIds.length; j++) {
                    const npcA = involvedIds[i]; const npcB = involvedIds[j];
                    for (const fam of s.families) {
                        if (fam.memberIds.includes(npcA) && fam.memberIds.includes(npcB)) {
                            if (!fam.relationships[npcA]) fam.relationships[npcA] = {};
                            if (!fam.relationships[npcB]) fam.relationships[npcB] = {};
                            fam.relationships[npcA][npcB] = clamp((fam.relationships[npcA][npcB] ?? 0) + 20);
                            fam.relationships[npcB][npcA] = clamp((fam.relationships[npcB][npcA] ?? 0) + 20);
                        }
                    }
                }
            }
            s.chaosLevel = clamp(s.chaosLevel - 5, 0, 100);
            break;
        }
        case 'romance': {
            if (involvedIds.length >= 2) {
                const [npcAId, npcBId] = involvedIds;
                for (const fam of s.families) {
                    if (fam.memberIds.includes(npcAId) && fam.memberIds.includes(npcBId)) {
                        if (!fam.relationships[npcAId]) fam.relationships[npcAId] = {};
                        if (!fam.relationships[npcBId]) fam.relationships[npcBId] = {};
                        fam.relationships[npcAId][npcBId] = clamp((fam.relationships[npcAId][npcBId] ?? 0) + 35);
                        fam.relationships[npcBId][npcAId] = clamp((fam.relationships[npcBId][npcAId] ?? 0) + 35);
                    }
                }
            }
            s.chaosLevel = clamp(s.chaosLevel + 8, 0, 100);
            break;
        }
        case 'gossip': {
            s.chaosLevel = clamp(s.chaosLevel + 12, 0, 100);
            if (involvedIds.length > 0) {
                const targetNpc = s.npcs.find(n => n.id === involvedIds[0]);
                if (targetNpc) targetNpc.mood = clamp(targetNpc.mood - 10);
            }
            break;
        }
        case 'alliance': {
            s.chaosLevel = clamp(s.chaosLevel + 5, 0, 100);
            break;
        }
        case 'rivalry': {
            s.chaosLevel = clamp(s.chaosLevel + 10, 0, 100);
            break;
        }
    }

    result = buildWorldStoryNarration(eventType, involvedNpcs, description);
    return { newState: s, immediateResult: result };
}

// ── 事件鏈輔助：生成延遲效果 ────────────────────────────────

function spawnEffect(
    state: LifeSimState,
    code: SimEffectCode,
    delayTurns: number,
    description: string,
    opts?: {
        npcId?: string;
        familyId?: string;
        involvedNpcIds?: string[];
        severity?: number;
        chainFrom?: string;
    }
): void {
    state.pendingEffects.push({
        id: genId(),
        triggerTurn: state.turnNumber + delayTurns,
        effectCode: code,
        description,
        npcId: opts?.npcId,
        familyId: opts?.familyId,
        involvedNpcIds: opts?.involvedNpcIds,
        severity: opts?.severity ?? 1,
        chainFrom: opts?.chainFrom,
    });
}

/** 在所有家庭中查找兩個NPC之間的關係值 */
function findRelationship(state: LifeSimState, aId: string, bId: string): { family: SimFamily; value: number } | null {
    for (const fam of state.families) {
        if (fam.memberIds.includes(aId) && fam.memberIds.includes(bId)) {
            return { family: fam, value: fam.relationships?.[aId]?.[bId] ?? 0 };
        }
    }
    return null;
}

/** 修改兩個NPC之間的關係（同一家庭內） */
function adjustRelationship(state: LifeSimState, aId: string, bId: string, delta: number): void {
    for (const fam of state.families) {
        if (fam.memberIds.includes(aId) && fam.memberIds.includes(bId)) {
            if (!fam.relationships[aId]) fam.relationships[aId] = {};
            if (!fam.relationships[bId]) fam.relationships[bId] = {};
            fam.relationships[aId][bId] = clamp((fam.relationships[aId][bId] ?? 0) + delta);
            fam.relationships[bId][aId] = clamp((fam.relationships[bId][aId] ?? 0) + delta);
            return;
        }
    }
}

/** 將NPC移出當前家庭，創建獨立家庭 */
function makeNPCRunaway(state: LifeSimState, npc: SimNPC): string {
    const oldFamily = npc.familyId ? state.families.find(f => f.id === npc.familyId) : null;
    if (oldFamily) {
        oldFamily.memberIds = oldFamily.memberIds.filter(id => id !== npc.id);
    }
    const newFamId = genId();
    const SOLO_POSITIONS = [
        { x: 12, y: 55 }, { x: 85, y: 20 }, { x: 50, y: 12 },
        { x: 88, y: 68 }, { x: 8, y: 72 }, { x: 60, y: 82 },
    ];
    const soloPos = SOLO_POSITIONS[state.families.length % SOLO_POSITIONS.length];
    state.families.push({
        id: newFamId,
        name: `${npc.name}的單人公寓`,
        emoji: '🏢',
        memberIds: [npc.id],
        relationships: {},
        homeX: Math.max(5, Math.min(93, soloPos.x + Math.floor(Math.random() * 8 - 4))),
        homeY: Math.max(5, Math.min(90, soloPos.y + Math.floor(Math.random() * 8 - 4))),
    });
    npc.familyId = newFamId;
    return newFamId;
}

// ── 結算待決效果 ─────────────────────────────────────────────

export function settlePendingEffects(state: LifeSimState): { newState: LifeSimState; events: string[] } {
    const s = deepClone(state);
    const events: string[] = [];
    const remaining: SimPendingEffect[] = [];

    for (const eff of s.pendingEffects) {
        if (eff.triggerTurn <= s.turnNumber) {
            switch (eff.effectCode) {

                // ── fight_break (矛盾爆發) ──
                case 'fight_break': {
                    if (eff.npcId && eff.familyId) {
                        const npc = s.npcs.find(n => n.id === eff.npcId);
                        const family = s.families.find(f => f.id === eff.familyId);
                        if (npc && family) {
                            npc.mood = clamp(npc.mood - 25);
                            s.chaosLevel = clamp(s.chaosLevel + 15, 0, 100);
                            if (npc.mood < -20 && Math.random() > 0.4) {
                                makeNPCRunaway(s, npc);
                                events.push(`💥 ${eff.description}——${npc.name}徹底忍不了了，連夜搬走！`);
                            } else {
                                events.push(`😤 ${eff.description}——大吵一架，但勉強沒搬走。`);
                                // 60% chance spawns revenge_plot in 2-4 turns
                                if (Math.random() < 0.6) {
                                    const otherMembers = family.memberIds.filter(id => id !== npc.id);
                                    if (otherMembers.length > 0) {
                                        const targetId = otherMembers[Math.floor(Math.random() * otherMembers.length)];
                                        const target = s.npcs.find(n => n.id === targetId);
                                        spawnEffect(s, 'revenge_plot', 2 + Math.floor(Math.random() * 3),
                                            `${npc.name}對${target?.name ?? '某人'}懷恨在心，醞釀著復仇……`,
                                            { npcId: npc.id, involvedNpcIds: [npc.id, targetId], chainFrom: eff.id });
                                    }
                                }
                            }
                        }
                    }
                    break;
                }

                // ── mood_drop (心情低落) ──
                case 'mood_drop': {
                    if (eff.npcId) {
                        const npc = s.npcs.find(n => n.id === eff.npcId);
                        if (npc) {
                            npc.mood = clamp(npc.mood + (eff.effectValue ?? -15));
                            events.push(`😞 ${eff.description}`);
                        }
                    }
                    break;
                }

                // ── relationship_change (關係變化) ──
                case 'relationship_change': {
                    events.push(`🔄 ${eff.description}`);
                    break;
                }

                // ── revenge_plot (復仇計劃) ──
                case 'revenge_plot': {
                    const involved = eff.involvedNpcIds ?? [];
                    const npc = eff.npcId ? s.npcs.find(n => n.id === eff.npcId) : null;
                    const targetId = involved.find(id => id !== eff.npcId);
                    const target = targetId ? s.npcs.find(n => n.id === targetId) : null;
                    if (npc && target) {
                        npc.mood = clamp(npc.mood - 20);
                        target.mood = clamp(target.mood - 20);
                        adjustRelationship(s, npc.id, target.id, -40);
                        s.chaosLevel = clamp(s.chaosLevel + 12, 0, 100);
                        // Add grudge
                        if (!npc.grudges) npc.grudges = [];
                        if (!npc.grudges.includes(target.id)) npc.grudges.push(target.id);
                        events.push(`🗡️ ${npc.name}對${target.name}發起了報復！兩人大打出手，關係降至冰點！`);
                        // If mood already very low, 50% chance spawns npc_runaway
                        if (npc.mood < -30 && Math.random() < 0.5) {
                            spawnEffect(s, 'npc_runaway', 1,
                                `${npc.name}心灰意冷，準備離開……`,
                                { npcId: npc.id, chainFrom: eff.id });
                        }
                    }
                    break;
                }

                // ── love_triangle (三角戀) ──
                case 'love_triangle': {
                    const involved = eff.involvedNpcIds ?? [];
                    if (involved.length >= 3) {
                        const [compA, compB, crushTarget] = involved;
                        const npcA = s.npcs.find(n => n.id === compA);
                        const npcB = s.npcs.find(n => n.id === compB);
                        const crushNpc = s.npcs.find(n => n.id === crushTarget);
                        if (npcA && npcB && crushNpc) {
                            adjustRelationship(s, compA, compB, -30);
                            s.chaosLevel = clamp(s.chaosLevel + 10, 0, 100);
                            events.push(`💔 ${npcA.name}和${npcB.name}都喜歡${crushNpc.name}，兩人之間的火藥味越來越濃！`);
                            // 40% chance spawns betrayal in 2-3 turns
                            if (Math.random() < 0.4) {
                                const betrayer = Math.random() < 0.5 ? compA : compB;
                                const victim = betrayer === compA ? compB : compA;
                                const betrayerNpc = s.npcs.find(n => n.id === betrayer);
                                const victimNpc = s.npcs.find(n => n.id === victim);
                                spawnEffect(s, 'betrayal', 2 + Math.floor(Math.random() * 2),
                                    `${betrayerNpc?.name ?? '某人'}暗中背叛了${victimNpc?.name ?? '某人'}的信任……`,
                                    { npcId: betrayer, involvedNpcIds: [betrayer, victim], chainFrom: eff.id });
                            }
                        }
                    }
                    break;
                }

                // ── jealousy_spiral (嫉妒螺旋) ──
                case 'jealousy_spiral': {
                    const npc = eff.npcId ? s.npcs.find(n => n.id === eff.npcId) : null;
                    if (npc) {
                        npc.mood = clamp(npc.mood - 25);
                        events.push(`😈 ${npc.name}被嫉妒吞噬，開始到處說別人的壞話！`);
                        // Spawns gossip_wildfire in 1-2 turns
                        spawnEffect(s, 'gossip_wildfire', 1 + Math.floor(Math.random() * 2),
                            `${npc.name}的嫉妒引發了一波八卦風暴……`,
                            { npcId: npc.id, familyId: npc.familyId ?? undefined, chainFrom: eff.id });
                    }
                    break;
                }

                // ── family_feud (家族世仇) ──
                case 'family_feud': {
                    const involved = eff.involvedNpcIds ?? [];
                    // Find two families from involved NPC IDs
                    const familyIds = new Set<string>();
                    for (const nId of involved) {
                        const n = s.npcs.find(nn => nn.id === nId);
                        if (n?.familyId) familyIds.add(n.familyId);
                    }
                    const famIdArr = Array.from(familyIds);
                    if (famIdArr.length >= 2) {
                        const famA = s.families.find(f => f.id === famIdArr[0]);
                        const famB = s.families.find(f => f.id === famIdArr[1]);
                        if (famA && famB) {
                            // Cross-family relationships all drop -20
                            for (const aId of famA.memberIds) {
                                for (const bId of famB.memberIds) {
                                    adjustRelationship(s, aId, bId, -20);
                                }
                            }
                            s.chaosLevel = clamp(s.chaosLevel + 15, 0, 100);
                            events.push(`⚔️ ${famA.name}和${famB.name}爆發了公寓大戰！所有跨公寓關係急劇惡化！`);
                            // 30% chance: weakest-mood member runs away
                            if (Math.random() < 0.3) {
                                const allMembers = [...famA.memberIds, ...famB.memberIds]
                                    .map(id => s.npcs.find(n => n.id === id))
                                    .filter((n): n is SimNPC => !!n);
                                if (allMembers.length > 0) {
                                    const weakest = allMembers.reduce((a, b) => a.mood < b.mood ? a : b);
                                    spawnEffect(s, 'npc_runaway', 1,
                                        `${weakest.name}受不了家族爭鬥的壓力……`,
                                        { npcId: weakest.id, chainFrom: eff.id });
                                }
                            }
                        }
                    }
                    break;
                }

                // ── betrayal (背叛) ──
                case 'betrayal': {
                    const involved = eff.involvedNpcIds ?? [];
                    if (involved.length >= 2) {
                        const betrayer = s.npcs.find(n => n.id === involved[0]);
                        const victim = s.npcs.find(n => n.id === involved[1]);
                        if (betrayer && victim) {
                            // Flip relationship to negative
                            const rel = findRelationship(s, betrayer.id, victim.id);
                            const newRelVal = rel ? -Math.abs(rel.value) - 20 : -50;
                            if (rel) {
                                if (!rel.family.relationships[betrayer.id]) rel.family.relationships[betrayer.id] = {};
                                if (!rel.family.relationships[victim.id]) rel.family.relationships[victim.id] = {};
                                rel.family.relationships[betrayer.id][victim.id] = clamp(newRelVal);
                                rel.family.relationships[victim.id][betrayer.id] = clamp(newRelVal);
                            }
                            victim.mood = clamp(victim.mood - 30);
                            s.chaosLevel = clamp(s.chaosLevel + 18, 0, 100);
                            // Add grudge for victim
                            if (!victim.grudges) victim.grudges = [];
                            if (!victim.grudges.includes(betrayer.id)) victim.grudges.push(betrayer.id);
                            events.push(`🔪 ${betrayer.name}背叛了${victim.name}的信任！${victim.name}心碎了，關係徹底崩盤！`);
                        }
                    }
                    break;
                }

                // ── romantic_confession (浪漫告白) ──
                case 'romantic_confession': {
                    const involved = eff.involvedNpcIds ?? [];
                    if (involved.length >= 2) {
                        const confessor = s.npcs.find(n => n.id === involved[0]);
                        const target = s.npcs.find(n => n.id === involved[1]);
                        if (confessor && target) {
                            const rel = findRelationship(s, confessor.id, target.id);
                            const relVal = rel?.value ?? 0;
                            s.chaosLevel = clamp(s.chaosLevel + 5, 0, 100);
                            if (relVal > 40) {
                                // Success!
                                confessor.mood = clamp(confessor.mood + 25);
                                target.mood = clamp(target.mood + 25);
                                adjustRelationship(s, confessor.id, target.id, 40);
                                // Add crushes
                                if (!confessor.crushes) confessor.crushes = [];
                                if (!confessor.crushes.includes(target.id)) confessor.crushes.push(target.id);
                                if (!target.crushes) target.crushes = [];
                                if (!target.crushes.includes(confessor.id)) target.crushes.push(confessor.id);
                                events.push(`💕 ${confessor.name}向${target.name}告白了——成功了！兩人心意相通，甜蜜指數爆表！`);
                            } else {
                                // Rejection
                                confessor.mood = clamp(confessor.mood - 30);
                                adjustRelationship(s, confessor.id, target.id, -15);
                                events.push(`💔 ${confessor.name}鼓起勇氣向${target.name}告白……但被拒絕了。氣氛變得尷尬。`);
                            }
                        }
                    }
                    break;
                }

                // ── gossip_wildfire (八卦野火) ──
                case 'gossip_wildfire': {
                    const familyId = eff.familyId ?? (eff.npcId ? s.npcs.find(n => n.id === eff.npcId)?.familyId : null);
                    if (familyId) {
                        const members = s.npcs.filter(n => n.familyId === familyId);
                        for (const m of members) {
                            m.mood = clamp(m.mood - 8);
                        }
                        s.chaosLevel = clamp(s.chaosLevel + 8, 0, 100);
                        const family = s.families.find(f => f.id === familyId);
                        events.push(`🗣️ 八卦在${family?.name ?? '某公寓'}的群裡瘋傳！所有人心情變差。`);
                        // 25% chance spawns fight_break
                        if (Math.random() < 0.25 && members.length > 1) {
                            const weakest = members.reduce((a, b) => a.mood < b.mood ? a : b);
                            spawnEffect(s, 'fight_break', 1,
                                `${weakest.name}因為八卦被氣到了，矛盾一觸即發……`,
                                { npcId: weakest.id, familyId, chainFrom: eff.id });
                        }
                    }
                    break;
                }

                // ── npc_runaway (NPC出走) ──
                case 'npc_runaway': {
                    const npc = eff.npcId ? s.npcs.find(n => n.id === eff.npcId) : null;
                    if (npc && npc.familyId) {
                        const oldFamilyName = s.families.find(f => f.id === npc.familyId)?.name ?? '原公寓';
                        const newFamId = makeNPCRunaway(s, npc);
                        let extraMsg = '';
                        // 30% chance: if they have a crush, the crush follows
                        if (npc.crushes && npc.crushes.length > 0 && Math.random() < 0.3) {
                            const crushId = npc.crushes[0];
                            const crush = s.npcs.find(n => n.id === crushId);
                            if (crush && crush.familyId && crush.familyId !== newFamId) {
                                const crushOldFamily = s.families.find(f => f.id === crush.familyId);
                                if (crushOldFamily) {
                                    crushOldFamily.memberIds = crushOldFamily.memberIds.filter(id => id !== crushId);
                                }
                                crush.familyId = newFamId;
                                const newFam = s.families.find(f => f.id === newFamId);
                                if (newFam) {
                                    newFam.memberIds.push(crushId);
                                    if (!newFam.relationships[npc.id]) newFam.relationships[npc.id] = {};
                                    if (!newFam.relationships[crushId]) newFam.relationships[crushId] = {};
                                    newFam.relationships[npc.id][crushId] = 60;
                                    newFam.relationships[crushId][npc.id] = 60;
                                }
                                extraMsg = `${crush.name}追隨${npc.name}一起離開了！`;
                            }
                        }
                        events.push(`🏃 ${npc.name}搬離了${oldFamilyName}，開始獨居！${extraMsg}`);
                    }
                    break;
                }

                // ── mood_breakdown (情緒崩潰) ──
                case 'mood_breakdown': {
                    const npc = eff.npcId ? s.npcs.find(n => n.id === eff.npcId) : null;
                    if (npc) {
                        npc.mood = clamp(-80);
                        // All relationships -10
                        for (const fam of s.families) {
                            if (fam.memberIds.includes(npc.id)) {
                                for (const otherId of fam.memberIds) {
                                    if (otherId !== npc.id) {
                                        if (!fam.relationships[npc.id]) fam.relationships[npc.id] = {};
                                        if (!fam.relationships[otherId]) fam.relationships[otherId] = {};
                                        fam.relationships[npc.id][otherId] = clamp((fam.relationships[npc.id][otherId] ?? 0) - 10);
                                        fam.relationships[otherId][npc.id] = clamp((fam.relationships[otherId][npc.id] ?? 0) - 10);
                                    }
                                }
                            }
                        }
                        events.push(`😭 ${npc.name}徹底崩潰了！情緒降至最低點，和所有人的關係都變差了。`);
                        // 40% chance spawns npc_runaway in 2 turns
                        if (Math.random() < 0.4) {
                            spawnEffect(s, 'npc_runaway', 2,
                                `${npc.name}崩潰後萌生了出走的念頭……`,
                                { npcId: npc.id, chainFrom: eff.id });
                        }
                    }
                    break;
                }

                // ── secret_alliance (秘密同盟) ──
                case 'secret_alliance': {
                    const involved = eff.involvedNpcIds ?? [];
                    if (involved.length >= 2) {
                        const npcA = s.npcs.find(n => n.id === involved[0]);
                        const npcB = s.npcs.find(n => n.id === involved[1]);
                        if (npcA && npcB) {
                            // Cross-family relationship +50
                            adjustRelationship(s, npcA.id, npcB.id, 50);
                            events.push(`🤫 ${npcA.name}和${npcB.name}秘密結盟了！跨公寓的地下聯盟悄然形成。`);
                            // 20% chance spawns power_shift in 3-4 turns
                            if (Math.random() < 0.2) {
                                const familyId = npcA.familyId ?? npcB.familyId;
                                spawnEffect(s, 'power_shift', 3 + Math.floor(Math.random() * 2),
                                    `秘密同盟開始暗中影響家庭的權力格局……`,
                                    { familyId: familyId ?? undefined, involvedNpcIds: involved, chainFrom: eff.id });
                            }
                        }
                    }
                    break;
                }

                // ── power_shift (權力更迭) ──
                case 'power_shift': {
                    const familyId = eff.familyId;
                    const members = familyId
                        ? s.npcs.filter(n => n.familyId === familyId)
                        : (eff.involvedNpcIds ?? []).map(id => s.npcs.find(n => n.id === id)).filter((n): n is SimNPC => !!n);
                    if (members.length >= 2) {
                        const weakest = members.reduce((a, b) => a.mood < b.mood ? a : b);
                        const strongest = members.reduce((a, b) => a.mood > b.mood ? a : b);
                        weakest.mood = clamp(weakest.mood + 30);
                        strongest.mood = clamp(strongest.mood - 20);
                        s.chaosLevel = clamp(s.chaosLevel + 8, 0, 100);
                        events.push(`👑 權力更迭！${weakest.name}翻身得勢（心情+30），${strongest.name}失勢（心情-20）！`);
                    }
                    break;
                }

                // ── reconciliation (和解) ──
                case 'reconciliation': {
                    const involved = eff.involvedNpcIds ?? [];
                    if (involved.length >= 2) {
                        const npcA = s.npcs.find(n => n.id === involved[0]);
                        const npcB = s.npcs.find(n => n.id === involved[1]);
                        if (npcA && npcB) {
                            adjustRelationship(s, npcA.id, npcB.id, 40);
                            npcA.mood = clamp(npcA.mood + 15);
                            npcB.mood = clamp(npcB.mood + 15);
                            s.chaosLevel = clamp(s.chaosLevel - 10, 0, 100);
                            // Remove grudges between them
                            if (npcA.grudges) npcA.grudges = npcA.grudges.filter(id => id !== npcB.id);
                            if (npcB.grudges) npcB.grudges = npcB.grudges.filter(id => id !== npcA.id);
                            events.push(`🕊️ ${npcA.name}和${npcB.name}終於和解了！兩人冰釋前嫌，氣氛變得溫暖。`);
                        }
                    }
                    break;
                }

                default:
                    events.push(`⚡ ${eff.description}`);
                    break;
            }
        } else {
            remaining.push(eff);
        }
    }

    s.pendingEffects = remaining;
    return { newState: s, events };
}

// ── 回合推進 & 遊戲結束判定 ──────────────────────────────────

export function advanceTurn(state: LifeSimState): LifeSimState {
    const s = deepClone(state);
    s.turnNumber += 1;
    return s;
}

export function checkGameOver(state: LifeSimState): { over: boolean; reason?: string } {
    // Chaos no longer ends the game — only empty world does
    if (state.npcs.length <= 0) return { over: true, reason: '所有人都搬走了，這座城市空無一人……' };
    return { over: false };
}

// ── 描述函數 (UI輔助) ──────────────────────────────────────────

export function getFamilyAtmosphere(state: LifeSimState, familyId: string): string {
    const family = getFamily(state, familyId);
    if (!family || family.memberIds.length === 0) return '無人';
    const members = getFamilyMembers(state, familyId);
    if (members.length <= 1) return '獨居';
    let totalRel = 0; let relCount = 0;
    for (const a of members) {
        for (const b of members) {
            if (a.id !== b.id) { totalRel += getRelationship(family, a.id, b.id); relCount++; }
        }
    }
    const avg = relCount > 0 ? totalRel / relCount : 0;
    if (avg > 50) return '室友情深 🤝';
    if (avg > 20) return '相安無事 😐';
    if (avg > -10) return '暗流湧動 😬';
    if (avg > -40) return '互看不順 😤';
    return '快要翻臉 💢';
}

export function getChaosLabel(chaos: number): { label: string; color: string } {
    if (chaos < 20) return { label: '歲月靜好', color: 'text-green-500' };
    if (chaos < 40) return { label: '有點drama', color: 'text-yellow-500' };
    if (chaos < 60) return { label: '全員修羅場', color: 'text-orange-500' };
    if (chaos < 80) return { label: '社死現場', color: 'text-red-500' };
    return { label: '都市廢墟', color: 'text-purple-600' };
}

export function getRelLabel(val: number): { label: string; color: string } {
    if (val > 60) return { label: '親密', color: 'text-pink-500' };
    if (val > 30) return { label: '友好', color: 'text-green-500' };
    if (val > 0)  return { label: '普通', color: 'text-gray-400' };
    if (val > -30) return { label: '不合', color: 'text-yellow-500' };
    if (val > -60) return { label: '敵視', color: 'text-orange-500' };
    return { label: '死敵', color: 'text-red-600' };
}

export function getMoodLabel(mood: number): { label: string; emoji: string } {
    if (mood > 60) return { label: '心情很好', emoji: '😄' };
    if (mood > 30) return { label: '還不錯', emoji: '🙂' };
    if (mood > 0)  return { label: '一般', emoji: '😐' };
    if (mood > -30) return { label: '不太好', emoji: '😕' };
    if (mood > -60) return { label: '很差', emoji: '😤' };
    return { label: '崩潰邊緣', emoji: '😡' };
}

/** 獲取今日節日（如果有的話）*/
export function getTodayFestival(state: LifeSimState): SimFestival | undefined {
    return FESTIVALS.find(f => f.season === state.season && f.day === state.day);
}

// ── 深克隆 ────────────────────────────────────────────────────

function deepClone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj));
}

export { deepClone };
