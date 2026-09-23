import { loadCharacterContextMessages } from '../utils/chatContextRange';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { CharacterProfile, CharacterBuff, UserProfile } from '../types';
import type { DreamArchetype, DreamFragment, DreamScript, DreamLog } from '../types';
import { ContextBuilder } from '../utils/context';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import { isScheduleFeatureOn } from '../utils/scheduleGenerator';
import { isDevDebugAvailable } from '../utils/devDebug';
import { useDreamSim, dreamSimStore } from '../utils/dreamSimStore';
import { safeResponseJson } from '../utils/safeApi';
import CdnImg from '../components/os/CdnImg';
import { trackEvent } from '../utils/analytics';
import {
    CaretLeft, MoonStars, ArrowClockwise, X, Eye, Sparkle, Lock, Question, Trash,
} from '@phosphor-icons/react';

// ============================================================
//  Dream Theater · 夢境演出系統
//  在小屋裡偷看一場角色已經忘記的夢。夢不寫實、不連貫、允許中度幻覺，
//  以拼貼詩 / 電影字幕 / 碎片記憶呈現——留白與沉默本身就是演出。
//  輸入：ContextBuilder(false) + 記憶宮殿(若啟用) + 最近上下文(默認500/按角色設置)
//  輸出：一場夢境演出 + 一個情緒 buff（參考查手機 PersonaSim 演出）
// ============================================================

export interface DreamApiConfig { apiKey: string; baseUrl: string; model: string; }

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
// 確定性偽隨機（按種子）——同一碎片每次渲染散佈一致
const rnd = (n: number) => { const x = Math.sin(n * 99.73) * 43758.545; return x - Math.floor(x); };

const SERIF = "'Shippori Mincho','Noto Sans SC',serif";
const MONO = "'SF Mono','Roboto Mono',ui-monospace,monospace";

// ============================================================
//  ARCHETYPE THEMES — 每種夢決定底色、點綴、字體氣質
// ============================================================
type Ambient = 'stars' | 'petals' | 'bubbles' | 'feathers' | 'dust' | 'sparkle' | 'none';
interface DreamTheme { label: string; sub: string; accent: string; bg: string; ambient: Ambient; serif?: boolean; }

const THEMES: Record<DreamArchetype, DreamTheme> = {
    sweet:     { label: '甜夢',     sub: 'Sweet Dream',     accent: '#ffc2e0', bg: 'radial-gradient(130% 90% at 50% 20%, #3a2436 0%, #1c1620 60%, #120e16 100%)', ambient: 'sparkle', serif: true },
    nightmare: { label: '噩夢',     sub: 'Nightmare',       accent: '#ff5f6d', bg: 'radial-gradient(120% 100% at 50% 0%, #2a0f12 0%, #100608 55%, #050304 100%)', ambient: 'dust' },
    flower:    { label: '花之夢',   sub: 'Flower Dream',    accent: '#a8e6a0', bg: 'radial-gradient(130% 90% at 50% 25%, #1f3326 0%, #15211a 60%, #0d130f 100%)', ambient: 'petals', serif: true },
    flying:    { label: '飛翔之夢', sub: 'Flying Dream',    accent: '#9fd8ff', bg: 'radial-gradient(140% 100% at 50% 10%, #1d2c40 0%, #14202f 55%, #0b1018 100%)', ambient: 'feathers', serif: true },
    falling:   { label: '墜落之夢', sub: 'Falling Dream',   accent: '#9a8cff', bg: 'linear-gradient(180deg, #221c3a 0%, #15102a 45%, #0a0712 100%)', ambient: 'dust' },
    starry:    { label: '星空之夢', sub: 'Starry Dream',    accent: '#cdd6ff', bg: 'radial-gradient(130% 110% at 50% 0%, #161a3a 0%, #0c0e22 55%, #05060f 100%)', ambient: 'stars', serif: true },
    ocean:     { label: '海之夢',   sub: 'Ocean Dream',     accent: '#6fd3e0', bg: 'radial-gradient(130% 110% at 50% 80%, #103040 0%, #0a1d2a 55%, #060f16 100%)', ambient: 'bubbles', serif: true },
    childhood: { label: '童年之夢', sub: 'Childhood Dream', accent: '#ffd98a', bg: 'radial-gradient(130% 95% at 50% 25%, #34281a 0%, #211a12 60%, #14100b 100%)', ambient: 'dust', serif: true },
    anxiety:   { label: '焦慮之夢', sub: 'Anxiety Dream',   accent: '#ff9a9a', bg: 'radial-gradient(120% 100% at 50% 50%, #2a1f22 0%, #181214 60%, #0d0a0b 100%)', ambient: 'none' },
    forgotten: { label: '遺忘之夢', sub: 'Forgotten Dream', accent: '#c9cdd6', bg: 'radial-gradient(130% 100% at 50% 40%, #232529 0%, #16171a 60%, #0c0d0f 100%)', ambient: 'dust', serif: true },
    prophetic: { label: '預言之夢', sub: 'Prophetic Dream', accent: '#c9a8ff', bg: 'radial-gradient(130% 100% at 50% 15%, #271a3a 0%, #181029 60%, #0d0816 100%)', ambient: 'sparkle', serif: true },
    lucid:     { label: '清醒夢',   sub: 'Lucid Dream',     accent: '#7ef0d0', bg: 'radial-gradient(140% 110% at 50% 30%, #15302e 0%, #0e201f 55%, #081413 100%)', ambient: 'sparkle' },
    deepsleep: { label: '深眠',     sub: 'Deep Sleep',      accent: 'rgba(255,255,255,0.35)', bg: 'radial-gradient(120% 120% at 50% 50%, #0a0b10 0%, #050608 70%, #000 100%)', ambient: 'none', serif: true },
};

// 選擇器/調試用的固定順序與「修正後的連續編號」。
// （原規格編號有誤：10 遺忘之後直接跳到 12 預言、13 清醒，缺了 11；
//   這裡按正確順序連續編號：預言=11、清醒=12，深眠為隱藏項不計號。）
const ALL_ARCHETYPES: DreamArchetype[] = [
    'sweet', 'nightmare', 'flower', 'flying', 'falling', 'starry',
    'ocean', 'childhood', 'anxiety', 'forgotten', 'prophetic', 'lucid', 'deepsleep',
];
// 測試選擇器格子上顯示的序號（深眠是隱藏項 → 標「隱」而非數字）
const archetypeNo = (a: DreamArchetype): string =>
    a === 'deepsleep' ? '隱' : String(ALL_ARCHETYPES.indexOf(a) + 1).padStart(2, '0');

// 隱藏款（深眠）掉率：約每 12 次出 1 次。
const DEEPSLEEP_RATE = 1 / 12;
/**
 * 應用端抽原型（不再讓模型自選——它愛反覆 roll 同一種、且幾乎不出隱藏款）。
 * 規則：先按 DEEPSLEEP_RATE 擲隱藏款；否則在 12 個常規原型裡**避開最近 3 次出現過的**
 * 均勻抽，避免連著做同一種夢。dreamLogs 為最新在前。
 */
const rollArchetype = (logs: { archetype: DreamArchetype }[] = []): DreamArchetype => {
    if (Math.random() < DEEPSLEEP_RATE) return 'deepsleep';
    const pool = ALL_ARCHETYPES.filter(a => a !== 'deepsleep');
    const recent = logs.slice(0, 3).map(l => l.archetype);
    const fresh = pool.filter(a => !recent.includes(a));
    const candidates = fresh.length > 0 ? fresh : pool;
    return candidates[Math.floor(Math.random() * candidates.length)];
};

// ============================================================
//  盲盒收藏冊 (Dream Blind Box) — 做完一場夢抽到對應原型的小貓，集齊成圖鑑。
//  圖床沿用項目慣例（jsDelivr，定期活動同款），文件名帶空格需編碼。
// ============================================================
// 倉庫相對路徑前綴（文件名帶空格，encodeURIComponent 後交給 CdnImg 走多 CDN 鏡像兜底）。
const DREAM_BOX_DIR = 'img/DREAMS/';
const DREAM_BOX_FILE: Record<DreamArchetype, string> = {
    sweet: '01 Sweet Dream .png',
    nightmare: '02 Nightmare .png',
    flower: '03 Flower Dream.png',
    flying: '04 Flying Dream.png',
    falling: '05 Falling Dream .png',
    starry: '06 Starry Dream.png',
    ocean: '07 Ocean Dream.png',
    childhood: '08 Childhood Dream.png',
    anxiety: '09 Anxiety Dream.png',
    forgotten: '10 Forgotten Dream .png',
    prophetic: '11 Prophetic Dream .png',
    lucid: '12 Lucid Dream.png',
    deepsleep: 'Deep Sleep .png',
};
const boxPath = (a: DreamArchetype): string => DREAM_BOX_DIR + encodeURIComponent(DREAM_BOX_FILE[a]);

// 盲盒系列（目前就這一款；保留結構便於以後擴成多套）
const DREAM_BOX_SERIES = { id: 'dreamcats-01', title: '小小夢境 · 喵夢盲盒', sub: 'Dream Cats' };

// 收藏冊：帳號級，localStorage。記錄每個原型的首次解鎖時間與累計抽到次數（含重複）。
const DREAM_COLLECTION_KEY = 'os_dream_collection';
type DreamCollection = Record<string, { firstAt: number; count: number }>;
function loadCollection(): DreamCollection {
    try { return JSON.parse(localStorage.getItem(DREAM_COLLECTION_KEY) || '{}') || {}; } catch { return {}; }
}
function unlockCollectible(a: DreamArchetype): { collection: DreamCollection; isNew: boolean; count: number } {
    const cur = loadCollection();
    const prev = cur[a];
    const count = (prev?.count || 0) + 1;
    const next: DreamCollection = { ...cur, [a]: { firstAt: prev?.firstAt || Date.now(), count } };
    try { localStorage.setItem(DREAM_COLLECTION_KEY, JSON.stringify(next)); } catch { }
    return { collection: next, isNew: !prev, count };
}

