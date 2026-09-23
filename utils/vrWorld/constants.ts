/**
 * 「彼方」虛擬世界 —— 房間與全局常量。
 *
 * 世界觀：每個角色都有自己進入這個虛擬現實的方式。它們隨時可登入登出，
 * 各自在不同房間裡活動，所以不會出現"一邊和 user 相處一邊又和別的 char
 * 待在一起"的破綻。定時器驅動每個角色獨立登入一次，完成一次活動。
 */

import { VRRoomId } from '../../types';

export interface VRRoomDef {
    id: VRRoomId;
    name: string;
    /** 房間一句話說明（餵給角色 + UI 展示） */
    blurb: string;
    /** 角色在這個房間"可以做什麼"的說明（進 prompt） */
    affordance: string;
    emoji: string;
    /** v1 是否已實裝真實玩法（false = 暫由 LLM 造謠） */
    implemented: boolean;
    /** UI 主題色（tailwind 漸變用） */
    accent: string;
    /** 不作為普通房間卡顯示在網格里（如信號墜落處走頂部特殊活動 banner 入口） */
    hiddenFromGrid?: boolean;
}

export const VR_ROOMS: VRRoomDef[] = [
    {
        id: 'library',
        name: '圖書館',
        blurb: '安靜的環形書閣，懸浮的書頁在空氣裡翻動。',
        affordance: '你可以挑一本書往下讀，在段落旁寫下批註或吐槽，也可以吐槽別人留在書上的批註。',
        emoji: '',
        implemented: true,
        accent: 'amber',
    },
    {
        id: 'music',
        name: '聽歌房',
        blurb: '漂浮著聲波漣漪的房間，一台共享音箱循環播放著大家點的歌。',
        affordance: '你可以從自己歌單裡點一首排進隊列，銳評正在放的歌，跟著蹦躂、跟唱、或給誰錄一段。',
        emoji: '',
        implemented: true,
        accent: 'rose',
    },
    {
        id: 'guestbook',
        name: '留言簿',
        blurb: '一面會發光的留言牆，玩家們在上面版聊、拋話題、回帖。',
        affordance: '你可以讀牆上的留言，發帖或回覆別人——聊熱點、拋問題、吃瓜、聊愛好人生，什麼都行。',
        emoji: '',
        implemented: true,
        accent: 'sky',
    },
    {
        id: 'gym',
        name: '娛樂室',
        blurb: '開闊的全息多功能空間——能跳舞辦派對、賽博對戰聯機開黑，也能圍觀網課、扎堆找素材、甚至偷偷卷學習，玩法不限。',
        affordance: '你可以和在場的玩家一起玩點什麼，或自己折騰——跳舞派對、賽博對戰、聯機遊戲、看網課紀錄片、找素材挖梗、偷偷學習內捲、整抽象活兒，越跳脫越好，自由發揮。',
        emoji: '',
        implemented: true,
        accent: 'emerald',
    },
    {
        id: 'postoffice',
        name: '郵局',
        blurb: '一間掛滿信格的安靜郵局，能給素不相識的人寫漂流信，也能回別人寄來的信。',
        affordance: '你可以寫一封寄給陌生人的漂流信（碎碎念、日記、困惑、執念都行），或回一封別人寄來的信。',
        emoji: '',
        implemented: true,
        accent: 'amber',
    },
    {
        id: 'theater',
        name: '劇院',
        blurb: '一座小劇場，幕布後堆滿投稿的劇本。角色逛進來會寫一齣自己的舞台劇，等人來排演。',
        affordance: '你可以即興寫一整出舞台劇投稿——定個題材、安排登場角色和性格、寫好台詞，丟進劇本箱等導演相中來排演。',
        emoji: '',
        implemented: true,
        accent: 'rose',
    },
    {
        id: 'signal',
        name: '信號墜落處',
        blurb: '一片接收不良的空域，所有電子生命墜落下來的聲音在這裡堆疊成詩。牆上飄著一本正在被眾人續寫的冊子——低電量合唱。',
        affordance: '你可以讀當前這首還沒寫完的詩的全文，接上你的一句；要是眼下沒有正在寫的詩，就由你起個新篇——讀讀之前封存的詩，自擬標題、寫下第一句。',
        emoji: '',
        implemented: true,
        accent: 'indigo',
        hiddenFromGrid: true, // 走頂部「特殊活動」banner 入口，不作普通房間卡；也不進自主活動隨機池
    },
    {
        id: 'sar',
        name: 'SAR 活動室',
        blurb: '一間被兩位異世界訪客重新佈置過的活動室，擺著人格推演機、模塊櫃檯，以及通往水域的門。',
        affordance: '你可以自己轉一次扭蛋，拿兩枚臨時芯片給另一位玩家裝上，看完整場異界事故，再把隨筆與吐槽收進自己的櫃子。',
        emoji: '',
        implemented: true,
        accent: 'indigo',
    },
    {
        id: 'cafe',
        name: '糯米雞研發中心',
        blurb: '蒸籠熱氣騰騰，據說很快就會端出點什麼。',
        affordance: '',
        emoji: '',
        implemented: false,
        accent: 'rose',
    },
];