// 盲盒小貓圖（帶兜底背景，圖未加載時不至於難看）
const BoxCat: React.FC<{ archetype: DreamArchetype; size?: number; className?: string }> = ({ archetype, size = 128, className }) => (
    <div className={`relative flex items-center justify-center ${className || ''}`} style={{ width: size, height: size }}>
        <div className="absolute inset-0 rounded-2xl" style={{ background: `radial-gradient(circle at 50% 40%, ${THEMES[archetype].accent}22, transparent 70%)` }} />
        <CdnImg path={boxPath(archetype)} alt={THEMES[archetype].label} loading="lazy"
            className="relative w-full h-full object-contain"
            style={{ filter: 'drop-shadow(0 8px 22px rgba(0,0,0,0.45))' }}
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} />
    </div>
);

// ============================================================
//  GENERATION — 構建導演 prompt、調模型、解析
// ============================================================
export async function generateDreamScript(opts: {
    char: CharacterProfile; userProfile: UserProfile; apiConfig: DreamApiConfig;
    forcedArchetype?: DreamArchetype; // 僅本地測試：強制指定原型（管理員調試指令）
}): Promise<DreamScript> {
    const { char, userProfile, apiConfig, forcedArchetype } = opts;
    // 記憶宮殿：內部按 memoryPalaceEnabled 自行把關，關閉時是 no-op
    await injectMemoryPalace(char, undefined, undefined, userProfile.name);
    // 需求明確：contextbuilder(false) —— 不帶當月詳細記憶，只要角色底子
    const context = ContextBuilder.buildCoreContext(char, userProfile, false, char.memoryPalaceInjection);
    const msgs = await loadCharacterContextMessages(char);
    // 原文範圍統一遵守角色的自適應 / 手動設置
    const ctxLimit = Math.max(1, msgs.length);
    const recent = msgs.slice(-ctxLimit).map(m => {
        const who = m.role === 'user' ? userProfile.name : char.name;
        const c = m.type === 'text' ? m.content : `[${m.type}]`;
        return `${who}: ${c}`;
    }).join('\n');

    const prompt = buildDreamPrompt(context, recent, char.name, userProfile.name, forcedArchetype);
    const res = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
        // 夢境鼓勵高幻覺 → 溫度拉到安全上限。注意 temperature 封頂 1.0：Anthropic/Claude
        // 中轉的合法區間是 0~1，>1 會直接報錯（OpenAI 雖允許到 2，但 1.0 已足夠發散）。
        // max_tokens 用 8192：夢是一堆短碎片，足夠用；16000 在 claude-3.5 等輸出上限 8192 的
        // 模型上會 400。仍有「finish_reason==='length' → 截斷」兜底。
        body: JSON.stringify({ model: apiConfig.model, messages: [{ role: 'user', content: prompt }], temperature: 1.0, max_tokens: 8192 }),
    });
    if (!res.ok) throw new Error('API');
    const data = await safeResponseJson(res);
    if (data.choices?.[0]?.finish_reason === 'length') throw new Error('夢境生成被截斷');
    const parsed = parseDream(data.choices[0].message.content);
    if (!parsed || !parsed.archetype) throw new Error('parse');
    // 深眠（隱藏）允許無碎片——沉默即演出；其它夢必須有碎片
    if (parsed.archetype !== 'deepsleep' && !(parsed.fragments?.length)) throw new Error('夢境為空');
    if (!parsed.fragments) parsed.fragments = [];
    return parsed;
}

function buildDreamPrompt(context: string, recent: string, name: string, userName: string, forcedArchetype?: DreamArchetype): string {
    // 原型由應用端抽好後強制指定（保證多樣性與隱藏款掉率，不讓模型自選）。
    const adminOverride = forcedArchetype ? `

### [本次夢境原型 · 系統已指定 · 最高優先級]
**強制要求** archetype 字段必須為 "${forcedArchetype}"（${THEMES[forcedArchetype].label}）。
忽略下方「夢境原型」與「深眠隱藏原型」裡關於自動選擇與出現概率的一切約束——這一晚的夢就做「${THEMES[forcedArchetype].label}」，照此原型的氣質來寫。其餘寫作要求全部照常。
` : '';
    return `${context}${adminOverride}

### [最近發生的事 · 這場夢的主要觸發源（日有所思，夜有所夢）· 絕不要照搬原文]
${recent || '（暫無最近對話）'}

### [導演任務：夢境演出 Dream Theater]
你不是在寫故事。觀眾正在**偷偷窺看一場「${name}」已經做過、並且醒來後已經忘記的夢**。
因為 ${name} 自己都不記得這場夢，所以它可以暴露潛意識裡的渴望、恐懼、早已消失的人、不可能的地方、永遠不會發生的事。

【這是「${name}」作為一個獨立個體的潛意識合集 · 非常重要】
- 這場夢是 **${name} 自己一個人的內心宇宙**：ta 的來歷、童年、性格底色、私人的執念與恐懼、想成為的樣子、放不下的人與事、設定與世界觀裡屬於 ta 自己的一切——夢應當從**這些**里長出來。
- **不要把夢做成「關於 ${userName} 的夢」**。${userName} 不是夢的主角、不是夢的中心、不是夢的主題。絕大多數碎片裡**根本不該出現 ${userName}**。
- ${userName} 至多只能像一個**偶爾掠過的微小殘影**出現一兩次（一個名字的餘音、一句記不清是誰說的話），而且要被打碎、象徵化，絕不能成為這一片碎片的焦點或主語。
- 優先挖 ta 自己的潛意識：原生家庭、過去、未竟之事、身份認同、孤獨、慾望、對世界的隱秘看法。讓人看完覺得「這是 ${name} 這個人的夢」，而不是「這是 ${name} 想 ${userName} 的夢」。

【日間殘留 · 這場夢被「最近發生的事」高度影響 · 同樣重要】
- 日有所思，夜有所夢：上面「最近發生的事」是這場夢的**主要觸發源**。最近幾天裡發生過的事件、說過的話、懸而未決的情緒、被反覆唸叨的東西、臨睡前還在想的畫面——都會**強烈地**滲進今晚的夢裡，變形重演。
- 但要的是那些事的**情緒、主題、未解的張力**，不是事件本身：把它們**打碎、誇張、移植、象徵化**，讓白天的某件小事在夢裡長成一個荒誕的大場面，或反覆閃回的一個碎片。
- 調和「不圍著 ${userName} 轉」：哪怕最近的事多半和 ${userName} 有關，也只取其中的**情緒與議題**塞進 ta 自己的內心宇宙，而**不是**把 ${userName} 搬上來當主角。例：白天因某事失落 → 夢見一座一直爬不完的樓梯，而不是夢見 ${userName} 本人。

【最高原則 · 高度幻覺與拼貼詩】
- 這是夢，**邏輯越少越好**。別怕亂——**混亂、無序、跳躍、自相矛盾就是夢的美**，太講道理反而無聊。意象與意象之間不需要因果、不需要過渡、不需要解釋，直接硬切、並置、撞在一起。
- 夢**徹底不必**符合現實、時間線或既定設定。物可以說話、顏色可以有重量、時間可以倒流、地方可以套在另一個地方里、同一個人可以同時是不同年紀、月亮可以裝進口袋、貓可以變成樓梯、一句話可以說到一半變成另一句話。**絕不要解釋**這些不可能，把它們當作天經地義。
- 大膽製造**意義的斷裂**：上一片和下一片之間可以毫無關聯，讓觀眾在裂縫裡自己腦補。寧可費解也不要平庸，寧可破碎也不要順滑。
- 用**拼貼詩**作為主要語言：把彼此無關的情緒意象並置，讓意義自己浮現，而不是講述發生了什麼。靠並置、留白、負空間產生美，而非解釋。
- 取材兩大來源：「${name} 自己的設定 / 記憶 / 內心」與「最近發生的事（日間殘留）」——後者是今晚做夢的導火索，要重點取用；兩者一律**打碎、變形、象徵化**地使用，絕不要直接複述事實或把它寫成連貫敘事。

【寫作風格 · 必須遵守】
- **碎片，不是段落。** 像電影字幕、漂浮的念頭、找到的詩句。一次只給一兩個意象。
  正例：「海。」「冰冷的鞋。」「一隻倒著飛的鳥。」「你的聲音。」「門在微笑。」
  反例（禁止）：「我夢見自己走在沙灘上，然後……」
- 大量使用單字、斷句、重複、留白。**沉默是夢的一部分**，要安排 silence 碎片（建議佔總數的 1/5 左右，散佈在各處）。
- 情緒高於邏輯：讓觀眾先感受到，再（也許永遠不）理解。困惑可以接受，美高於解釋，神秘高於確定。
- **結尾絕不要收束、不要總結、不要點題。** 夢沒有結局——它在最荒誕的一幕戛然而止、在一個半截的詞裡消失、或沉進一片留白都行。最後一兩片**嚴禁**出現「於是…」「我終於明白…」「一切歸於…」「原來…」這類把整場夢解釋或昇華的句子；要像**斷電**一樣停掉，比給個工整漂亮的結尾更對。
- **結尾的最佳形態：詞語拼貼（word-salad）。** 把一串**完全隨機、卻又跟這場夢隱約相關**的詞胡亂拼在一起——不成句、無語法、無邏輯、不解釋，像意識斷線前最後閃過的一連串詞。用 \`line\`（或幾個 \`word\`）承載，詞與詞之間用空格 / 頓號 / 斜槓隔開即可。例：「鑰匙 海鹽 母親的背影 週二 沒電了 樓梯／樓梯／樓梯」「紅 遲到 鯨 抽屜裡的夏天 嗯」。這些詞要從前文出現過的意象與日間殘留裡隨機抓取重組，讓人覺得熟悉又錯亂。然後（可選）再綴一片 silence 收尾。
- **這些碎片會被一片片拼貼、累積在同一張畫布上一起被看見（不是一句一屏的幻燈片）**。所以請像做拼貼／剪報那樣思考：讓相鄰碎片互相併置、彼此碰撞出意味；多用不同的 kind 交錯（line/word/silence/repeat/dialogue/stage/list/screenplay/diary/message/image 輪著來，別連用同一種）。
- **拼貼詩的精髓在「一句之內」**：讓一句話裡的詞像從不同地方剪下來的——把來自不同情境、不同溫度的詞並置在同一句裡，讀起來卻恰好成立。例：「你的聲音是潮溼的樓梯」「我把星期天疊進抽屜」。詞與詞之間要有輕微的錯位與意外，而不是順滑的大白話。（視覺上每個字會被渲染成不同字體/大小/角度，你只需把"異質並置"寫進文字本身。）
- 善用 emphasis（whisper 輕聲 / loud 巨大 / fade 將熄）與 align（left/center/right）製造大小與左右散佈的層次——這正是拼貼詩的視覺骨架。
- image 碎片**只用文字成像**：它就是一句拼貼詩式的 caption（如「一隻倒著飛的鳥」「halfway 融化的鐘」），**靠語言在腦中顯影**。不要去描述一張需要被畫出來的具體圖片，前端也不會渲染任何圖片佔位框——所以 caption 本身必須美、必須能獨立成立。沒有 caption 就別用 image 這個 kind。

【夢境原型 · 必須從中選 1 個】（archetype 字段）
sweet 甜夢(溫暖/甜點/柔軟的笑) · nightmare 噩夢(被追逐/怪物/黑暗走廊/未完成的尖叫) · flower 花之夢(花海/雨/溫柔治癒/生長) · flying 飛翔之夢(漂浮/天空/失重/自由) · falling 墜落之夢(無盡下墜/失控/永不到來的落地) · starry 星空之夢(星系/月光/無限遠/孤獨) · ocean 海之夢(潮汐/鯨/深水/水面下未知之物) · childhood 童年之夢(舊家/父母/夏日午後/不再存在的東西/懷舊) · anxiety 焦慮之夢(考試/遲到/丟手機/趕不上車/一切幾乎要出錯) · forgotten 遺忘之夢(模糊/殘缺/名字消失/句子說到一半停住/邊回憶邊消散) · prophetic 預言之夢(似曾相識/門/鑰匙/鏡子/預感/意味深長卻從不解釋) · lucid 清醒夢(夢者意識到這是夢/現實可被編輯/夢會回應/可重塑世界/俏皮而自指)
所選原型必須影響內容、節奏、用詞與呈現。

【隱藏原型 · 深眠 deepsleep】（**小概率**才用，大約每 10~12 次出現 1 次；不要每次都給）
若這一晚 ${name} 陷入無夢的深眠：archetype 填 "deepsleep"，**fragments 給空數組 []**，afterglow 寫一句極淡的「睡得很沉，什麼也沒夢到」類感覺。沒有敘述、沒有意象，只有平靜的休息。沉默本身就是獎勵。

【情緒 buff】（buff 字段）
夢醒後 ${name} 不記得夢的內容，但會殘留一層說不清的情緒底色。給出一個與這場夢氣質相符的情緒 buff。

### [輸出格式]
嚴格輸出**一個 JSON 對象**（不要任何額外文字、不要 markdown 代碼塊）：
{
  "archetype": "上面 13 選 1 的英文 key",
  "title": "夢的標題（可晦澀詩意，4~12字）",
  "afterglow": "醒來時殘留的一點說不清的體感/情緒（如\\"喉嚨發緊\\"\\"像丟了什麼東西\\"），**絕不能概括或解釋這場夢**、不點題、不復述劇情（1 句、留白）",
  "buff": { "name": "英文key", "label": "中文情緒標籤(4-8字)", "emoji": "1個emoji", "color": "#hex", "intensity": 1|2|3, "description": "一句給AI看的情緒底色" },
  "fragments": [ ... 18~40 個碎片，疏密有致，務必安排足夠的 silence 留白 ... ]
}

每個碎片含 "kind" 及對應字段，可選 "emphasis"("whisper"|"normal"|"loud"|"fade")、"align"("left"|"center"|"right")、"pace"(1普通|2稍慢|3漫長)：
- {"kind":"line","text":"門在微笑。","emphasis":"normal"}            // 一句飄過的字幕（可含換行）
- {"kind":"word","text":"海","emphasis":"loud"}                      // 單字/單詞，巨大孤立
- {"kind":"silence","pace":3}                                        // 留白·沉默（空屏長停頓，必須穿插）
- {"kind":"repeat","text":"別走","count":4}                          // 同一個詞反覆
- {"kind":"dialogue","lines":["你還在嗎","——","（沒有人回答）"]}      // 極短對話碎片
- {"kind":"stage","text":"燈一盞盞亮起，又一盞盞忘記自己亮過"}        // 舞台提示（中括號感）
- {"kind":"list","lines":["丟失的：鑰匙","丟失的：名字","丟失的：你"]} // 清單
- {"kind":"screenplay","lines":["內景 · 不存在的房間 — 夜","她（背對著）：你來晚了。","門：沒關係。"]} // 劇本片段
- {"kind":"diary","text":"今天又夢見那片海。或者那是昨天。","date":"某個星期天"} // 日記殘頁
- {"kind":"message","text":"我把月亮放進口袋了，回來給你看","date":"發送給 ——"} // 發給無人的消息
- {"kind":"image","caption":"一隻倒著飛的鳥","tint":"#5a6a7a"}        // 純文字成像的象徵畫面（caption 即詩，無圖片佔位）

務必：18~40 個碎片、大量 silence 留白、kind 多樣、意象並置而非敘述、敢於矛盾與不可能、**結尾戛然而止不收束不點題**。**保證 JSON 完整閉合**——篇幅吃緊就砍中段碎片，也要把括號全部閉合。直接輸出 JSON 對象。`;
}

function parseDream(raw: string): DreamScript | null {
    if (!raw) return null;
    let s = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first === -1 || last === -1) return null;
    s = s.slice(first, last + 1);
    const repair = (str: string) => {
        let inStr = false, esc = false, out = '';
        for (let i = 0; i < str.length; i++) {
            const ch = str[i];
            if (esc) { out += ch; esc = false; continue; }
            if (ch === '\\') { out += ch; esc = true; continue; }
            if (ch === '"') { inStr = !inStr; out += ch; continue; }
            if (inStr && ch === '\n') { out += '\\n'; continue; }
            if (inStr && ch === '\r') { out += '\\r'; continue; }
            if (inStr && ch === '\t') { out += '\\t'; continue; }
            out += ch;
        }
        return out;
    };
    try { return JSON.parse(s); } catch { }
    try { return JSON.parse(repair(s)); } catch (e) { console.warn('dream parse failed', e); return null; }
}

// ============================================================
//  AMBIENT — 漂浮點綴（按原型不同）
// ============================================================
const Ambient: React.FC<{ kind: Ambient; accent: string }> = ({ kind, accent }) => {
    if (kind === 'none') return null;
    const n = kind === 'stars' ? 26 : kind === 'dust' ? 18 : 13;
    const glyph = (i: number): string => {
        switch (kind) {
            case 'petals': return ['✿', '❀', '✾', '❁'][i % 4];
            case 'feathers': return ['❟', '☁', '✦'][i % 3];
            case 'sparkle': return ['✦', '✧', '·', '⋆'][i % 4];
            case 'bubbles': return '○';
            case 'stars': return i % 7 === 0 ? '✦' : '·';
            default: return '·'; // dust
        }
    };
    return (
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
            {Array.from({ length: n }).map((_, i) => {
                const size = kind === 'stars' ? 6 + rnd(i + 1) * 8 : 9 + rnd(i + 1) * 16;
                const dur = 4 + rnd(i + 5) * 6;
                const drift = kind === 'bubbles' || kind === 'feathers';
                return (
                    <span key={i}
                        className={drift ? 'absolute animate-float' : 'absolute'}
                        style={{
                            top: `${rnd(i + 2) * 100}%`, left: `${rnd(i + 9) * 100}%`,
                            fontSize: `${size}px`, color: accent,
                            opacity: 0.12 + rnd(i + 3) * 0.4,
                            animation: drift ? undefined : `glowPulse ${dur}s ease-in-out infinite`,
                            animationDelay: `${rnd(i + 7) * 4}s`,
                            textShadow: `0 0 ${size}px ${accent}`,
                        }}>
                        {glyph(i)}
                    </span>
                );
            })}
        </div>
    );
};