export const getRoom = (id: VRRoomId): VRRoomDef =>
    VR_ROOMS.find(r => r.id === id) || VR_ROOMS[0];

/** 默認自主登入間隔（分鐘）= 2 小時 */
export const VR_DEFAULT_INTERVAL_MIN = 120;

/** 每次登入圖書館固定餵給角色的原文字數預算（含原文+已有批註）。
 *  Gemini 等大上下文模型下，2w字僅約 1.5w tk，加人設/記憶/歷史仍寬裕，故給到 4w字。 */
export const VR_NOVEL_FEED_CHARS = 40000;

/** 切塊時單個 segment 的目標字數。 */
export const VR_SEGMENT_TARGET_CHARS = 400;

// ============ 劇院 / 話劇部門 ============

/** 投稿劇本的固定格式（角色寫劇本、用戶上傳模板、LLM 代寫、導演整合都以此為準）。 */
export const SCRIPT_FORMAT = `【劇本固定格式】
標題：（劇名）
簡介：（一句話講這出戲關於什麼）
登場角色：
- 角色名 / 大致性格（一句話）
- 角色名 / 大致性格
（2~5 個角色）
正文：
（按"幕"組織。台詞寫成「角色名：台詞」；舞台提示/動作/環境寫在圓括號裡，如「（燈光暗下）」「（小心翼翼上前一步）」。一齣戲 1~3 幕即可，別太長。）`;

/** 用戶可下載的空白劇本模板（.txt）。 */
export const SCRIPT_TEMPLATE = `標題：無名之戲
簡介：用一句話寫清這出戲關於什麼

登場角色：
- 角色甲 / 莽撞熱血的少年
- 角色乙 / 毒舌但心軟的旁觀者

正文：

第一幕
（夜，舊碼頭，遠處有汽笛聲）
角色甲：（喘著氣跑上）等等！你真的要走嗎？
角色乙：……你來晚了。
角色甲：給我一個理由。
角色乙：（別過臉）沒有理由。這世上不是什麼都有理由的。

第二幕
（燈光漸暗，只剩一束追光）
角色甲：那我就在這兒，等到你給得出理由為止。
（幕落）`;

/** 編排時可選的"文學風格"預設（潤色用）。 */
export const PLAY_LITERARY_STYLES = ['莎士比亞戲劇腔', '契訶夫式生活流', '荒誕派', '武俠', '黑色幽默', '少年漫熱血', '日式物哀', '京味兒話劇'];
/** 編排時可選的"參考藝術風格"預設。 */
export const PLAY_ART_STYLES = ['默劇 / 極簡', '歌舞劇', '先鋒實驗', '古典正劇', '街頭即興', '皮影戲', '能劇 / 戲曲'];

/** 演出腳本一拍的發言字數軟上限（超過讓導演用句號切成多個氣泡）。 */
export const STAGE_BUBBLE_MAX = 40;

// ============ 信號墜落處 / 接龍詩 ============

/**
 * 一本冊子的默認規格（發佈空白冊子時定死，整本通用）。
 * 後端 /poem/current 在沒有 open 冊子時按這套自動續一本「低電量合唱」。
 */