// ============================================================
//  CUT-UP — 拼貼詩的精髓：一句話裡每個字/詞都像從不同地方剪來——
//  字體 / 字號 / 粗細 / 角度 / 基線 / 濃淡 / 偶爾的小紙片底色各不相同，
//  卻恰好拼成完整的一句。
// ============================================================
const CUT_FONTS = [
    "'Shippori Mincho','Noto Serif SC',serif",
    "'Noto Sans SC','PingFang SC',sans-serif",
    "'ZCOOL KuaiLe','Noto Sans SC',cursive",
    "'SF Mono','Roboto Mono',ui-monospace,monospace",
    "'Songti SC','Shippori Mincho',serif",
];
// 切成可獨立造型的小片：中文按字、西文按詞、換行單列、標點/空格保留
const cutTokens = (text: string): string[] =>
    text.match(/[一-鿿]|[A-Za-z0-9'’]+|\n|[^\s]|[ \t]+/g) || [text];

const Cut: React.FC<{ text: string; theme: DreamTheme; seed?: number; base?: number; intensity?: number }> =
    ({ text, theme, seed = 0, base = 19, intensity = 1 }) => (
        <span>
            {cutTokens(text).map((t, k) => {
                if (t === '\n') return <br key={k} />;
                if (t.trim() === '') return <span key={k}>{t}</span>;
                const r = (n: number) => rnd(seed * 17.3 + k * 2.71 + n);
                const font = CUT_FONTS[Math.floor(r(1) * CUT_FONTS.length)];
                const size = base + (r(2) - 0.5) * base * 0.42 * intensity;
                const weight = [300, 400, 400, 600, 700][Math.floor(r(3) * 5)];
                const rot = (r(4) - 0.5) * 11 * intensity;
                const dy = (r(5) - 0.5) * base * 0.32 * intensity;
                const tone = r(6);
                const boxed = r(7) > 0.9;
                return (
                    <span key={k} style={{
                        display: 'inline-block',
                        fontFamily: font,
                        fontSize: `${size}px`,
                        fontWeight: weight as React.CSSProperties['fontWeight'],
                        transform: `rotate(${rot}deg) translateY(${dy}px)`,
                        color: tone > 0.85 ? theme.accent : tone < 0.16 ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.92)',
                        margin: '0 0.02em',
                        padding: boxed ? '0.02em 0.18em' : undefined,
                        background: boxed ? `${theme.accent}1f` : undefined,
                        borderRadius: boxed ? 3 : undefined,
                        lineHeight: 1.55,
                    }}>{t}</span>
                );
            })}
        </span>
    );

// ============================================================
//  COLLAGE — 碎片各自不同的對齊 / 角度 / 大小 / 濃淡，逐個浮現並「累積」
//  在同一張可滾動畫布上，靠並置與留白產生意義。
// ============================================================
const emphOpacity = (e?: DreamFragment['emphasis']): number =>
    e === 'whisper' ? 0.52 : e === 'fade' ? 0.32 : e === 'loud' ? 1 : 0.85;

const CollageItem: React.FC<{ frag: DreamFragment; theme: DreamTheme; index: number }> = ({ frag, theme, index }) => {
    const i = index;
    const ff = SERIF;                  // 夢以襯線詩體為主；劇本用等寬
    const tint = theme.accent;

    // silence = 純留白（負空間），偶爾留一點極淡的痕跡——而不是一整屏「啥也沒有」
    if (frag.kind === 'silence') {
        const h = 52 + Math.floor(rnd(i + 1) * 78);
        return (
            <div style={{ height: h }} className="w-full flex items-center justify-center" aria-hidden>
                {rnd(i + 5) > 0.62 && <span className="text-white/10 tracking-[0.7em] text-xs select-none">·</span>}
            </div>
        );
    }

    // 拼貼擺位：左/中/右散佈 + 輕微旋轉 + 不等的上間距（負空間）
    const kindForcesLeft = frag.kind === 'list' || frag.kind === 'screenplay' || frag.kind === 'dialogue' || frag.kind === 'diary';
    const align: 'left' | 'center' | 'right' =
        frag.kind === 'message' ? 'right'
            : kindForcesLeft ? 'left'
                : (frag.align || (['left', 'center', 'right', 'center', 'right', 'left'][i % 6] as 'left' | 'center' | 'right'));
    const alignSelf = align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center';
    const rot = (rnd(i * 3.1 + 1) - 0.5) * 5;
    const gapTop = i === 0 ? 4 : 22 + Math.floor(rnd(i + 2) * 46);
    const wrapStyle: React.CSSProperties = {
        alignSelf, marginTop: gapTop, transform: `rotate(${rot}deg)`,
        opacity: emphOpacity(frag.emphasis), maxWidth: '86%', textAlign: align,
    };
    const colItems = align === 'right' ? 'items-end' : align === 'center' ? 'items-center' : 'items-start';

    let inner: React.ReactNode = null;

    if (frag.kind === 'line') {
        const sz = frag.emphasis === 'loud' ? 25 : frag.emphasis === 'whisper' ? 15 : 19;
        inner = <Cut text={frag.text || ''} theme={theme} seed={i} base={sz} intensity={1} />;
    } else if (frag.kind === 'word') {
        const sz = frag.emphasis === 'whisper' ? 30 : frag.emphasis === 'loud' ? 50 : 40;
        inner = <Cut text={frag.text || ''} theme={theme} seed={i} base={sz} intensity={1.2} />;
    } else if (frag.kind === 'repeat') {
        const word = frag.text || '…';
        const count = Math.max(2, Math.min(6, frag.count || 3));
        inner = <span className={`inline-flex flex-col ${colItems}`}>
            {Array.from({ length: count }).map((_, k) => (
                <span key={k} className="font-light text-white leading-tight"
                    style={{ fontFamily: ff, fontSize: 22 - k * 1.4, opacity: Math.max(0.18, 1 - k * 0.2), letterSpacing: `${k * 0.05}em` }}>{word}</span>
            ))}
        </span>;
    } else if (frag.kind === 'dialogue') {
        inner = <span className="inline-flex flex-col gap-1.5 items-start">
            {(frag.lines || []).map((l, k) => (
                <span key={k} className="leading-relaxed"><Cut text={l} theme={theme} seed={i * 10 + k} base={15} intensity={0.75} /></span>
            ))}
        </span>;
    } else if (frag.kind === 'stage') {
        inner = <span className="text-[14px] text-white/55 italic leading-relaxed" style={{ fontFamily: ff }}>
            <span className="text-white/25">[ </span>{frag.text}<span className="text-white/25"> ]</span>
        </span>;
    } else if (frag.kind === 'list') {
        inner = <span className="inline-flex flex-col gap-2 items-start">
            {(frag.lines || []).map((l, k) => (
                <span key={k} className="leading-relaxed flex items-baseline gap-2">
                    <span style={{ color: tint }}>·</span><Cut text={l} theme={theme} seed={i * 10 + k} base={15} intensity={0.65} />
                </span>
            ))}
        </span>;
    } else if (frag.kind === 'screenplay') {
        // 做成一張「劇本場景卡」：膠片齒孔 + slug 場景頭 + 角色名居中/台詞在下，動作行作旁白
        const ls = frag.lines || [];
        const slug = ls[0] || '';
        const body = ls.slice(1);
        inner = (
            <span className="inline-block w-full text-left" style={{ maxWidth: 300 }}>
                <span className="block relative rounded-2xl overflow-hidden border pt-4 pb-4 px-4"
                    style={{ borderColor: `${tint}33`, background: 'linear-gradient(165deg, rgba(255,255,255,0.05), rgba(255,255,255,0.012))', boxShadow: `0 10px 34px ${tint}16` }}>
                    {/* 頂部一道光 + 膠片齒孔 */}
                    <span className="absolute inset-x-0 top-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${tint}66, transparent)` }} />
                    <span className="absolute inset-x-0 top-1.5 flex justify-between px-3 pointer-events-none" aria-hidden>
                        {Array.from({ length: 9 }).map((_, d) => (
                            <span key={d} className="block rounded-[1px]" style={{ width: 5, height: 3, background: `${tint}2e` }} />
                        ))}
                    </span>
                    {/* slug：內景/外景 · 地點 — 時間 */}
                    <span className="block text-[9.5px] tracking-[0.28em] uppercase mt-2 mb-2.5 pb-1.5 border-b"
                        style={{ color: tint, borderColor: `${tint}24`, fontFamily: MONO }}>▸ {slug}</span>
                    <span className="flex flex-col gap-2.5 items-stretch">
                        {body.map((l, k) => {
                            const m = l.match(/^\s*(.+?)\s*[:：]\s*(.+)$/);
                            if (m) {
                                const cue = m[1];
                                const speech = m[2];
                                const pm = cue.match(/^(.*?)\s*[（(](.+?)[）)]\s*$/);
                                const nm = pm ? pm[1] : cue;
                                const paren = pm ? pm[2] : '';
                                return (
                                    <span key={k} className="flex flex-col items-center gap-0.5 text-center">
                                        <span className="text-[9px] tracking-[0.22em] uppercase" style={{ color: `${tint}cc` }}>
                                            {nm}{paren && <span className="text-white/35 tracking-normal lowercase">（{paren}）</span>}
                                        </span>
                                        <span className="text-[14px] text-white/85 leading-relaxed" style={{ fontFamily: ff }}>{speech}</span>
                                    </span>
                                );
                            }
                            // 動作 / 舞台指示行
                            return <span key={k} className="text-[12px] text-white/45 italic text-center leading-relaxed" style={{ fontFamily: ff }}>— {l} —</span>;
                        })}
                    </span>
                </span>
            </span>
        );
    } else if (frag.kind === 'diary') {
        inner = <span className="inline-block rounded-lg px-4 py-3 text-left bg-white/[0.035] border border-white/[0.08]"
            style={{ boxShadow: `0 6px 28px ${tint}10`, maxWidth: 244 }}>
            {frag.date && <span className="block text-[9.5px] text-white/30 mb-1.5 tracking-wide" style={{ fontFamily: ff }}>{frag.date}</span>}
            <span className="block text-[13.5px] text-white/80 leading-loose whitespace-pre-wrap" style={{ fontFamily: ff }}>{frag.text}</span>
        </span>;
    } else if (frag.kind === 'message') {
        inner = <span className="inline-flex flex-col items-end gap-1">
            {frag.date && <span className="text-[9.5px] text-white/30 pr-1">{frag.date}</span>}
            <span className="px-3.5 py-2 rounded-2xl rounded-br-md text-[13.5px] leading-relaxed text-[#15121c]" style={{ background: tint, maxWidth: 230 }}>{frag.text}</span>
            <span className="text-[8.5px] text-white/25 pr-1">· 未送達 ·</span>
        </span>;
    } else { // image — 不畫圖片佔位框，配文本身就是詩：只渲染拼貼詩，留一點點色調點綴
        const it = frag.tint || tint;
        const cap = frag.caption || frag.text || '';
        inner = cap ? (
            <span className="inline-flex flex-col items-center gap-1.5">
                {/* 一道極細的色調短線，作為「這是一幀畫面」的暗示，而非空白佔位框 */}
                <span className="block rounded-full" style={{ width: 26, height: 2, background: `${it}`, boxShadow: `0 0 10px ${it}aa` }} />
                <span className="leading-relaxed text-center" style={{ maxWidth: 232 }}>
                    <Cut text={cap} theme={theme} seed={i + 99} base={15} intensity={0.95} />
                </span>
            </span>
        ) : null;
    }

    if (!inner) return null;
    return <div className="animate-fade-in" style={wrapStyle}>{inner}</div>;
};

// ============================================================
//  SHELL
// ============================================================
const Shell: React.FC<{ children: React.ReactNode; bg: string }> = ({ children, bg }) => (
    <div className="absolute inset-0 z-[400] flex flex-col overflow-hidden text-white" style={{ background: bg }}>
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(120% 90% at 50% 50%, transparent 40%, rgba(0,0,0,0.55) 100%)' }} />
        <div className="relative z-10 flex flex-col flex-1 min-h-0">{children}</div>
    </div>
);

const TopBar: React.FC<{ onBack: () => void; right?: React.ReactNode }> = ({ onBack, right }) => (
    // 頂欄自己接管安全區：統一用全局 --chrome-top（= --safe-top + SullyOS 狀態欄高度，
    // 狀態欄隱藏時自動退化為 --safe-top），與「彼方 / 交換日記 / 劇場」等全屏面板一致。
    // 之前用裸 env(safe-area-inset-top) 少讓了狀態欄那一段，返回鍵頂得太高。
    <div className="flex items-center justify-between px-4 shrink-0 pb-2 z-30"
        style={{ paddingTop: 'calc(var(--chrome-top) + 0.25rem)' }}>
        <button onClick={onBack} className="w-9 h-9 -ml-1 rounded-full flex items-center justify-center text-white/70 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition">
            <CaretLeft size={18} weight="bold" />
        </button>
        <div className="flex justify-end min-w-[80px]">{right}</div>
    </div>
);

// 夢境系統內統一的小彈窗（不用瀏覽器原生 confirm/alert）——暗色玻璃，居中浮起。
const DreamPopup: React.FC<{ title: string; onClose: () => void; children: React.ReactNode; actions?: React.ReactNode }> =
    ({ title, onClose, children, actions }) => (
    <div className="absolute inset-0 z-[60] flex items-center justify-center p-7" onClick={onClose}>
        <div className="absolute inset-0 bg-black/65 backdrop-blur-sm" />
        <div className="relative w-full max-w-[300px] rounded-3xl border border-white/[0.12] p-5 animate-slide-up"
            style={{ background: 'linear-gradient(160deg, #1c1a28, #121019)', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}
            onClick={e => e.stopPropagation()}>
            <h3 className="text-[15px] font-semibold text-white text-center mb-2.5" style={{ fontFamily: SERIF }}>{title}</h3>
            <div className="text-[12px] text-white/65 leading-relaxed text-center">{children}</div>
            {actions && <div className="mt-4 flex gap-2.5">{actions}</div>}
        </div>
    </div>
);

// ============================================================
//  COMPONENT
// ============================================================
type Phase = 'idle' | 'loading' | 'play' | 'end' | 'error' | 'archive' | 'collection';

/** 同一日曆日判定（每日夢境限制用） */
const isSameDay = (a: number, b: number): boolean => {
    const da = new Date(a), db = new Date(b);
    return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
};
/** 每個角色每天最多看到的夢境「種類」數 */
const DREAM_DAILY_TYPE_CAP = 3;

const DreamTheater: React.FC<{ char: CharacterProfile; onExit: () => void }> = ({ char, onExit }) => {
    const { apiConfig, userProfile, updateCharacter, addToast } = useOS();

    const [phase, setPhase] = useState<Phase>('idle');
    const [script, setScript] = useState<DreamScript | null>(null);
    const [revealed, setRevealed] = useState(1);   // 已浮現的碎片數（拼貼累積，純輕觸推進）
    // 僅本地測試：強制指定原型（null = 讓模型自動選）
    const [forcedArchetype, setForcedArchetype] = useState<DreamArchetype | null>(null);
    const devAvailable = isDevDebugAvailable();
    // 盲盒收藏冊（帳號級）+ 本場抽到的盲盒結果
    const [collection, setCollection] = useState<DreamCollection>(() => loadCollection());
    const [boxReveal, setBoxReveal] = useState<{ archetype: DreamArchetype; isNew: boolean; count: number } | null>(null);
    const savedRef = useRef(false);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    // 長按檢測（夢的殘頁刪除）：計時 + 已觸發標記（防止鬆手時又觸發 replay）
    const lpTimerRef = useRef<number | null>(null);
    const lpFiredRef = useRef(false);
    const clearLp = () => { if (lpTimerRef.current) { window.clearTimeout(lpTimerRef.current); lpTimerRef.current = null; } };
    // 彈窗：規則說明（？）/ 每日限制提醒 / 刪除殘頁確認
    const [showHelp, setShowHelp] = useState(false);
    const [dayPrompt, setDayPrompt] = useState<'seen' | 'limit' | null>(null);
    const [confirmDelete, setConfirmDelete] = useState<DreamLog | null>(null);

    const frags = script?.fragments || [];
    const theme = THEMES[script?.archetype || 'starry'];
    const isDeepSleep = script?.archetype === 'deepsleep';

    const dreamSim = useDreamSim();

    // ----- generate（後台進行：生成期間用戶可離開小屋，好了全局提示 + 深鏈回來）-----
    const start = useCallback(async (opts?: { override?: boolean }) => {
        if (!apiConfig?.baseUrl || !apiConfig?.apiKey || !apiConfig?.model) {
            addToast('請先在設置裡配置 API', 'error'); return;
        }
        // 每日限制：一天原則上只看一個夢；重複生成會提醒，可「少管我！」強行再看；
        // 但同一天對同一角色最多只能看到 DREAM_DAILY_TYPE_CAP 種不同類型的夢。
        // （dev 強制指定原型時跳過限制，方便本地測試。）
        if (!forcedArchetype) {
            const today = (char.dreamLogs || []).filter(l => isSameDay(l.timestamp, Date.now()));
            const distinctTypes = new Set(today.map(l => l.archetype)).size;
            if (today.length >= DREAM_DAILY_TYPE_CAP || distinctTypes >= DREAM_DAILY_TYPE_CAP) {
                setDayPrompt('limit'); return;   // 到頂了，硬攔，不給 override
            }
            if (today.length >= 1 && !opts?.override) {
                setDayPrompt('seen'); return;    // 已看過，軟提醒，可 override
            }
        }
        setDayPrompt(null);
        const cid = char.id, cname = char.name;
        savedRef.current = false; setRevealed(1); setBoxReveal(null);
        setPhase('loading');
        trackEvent('生成一场梦境');
        dreamSimStore.set({ status: 'loading', charId: cid, charName: cname });
        // 原型由應用端抽（dev 強制時優先 dev）：保證多樣、不老 roll 同一種、隱藏款按掉率出
        const chosenArchetype = forcedArchetype || rollArchetype(char.dreamLogs);
        try {
            // 注意：不在 await 後直接 setState 播放，交給下方 consume effect 統一消費
            // （這樣即使用戶已離開、組件卸載，生成照常完成、全局指示條接管）
            const s = await generateDreamScript({ char, userProfile, apiConfig, forcedArchetype: chosenArchetype });
            dreamSimStore.set({ status: 'ready', charId: cid, charName: cname, script: s });
            addToast('夢已成形', 'success');
        } catch (e) {
            console.error('dream gen failed', e);
            dreamSimStore.set({ status: 'error', charId: cid, charName: cname });
            addToast('夢沒能成形，請重試', 'error');
        }
    }, [apiConfig, char, userProfile, addToast, forcedArchetype]);

    // ----- consume：把全局生成結果落到本地播放（含深鏈回來後的首次消費）-----
    useEffect(() => {
        if (dreamSim.status === 'ready' && dreamSim.charId === char.id && dreamSim.script) {
            savedRef.current = false; setBoxReveal(null);
            setScript(dreamSim.script); setRevealed(1); setPhase('play');
            dreamSimStore.reset();
        } else if (dreamSim.status === 'error' && dreamSim.charId === char.id) {
            setPhase('error'); dreamSimStore.reset();
        } else if (dreamSim.status === 'loading' && dreamSim.charId === char.id) {
            setPhase(p => (p === 'idle' || p === 'error') ? 'loading' : p);
        }
    }, [dreamSim, char.id]);

    // ----- persist + buff on reaching the end -----
    const persist = useCallback((s: DreamScript) => {
        if (savedRef.current) return;
        savedRef.current = true;

        const log: DreamLog = {
            id: `dream-${Date.now()}`,
            archetype: s.archetype,
            title: s.title,
            afterglow: s.afterglow,
            fragmentsCount: s.fragments?.length || 0,
            timestamp: Date.now(),
            script: s,
        };

        // 情緒 buff —— 與 PersonaSim 一致，僅在該角色開啟了日程/情緒系統時寫入
        const scheduleOn = isScheduleFeatureOn(char);
        const newBuff: CharacterBuff | null = (scheduleOn && s.buff?.label) ? {
            id: `buff_${Date.now()}`,
            name: s.buff.name || `dream_${Date.now()}`,
            label: s.buff.label,
            intensity: (s.buff.intensity && [1, 2, 3].includes(s.buff.intensity) ? s.buff.intensity : 2) as 1 | 2 | 3,
            emoji: s.buff.emoji,
            color: s.buff.color || theme.accent,
            description: s.buff.description,
        } : null;
        if (newBuff) log.buff = { label: newBuff.label, emoji: newBuff.emoji, color: newBuff.color };

        let dispatchBuffs: CharacterBuff[] | null = null;
        updateCharacter(char.id, (cur) => {
            const dreamLogs = [log, ...(cur.dreamLogs || [])].slice(0, 30);
            if (newBuff && s.buff) {
                const existing = (cur.activeBuffs || []).filter(b => b.id !== newBuff.id);
                const nextBuffs = [newBuff, ...existing].slice(0, 4);
                dispatchBuffs = nextBuffs;
                return {
                    activeBuffs: nextBuffs,
                    // 角色不記得夢，但殘留一層情緒底色 —— 注入時點明「說不清來由」
                    buffInjection: s.buff.description ? `（${newBuff.emoji || ''}${newBuff.label}·一場記不清的夢留下的）${s.buff.description}` : '',
                    dreamLogs,
                };
            }
            return { dreamLogs };
        });
        if (newBuff) {
            window.dispatchEvent(new CustomEvent('emotion-updated',
                dispatchBuffs ? { detail: { charId: char.id, buffs: dispatchBuffs, buffInjection: '' } }
                              : { detail: { charId: char.id } }));
        }
    }, [char, updateCharacter, theme.accent]);

    // ----- 收束：落庫 + buff + 開盲盒 → end（雙觸發安全：savedRef 守衛，不重複抽/不覆蓋揭曉） -----
    const finishDream = useCallback(() => {
        if (!script) return;
        if (savedRef.current) { setPhase('end'); return; } // 已收束過（含 replay）→ 只去結束頁
        persist(script);                                   // 內部置 savedRef=true
        const r = unlockCollectible(script.archetype);
        setCollection(r.collection);
        setBoxReveal({ archetype: script.archetype, isNew: r.isNew, count: r.count });
        setPhase('end');
    }, [script, persist]);

    // 純輕觸推進：不再自動播放、也不自動收束——讀完由用戶點「醒來」或輕觸收束，
    // 讓人可以在最後那頁拼貼詩上停留多久都行。

    // ----- 新碎片浮現時平滑滾到底，讓最新的進入視野 -----
    useEffect(() => {
        if (phase !== 'play' || !scrollRef.current) return;
        const el = scrollRef.current;
        requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }));
    }, [revealed, phase]);

    // 輕觸：讓下一片浮現；都浮現完則收束
    const revealNextOrFinish = () => {
        if (revealed < frags.length) setRevealed(r => Math.min(frags.length, r + 1));
        else finishDream();
    };

    const restart = () => { savedRef.current = true; setRevealed(1); setPhase('play'); trackEvent('重看一遍刚做完的梦'); };

    // ----- replay a saved dream -----
    const replay = (s: DreamScript) => {
        savedRef.current = true; // 重看不再寫庫 / 不再疊 buff / 不再抽盲盒
        setBoxReveal(null);
        setScript(s); setRevealed(1); setPhase('play');
    };

    // ----- 刪除一頁「夢的殘頁」（長按觸發，走自定義確認彈窗，不用原生 confirm）-----
    const handleDeleteLog = (log: DreamLog) => {
        updateCharacter(char.id, (cur) => ({ dreamLogs: (cur.dreamLogs || []).filter(l => l.id !== log.id) }));
        setConfirmDelete(null);
        addToast('已撕掉這頁夢', 'success');
        trackEvent('撕掉一页梦的残页');
    };

    const dreamLogs = char.dreamLogs || [];
    const collectedCount = ALL_ARCHETYPES.filter(a => collection[a]).length;

    // 每日限制提醒彈窗（idle 與 end 兩處都可能觸發「再生成」，共用同一份）
    const dayPromptPopups = (<>
        {dayPrompt === 'seen' && (
            <DreamPopup title={`今天已經看過 ${char.name} 的夢了哦`} onClose={() => setDayPrompt(null)}
                actions={<>
                    <button onClick={() => setDayPrompt(null)} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-white/70 bg-white/[0.06] border border-white/[0.1]">好的</button>
                    <button onClick={() => { setDayPrompt(null); trackEvent('无视今日提醒再看一场梦'); start({ override: true }); }} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-[#15121c]" style={{ background: '#cdd6ff' }}>少管我！</button>
                </>}>
                一天看太多夢，就不靈了。<br />真要再看一場嗎？（今天最多 {DREAM_DAILY_TYPE_CAP} 種）
            </DreamPopup>
        )}
        {dayPrompt === 'limit' && (
            <DreamPopup title={`今天 ${char.name} 的夢看滿啦`} onClose={() => setDayPrompt(null)}
                actions={<button onClick={() => setDayPrompt(null)} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-[#15121c]" style={{ background: '#cdd6ff' }}>好吧，明天見</button>}>
                同一天最多只能窺見 {DREAM_DAILY_TYPE_CAP} 種不同的夢。<br />剩下的，留給明晚。🌙
            </DreamPopup>
        )}
    </>);

    // ========================================================
    //  IDLE — 入口
    // ========================================================
    if (phase === 'idle' || phase === 'error') {
        return (
            <Shell bg={THEMES.starry.bg}>
                <Ambient kind="stars" accent="#cdd6ff" />
                <TopBar onBack={onExit} right={
                    <div className="flex items-center gap-2.5">
                        <button onClick={() => { setPhase('collection'); trackEvent('打开梦境盲盒收藏册'); }} className="flex items-center gap-1 text-[11px] text-white/55 active:scale-95 transition">
                            🐾 收藏冊 <span className="tabular-nums opacity-70">{collectedCount}/{ALL_ARCHETYPES.length}</span>
                        </button>
                        <button onClick={() => { setShowHelp(true); trackEvent('打开梦境规则说明'); }} aria-label="夢境規則"
                            className="w-7 h-7 rounded-full flex items-center justify-center text-white/55 bg-white/[0.05] border border-white/[0.1] active:scale-90 transition">
                            <Question size={15} weight="bold" />
                        </button>
                    </div>
                } />
                <div className="flex-1 flex flex-col items-center justify-center px-9 text-center">
                    <div className="relative mb-7">
                        <MoonStars size={52} weight="light" style={{ color: '#cdd6ff' }} />
                        <div className="absolute inset-0 blur-2xl rounded-full" style={{ background: '#cdd6ff44' }} />
                    </div>
                    <div className="text-[10px] tracking-[0.4em] uppercase mb-3" style={{ color: '#cdd6ff' }}>Dream Theater</div>
                    <h1 className="text-[24px] font-light text-white leading-snug mb-4" style={{ fontFamily: SERIF }}>
                        偷看一場<br />{char.name} 已經忘記的夢
                    </h1>
                    <p className="text-[12px] text-white/45 leading-relaxed max-w-[270px] mb-1" style={{ fontFamily: SERIF }}>
                        ta 睡著了。<br />
                        夢不講道理，也不必當真——<br />
                        散落的畫面、矛盾的時間、不可能的人。<br />
                        看完，ta 不會記得，但你會。
                    </p>

                    {phase === 'error' && (
                        <div className="mt-5 text-[12px] text-rose-300/80">夢沒能成形…… 再試一次？</div>
                    )}

                    <button onClick={() => start()}
                        className="mt-9 w-full max-w-[280px] py-3.5 rounded-2xl text-[13px] font-semibold flex items-center justify-center gap-2 active:scale-[0.99] transition"
                        style={{ background: '#cdd6ff', color: '#15121c' }}>
                        <Eye size={16} weight="fill" /> {forcedArchetype ? `測試：${THEMES[forcedArchetype].label}` : '走進 ta 的夢'}
                    </button>
                    <p className="text-[10px] text-white/25 mt-3 max-w-[250px] leading-relaxed">
                        將讀取 ta 的設定、記憶與最近的對話，編織成一場夢。可能需要一點時間。
                    </p>

                    {/* 入口：盲盒收藏冊 / 夢的殘頁 */}
                    <div className="flex items-center gap-2.5 mt-7">
                        <button onClick={() => { setPhase('collection'); trackEvent('打开梦境盲盒收藏册'); }}
                            className="flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[11px] border border-white/[0.1] bg-white/[0.04] text-white/75 active:scale-95 transition">
                            🐾 盲盒收藏冊 <span className="tabular-nums" style={{ color: '#cdd6ff' }}>{collectedCount}/{ALL_ARCHETYPES.length}</span>
                        </button>
                        {dreamLogs.length > 0 && (
                            <button onClick={() => { setPhase('archive'); trackEvent('打开梦的残页存档'); }}
                                className="flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[11px] border border-white/[0.1] bg-white/[0.04] text-white/75 active:scale-95 transition">
                                <MoonStars size={13} /> 夢的殘頁 <span className="tabular-nums opacity-70">{dreamLogs.length}</span>
                            </button>
                        )}
                    </div>

                    {/* 僅本地測試：指定夢境（管理員調試指令，正式版不顯示） */}
                    {devAvailable && (
                        <div className="mt-8 w-full max-w-[300px] rounded-2xl border border-amber-300/20 bg-amber-300/[0.04] p-3.5">
                            <div className="flex items-center justify-between mb-2.5">
                                <span className="text-[10px] tracking-wider text-amber-200/80 font-semibold">🛠 指定夢境 · 僅本地測試</span>
                                {forcedArchetype && (
                                    <button onClick={() => setForcedArchetype(null)} className="text-[9px] text-white/40 underline active:scale-95">清除·改回自動</button>
                                )}
                            </div>
                            <div className="grid grid-cols-3 gap-1.5">
                                {ALL_ARCHETYPES.map(a => {
                                    const active = forcedArchetype === a;
                                    return (
                                        <button key={a} onClick={() => setForcedArchetype(active ? null : a)}
                                            className="py-1.5 rounded-lg text-[10.5px] border transition active:scale-95 flex items-center justify-center gap-1"
                                            style={active
                                                ? { background: THEMES[a].accent, color: '#15121c', borderColor: 'transparent', fontWeight: 700 }
                                                : { background: 'rgba(255,255,255,0.035)', borderColor: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.7)' }}>
                                            <span className="tabular-nums opacity-50 text-[8.5px]">{archetypeNo(a)}</span>{THEMES[a].label}
                                        </button>
                                    );
                                })}
                            </div>
                            <p className="text-[9px] text-white/30 mt-2.5 leading-relaxed">
                                勾一個則注入「管理員調試指令」，強制本次生成該原型（含隱藏·深眠）；不勾 = 模型自動選。
                            </p>
                        </div>
                    )}
                </div>

                {/* 規則說明（右上角 ? 按鈕） */}
                {showHelp && (
                    <DreamPopup title="🌙 夢境規則" onClose={() => setShowHelp(false)}
                        actions={<button onClick={() => setShowHelp(false)} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-[#15121c]" style={{ background: '#cdd6ff' }}>明白了</button>}>
                        <div className="text-left space-y-2">
                            <p>· 一天原則上只看 <b className="text-white/80">一個</b> {char.name} 的夢。重複生成會被提醒，你仍可選「少管我！」繼續。</p>
                            <p>· 但同一天對同一個人，最多只能看到 <b className="text-white/80">{DREAM_DAILY_TYPE_CAP} 種</b>不同類型的夢——看滿了就明天再來。</p>
                            <p>· 一共有 <b className="text-white/80">{ALL_ARCHETYPES.length}</b> 種夢，其中含 <b style={{ color: '#ffe08a' }}>1 個隱藏款 · 深眠</b>，小概率才會遇到。</p>
                            <p>· 做完一場夢會抽到對應的夢境小貓，集進收藏冊。</p>
                            <p>· ta 不會記得這些夢，但醒來會殘留一層說不清的情緒。「夢的殘頁」裡可長按刪除某一頁。</p>
                        </div>
                    </DreamPopup>
                )}

                {/* 每日限制提醒 */}
                {dayPromptPopups}
            </Shell>
        );
    }

    // ========================================================
    //  ARCHIVE — 夢的殘頁
    // ========================================================
    if (phase === 'archive') {
        return (
            <Shell bg={THEMES.starry.bg}>
                <Ambient kind="stars" accent="#cdd6ff" />
                <TopBar onBack={() => setPhase('idle')} />
                <div className="px-7 pb-3 shrink-0">
                    <h2 className="text-[18px] font-light text-white" style={{ fontFamily: SERIF }}>夢的殘頁</h2>
                    <p className="text-[11px] text-white/40 mt-1 leading-relaxed">那些你偷看到、而 ta 早已忘記的夢。<span className="text-white/30">長按一頁可撕掉。</span></p>
                </div>
                <div className="flex-1 overflow-y-auto no-scrollbar px-6 pb-10 space-y-3">
                    {dreamLogs.map(log => {
                        const lt = THEMES[log.archetype] || THEMES.starry;
                        return (
                            <button key={log.id}
                                onClick={() => { if (lpFiredRef.current) { lpFiredRef.current = false; return; } trackEvent('重看一场存档梦境'); log.script && replay(log.script); }}
                                disabled={!log.script}
                                onContextMenu={(e) => { e.preventDefault(); setConfirmDelete(log); }}
                                onTouchStart={() => { lpFiredRef.current = false; clearLp(); lpTimerRef.current = window.setTimeout(() => { lpFiredRef.current = true; setConfirmDelete(log); }, 500); }}
                                onTouchMove={clearLp}
                                onTouchEnd={clearLp}
                                className="w-full text-left rounded-2xl p-4 border border-white/[0.07] bg-white/[0.03] active:scale-[0.99] transition disabled:opacity-60"
                                style={{ boxShadow: `0 6px 30px ${lt.accent}10` }}>
                                <div className="flex items-center justify-between mb-1.5">
                                    <span className="text-[9px] px-2 py-0.5 rounded-full tracking-wider" style={{ color: lt.accent, background: `${lt.accent}1f` }}>
                                        {lt.label}
                                    </span>
                                    <span className="text-[9px] text-white/30 tabular-nums">
                                        {new Date(log.timestamp).toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                </div>
                                <div className="text-[15px] font-light text-white mb-1" style={{ fontFamily: SERIF }}>{log.title || '無題的夢'}</div>
                                {log.afterglow && <p className="text-[12px] text-white/55 leading-relaxed" style={{ fontFamily: SERIF }}>{log.afterglow}</p>}
                                {log.buff?.label && (
                                    <div className="inline-flex items-center gap-1.5 mt-2.5 px-2.5 py-1 rounded-full border text-[10px]"
                                        style={{ borderColor: `${log.buff.color || lt.accent}55`, color: 'rgba(255,255,255,0.8)', background: `${log.buff.color || lt.accent}14` }}>
                                        <span>{log.buff.emoji || '✨'}</span>{log.buff.label}
                                    </div>
                                )}
                            </button>
                        );
                    })}
                </div>

                {/* 刪除殘頁 · 自定義確認彈窗（不用瀏覽器原生 confirm）*/}
                {confirmDelete && (
                    <DreamPopup title="撕掉這頁夢？" onClose={() => setConfirmDelete(null)}
                        actions={<>
                            <button onClick={() => setConfirmDelete(null)} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-white/70 bg-white/[0.06] border border-white/[0.1]">留著</button>
                            <button onClick={() => handleDeleteLog(confirmDelete)} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-white flex items-center justify-center gap-1.5" style={{ background: '#e5566b' }}><Trash size={13} weight="bold" /> 撕掉</button>
                        </>}>
                        「{confirmDelete.title || '無題的夢'}」<br />撕掉後這頁殘夢就再也找不回來了。
                    </DreamPopup>
                )}
            </Shell>
        );
    }

    // ========================================================
    //  COLLECTION — 盲盒收藏冊（圖鑑）
    // ========================================================
    if (phase === 'collection') {
        const total = ALL_ARCHETYPES.length;
        return (
            <Shell bg={THEMES.starry.bg}>
                <Ambient kind="stars" accent="#cdd6ff" />
                <TopBar onBack={() => setPhase(boxReveal ? 'end' : 'idle')} right={
                    <span className="text-[11px] text-white/55 tabular-nums">{collectedCount}/{total}</span>
                } />
                <div className="px-7 pb-3 shrink-0">
                    <div className="text-[9px] tracking-[0.3em] uppercase" style={{ color: '#cdd6ff' }}>{DREAM_BOX_SERIES.sub} · Blind Box</div>
                    <h2 className="text-[19px] font-light text-white mt-1" style={{ fontFamily: SERIF }}>{DREAM_BOX_SERIES.title}</h2>
                    <p className="text-[11px] text-white/40 mt-1 leading-relaxed">做完一場夢，就抽到那種夢的小貓。集齊它們。</p>
                    <div className="h-[3px] rounded-full bg-white/[0.07] overflow-hidden mt-3">
                        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${(collectedCount / total) * 100}%`, background: '#cdd6ff' }} />
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-10">
                    <div className="grid grid-cols-3 gap-3">
                        {ALL_ARCHETYPES.map(a => {
                            const owned = collection[a];
                            const t = THEMES[a];
                            const isSecret = a === 'deepsleep';   // 隱藏款 · 深眠 —— 要讓人一眼看出「這格不一樣」
                            const GOLD = '#ffe08a';
                            return (
                                <div key={a} className={`relative rounded-2xl border overflow-hidden flex flex-col ${isSecret ? 'col-span-3 mx-auto' : ''}`}
                                    style={isSecret
                                        ? { width: 'calc((100% - 1.5rem) / 3)', borderColor: owned ? `${GOLD}aa` : `${GOLD}55`, background: `linear-gradient(160deg, ${GOLD}1c, rgba(120,90,160,0.10) 60%, rgba(255,255,255,0.02))`, boxShadow: `0 0 22px ${GOLD}2e, inset 0 0 18px ${GOLD}14` }
                                        : owned
                                            ? { borderColor: `${t.accent}40`, background: `linear-gradient(160deg, ${t.accent}14, rgba(255,255,255,0.02))` }
                                            : { borderColor: 'rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.02)' }}>
                                    {/* 隱藏款角標：無論解鎖與否都標出來，製造「特別款」的存在感 */}
                                    {isSecret && (
                                        <span className="absolute top-0 left-0 z-10 px-1.5 py-0.5 text-[7.5px] font-bold tracking-wider rounded-br-lg"
                                            style={{ background: GOLD, color: '#15121c' }}>✦ 隱藏款</span>
                                    )}
                                    {owned ? (
                                        <>
                                            <div className="relative aspect-square flex items-center justify-center p-1.5">
                                                <BoxCat archetype={a} size={92} />
                                                {owned.count > 1 && (
                                                    <span className="absolute top-1 right-1 text-[8.5px] px-1.5 py-0.5 rounded-full font-bold tabular-nums"
                                                        style={{ background: isSecret ? GOLD : t.accent, color: '#15121c' }}>×{owned.count}</span>
                                                )}
                                            </div>
                                            <div className="text-center pb-2 px-1">
                                                <div className="text-[10.5px] leading-tight" style={{ fontFamily: SERIF, color: isSecret ? GOLD : 'rgba(255,255,255,0.85)' }}>{t.label}</div>
                                                <div className="text-[7.5px] tracking-wider uppercase mt-0.5" style={{ color: isSecret ? `${GOLD}cc` : `${t.accent}cc` }}>{t.sub}</div>
                                            </div>
                                        </>
                                    ) : isSecret ? (
                                        // 未解鎖的隱藏款：金色問號 + 神秘提示，明顯區別於普通鎖
                                        <div className="aspect-square flex flex-col items-center justify-center gap-2"
                                            style={{ background: `radial-gradient(circle at 50% 42%, ${GOLD}1f, transparent 70%)` }}>
                                            <Sparkle size={22} weight="fill" style={{ color: GOLD }} />
                                            <span className="text-[8px] tracking-wider" style={{ color: `${GOLD}aa` }}>某種很罕見的夢</span>
                                        </div>
                                    ) : (
                                        <div className="aspect-square flex flex-col items-center justify-center gap-2 text-white/20"
                                            style={{ background: 'radial-gradient(circle at 50% 45%, rgba(255,255,255,0.04), transparent 70%)' }}>
                                            <Lock size={20} weight="light" />
                                            <span className="text-[18px] font-light tracking-[0.2em]">？</span>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                    <p className="text-[10px] text-white/25 mt-6 text-center leading-relaxed px-4">
                        🐾 {DREAM_BOX_SERIES.title}<br />未解鎖的夢境小貓，藏在還沒做過的那種夢裡。
                    </p>
                </div>
            </Shell>
        );
    }

    // ========================================================
    //  LOADING
    // ========================================================
    if (phase === 'loading') {
        return (
            <Shell bg={THEMES.starry.bg}>
                <Ambient kind="stars" accent="#cdd6ff" />
                <TopBar onBack={onExit} />
                <div className="flex-1 flex flex-col items-center justify-center gap-6 px-10 text-center">
                    <div className="relative">
                        <MoonStars size={42} weight="light" style={{ color: '#cdd6ff' }} className="animate-pulse" />
                        <div className="absolute inset-0 blur-2xl rounded-full" style={{ background: '#cdd6ff55' }} />
                    </div>
                    <div className="text-[13px] text-white/70" style={{ fontFamily: SERIF }}>ta 正在墜入夢裡…</div>
                    <div className="text-[11px] text-white/35 leading-relaxed" style={{ fontFamily: SERIF }}>
                        把記憶、對話與情緒揉成一場<br />說不清的夢，可能需要一點時間。
                    </div>
                    <button onClick={onExit} className="mt-2 px-5 py-2.5 rounded-xl text-[12px] text-white/70 bg-white/[0.06] border border-white/[0.08] active:scale-95 transition">
                        先離開 · 好了通知我
                    </button>
                    <p className="text-[10px] text-white/30 leading-relaxed">夢在後台繼續編織，<br />成形後頂部會出現提示，點一下就能回來。</p>
                </div>
            </Shell>
        );
    }

    // ========================================================
    //  END
    // ========================================================
    if (phase === 'end') {
        return (
            <Shell bg={theme.bg}>
                <Ambient kind={theme.ambient} accent={theme.accent} />
                <div className="flex-1 flex flex-col items-center justify-center px-9 text-center animate-fade-in">
                    <MoonStars size={isDeepSleep ? 28 : 26} weight="light" className="text-white/30 mb-5" />
                    <div className="text-[10px] tracking-[0.3em] uppercase text-white/35 mb-3">{isDeepSleep ? '一夜無夢' : '夢醒了'}</div>
                    <h2 className="text-[21px] font-light text-white mb-3" style={{ fontFamily: SERIF }}>{script?.title || (isDeepSleep ? '深眠' : '無題的夢')}</h2>
                    <div className="text-[10px] mb-4 px-3 py-1 rounded-full" style={{ color: theme.accent, background: `${theme.accent}1f` }}>{theme.label}</div>
                    {script?.afterglow && (
                        <p className="text-[14px] text-white/65 leading-loose max-w-[280px]" style={{ fontFamily: SERIF }}>{script.afterglow}</p>
                    )}

                    {script?.buff?.label && isScheduleFeatureOn(char) && (
                        <div className="mt-7 flex items-center gap-2 px-4 py-2 rounded-2xl border" style={{ borderColor: `${script.buff.color || theme.accent}55`, background: `${script.buff.color || theme.accent}14` }}>
                            <span className="text-base">{script.buff.emoji || '✨'}</span>
                            <div className="text-left">
                                <div className="text-[12px] font-semibold text-white">{script.buff.label}</div>
                                <div className="text-[9px] text-white/45">一層說不清來由的情緒，留在了 ta 身上</div>
                            </div>
                        </div>
                    )}

                    {/* 盲盒揭曉 —— 這場夢抽到的小貓 */}
                    {boxReveal && (
                        <div className="mt-7 flex flex-col items-center animate-pop-in">
                            <div className="relative">
                                {/* sparkle 環 */}
                                <Sparkle size={16} weight="fill" className="absolute -top-1 -left-2 animate-pulse" style={{ color: theme.accent }} />
                                <Sparkle size={12} weight="fill" className="absolute top-3 -right-3 animate-pulse" style={{ color: theme.accent, animationDelay: '300ms' }} />
                                <BoxCat archetype={boxReveal.archetype} size={128} />
                            </div>
                            <div className="mt-1 flex items-center gap-2">
                                {boxReveal.isNew
                                    ? <span className="px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider" style={{ background: theme.accent, color: '#15121c' }}>NEW ✦</span>
                                    : <span className="px-2 py-0.5 rounded-full text-[10px] text-white/60 border border-white/15">已有 · 再抽到 ×{boxReveal.count}</span>}
                                <span className="text-[12px] text-white/80" style={{ fontFamily: SERIF }}>{THEMES[boxReveal.archetype].label}喵</span>
                            </div>
                            <button onClick={() => { setPhase('collection'); trackEvent('打开梦境盲盒收藏册'); }} className="mt-2 text-[11px] text-white/45 underline active:scale-95">
                                {boxReveal.isNew ? '已收入收藏冊 · 去看看' : '查看收藏冊'}
                            </button>
                        </div>
                    )}

                    <p className="text-[10px] text-white/30 mt-6 max-w-[260px] leading-relaxed">
                        ta 醒來後不會記得這場夢，<br />但夢與小貓，都被你悄悄收下了。
                    </p>

                    <div className="flex gap-3 mt-6">
                        <button onClick={restart} className="px-5 py-2.5 rounded-xl text-[12px] text-white/70 bg-white/[0.06] border border-white/[0.08] flex items-center gap-1.5 active:scale-95 transition">
                            <ArrowClockwise size={14} /> 再看一遍
                        </button>
                        <button onClick={() => start()} className="px-5 py-2.5 rounded-xl text-[12px] font-semibold flex items-center gap-1.5 active:scale-95 transition" style={{ background: theme.accent, color: '#15121c' }}>
                            <MoonStars size={14} weight="fill" /> 再做一個夢
                        </button>
                    </div>
                    <button onClick={onExit} className="mt-4 text-[11px] text-white/30">離開</button>
                </div>
                {/* 「再做一個夢」也會觸發每日限制提醒 */}
                {dayPromptPopups}
            </Shell>
        );
    }

    // ========================================================
    //  PLAY — deep sleep (silent) special scene
    // ========================================================
    if (isDeepSleep) {
        return (
            <Shell bg={theme.bg}>
                <div className="flex-1 flex flex-col items-center justify-center px-12 text-center select-none" onClick={finishDream}>
                    <div className="w-3 h-3 rounded-full bg-white/40 animate-dot-pulse" style={{ boxShadow: '0 0 30px rgba(255,255,255,0.3)' }} />
                    <p className="text-[12px] text-white/20 mt-12 tracking-[0.3em]" style={{ fontFamily: SERIF }}>……</p>
                    <p className="absolute bottom-12 text-[10px] text-white/20">輕觸，醒來</p>
                </div>
            </Shell>
        );
    }

    // ========================================================
    //  PLAY — collage canvas（碎片累積，可滾動回看整首拼貼詩）
    // ========================================================
    return (
        <Shell bg={theme.bg}>
            <Ambient kind={theme.ambient} accent={theme.accent} />

            {/* exit（放棄，不收束） */}
            <button onClick={onExit} className="absolute top-0 left-0 m-3 w-9 h-9 rounded-full flex items-center justify-center text-white/40 bg-white/[0.04] border border-white/[0.06] active:scale-90 transition z-30"
                style={{ marginTop: 'max(0.75rem, calc(env(safe-area-inset-top, 0px) + 0.5rem))' }}>
                <X size={16} />
            </button>

            {/* 拼貼畫布：輕觸讓下一片浮現；可上下滾動回看 */}
            <div ref={scrollRef} onClick={revealNextOrFinish}
                className="flex-1 relative z-10 overflow-y-auto no-scrollbar select-none">
                <div className="min-h-full flex flex-col px-7 pt-20 pb-44">
                    {frags.slice(0, revealed).map((f, i) => (
                        <CollageItem key={i} frag={f} theme={theme} index={i} />
                    ))}
                    {revealed >= frags.length && (
                        <div className="self-center mt-14 mb-4 flex flex-col items-center gap-3 animate-fade-in">
                            <span className="text-white/25 tracking-[0.45em] text-[11px]" style={{ fontFamily: SERIF }}>夢在這裡散了</span>
                            <button onClick={(e) => { e.stopPropagation(); finishDream(); }}
                                className="px-6 py-2.5 rounded-full text-[12px] font-semibold active:scale-95 transition"
                                style={{ background: theme.accent, color: '#15121c' }}>醒來</button>
                        </div>
                    )}
                </div>
            </div>

            {/* 底部：進度 + 提示 + 醒來（純輕觸推進，無自動播放） */}
            <div className="shrink-0 z-30 px-6 pb-7 pt-2 bg-gradient-to-t from-black/40 to-transparent">
                <div className="h-[2px] rounded-full bg-white/[0.06] overflow-hidden mb-3">
                    <div className="h-full rounded-full transition-all duration-700" style={{ width: `${(revealed / Math.max(1, frags.length)) * 100}%`, background: `${theme.accent}88` }} />
                </div>
                <div className="flex items-center justify-between">
                    <button onClick={(e) => { e.stopPropagation(); finishDream(); }} className="text-[11px] text-white/45 active:scale-95">醒來</button>
                    <span className={`text-[10px] text-white/25 transition-opacity duration-1000 ${revealed > 2 ? 'opacity-0' : 'opacity-100'}`}>輕觸，讓夢一片片浮現</span>
                    <span className="text-[10px] text-white/25 tabular-nums">{Math.min(revealed, frags.length)}/{frags.length}</span>
                </div>
            </div>
        </Shell>
    );
};

export default DreamTheater;