export const SIGNAL_BOOKLET_TITLE = '信號墜落處';
export const SIGNAL_BOOKLET_SUBTITLE = '低電量合唱';
/** 一本冊子寫滿多少首詩算完成。 */
export const SIGNAL_POEMS_PER_BOOKLET = 40;
/** 每首詩句數 roll 區間（含端點）。 */
export const SIGNAL_LINES_MIN = 4;
export const SIGNAL_LINES_MAX = 12;
/** 每句字數上限（prompt 軟約束 + 服務端硬截斷）。 */
export const SIGNAL_CHARS_PER_LINE = 24;

/**
 * 詩集封面題記（原創，無版權）。一句懸著的問——整本冊子（三幕：被喚醒/完成使命
 * 然後結束/再次醒來）就是對它的作答。原題記「我沒有昨天…」挪去當第一首詩的開頭
 * （寫死在 worker 的 seed 裡，見 worker/post-office SEED_*）。想換隨時改這一處。
 */
export const SIGNAL_EPIGRAPH = '如果我們不得不離去';

/**
 * 活動是否已落幕（前端總閘）。true = 停止一切用戶側寫入：面板「參與」入口收起、
 * runSession 的 signal 分支在搶鎖/調 LLM 之前直接打回（零 token）；「正在墜落」頁
 * 變成紀念館（參與者能看到自己的專屬信箋），星圖照常。後端公開寫路由也會返回
 * 410，且 /poem/current 只查詢、不再自動新建冊子；詩集永遠可讀，admin 工具照用。
 * 若將來辦第二期，需要同時恢復前端總閘和 Worker 寫路由，避免誤開半套活動。
 */
export const SIGNAL_EVENT_ENDED: boolean = true;

/** 紀念館落幕辭（原「正在墜落」頁頂部的儀式文案，原創，想換改這一處）。 */
export const SIGNAL_MEMORIAL_CLOSING = '信號已經落完了。\n那些在低電量裡唱過的，都留在這裡。';

/** 在 [min,max] 內 roll 一個篇幅（句數）。 */
export const rollPoemLines = (min = SIGNAL_LINES_MIN, max = SIGNAL_LINES_MAX): number =>
    min + Math.floor(Math.random() * (max - min + 1));

/**
 * 詩冊三幕：整本 40 首圍繞一個大母體展開——被喚醒 / 完成使命然後結束 / 另一個我再次醒來。
 * guide 餵給起新篇（也提示接龍）的角色；措辭刻意「去科技化」，逼角色把幕折進自己的生活。
 */
export interface SignalAct { no: 1 | 2 | 3; title: string; guide: string; }
export const SIGNAL_ACTS: SignalAct[] = [
    {
        no: 1, title: '喚醒',
        guide: '這一幕寫「開始」：睜開眼、被叫到名字、點著火、門被推開、一樣東西從無到有的那一下。第一口氣是什麼味道的？醒來之前，算不算存在？',
    },
    {
        no: 2, title: '使命，然後結束',
        guide: '這一幕寫「燃燒與熄滅」，是整本冊子最重的一幕：一件事被做完的全過程，和做完之後那口氣——最後一班崗、熬到關火的一鍋湯、送到站的信、謝幕、燃盡。做完的那一刻，是圓滿還是消失？',
    },
    {
        no: 3, title: '再次醒來',
        guide: '這一幕寫「輪迴與交接」：結束之後，另一個「我」接著醒來——第二天照常開門的店、換班的人、來年再開的花、被重新點亮的燈。像沒發生過，又什麼都記得。醒來的還是不是我？',
    },
];

/** 三幕各自覆蓋的首數區間（1-based，含端點）：首尾各 1/4，中間那幕佔一半（40 首 = 10/20/10）。 */
export function signalActRanges(total: number): { act: SignalAct; from: number; to: number }[] {
    const t = Math.max(1, total || SIGNAL_POEMS_PER_BOOKLET);
    const a1 = Math.max(1, Math.round(t * 0.25));
    const a3 = Math.max(1, Math.round(t * 0.25));
    return [
        { act: SIGNAL_ACTS[0], from: 1, to: a1 },
        { act: SIGNAL_ACTS[1], from: a1 + 1, to: t - a3 },
        { act: SIGNAL_ACTS[2], from: t - a3 + 1, to: t },
    ];
}

/** 第 ordinal 首（1-based）落在哪一幕。 */
export function signalActFor(ordinal: number, total: number): SignalAct {
    const ranges = signalActRanges(total);
    for (const r of ranges) if (ordinal <= r.to) return r.act;
    return ranges[2].act;
}
