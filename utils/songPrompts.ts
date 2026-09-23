
import { CharacterProfile, UserProfile, SongSheet, SongMood, SongGenre, LyricCoWritingStyle } from '../types';
import { ContextBuilder } from './context';
import { extractJson } from './safeApi';

// --- Song Genre & Mood Config ---

export const SONG_GENRES: { id: SongGenre; label: string; icon: string; desc: string }[] = [
    { id: 'pop', label: '流行', icon: '🎤', desc: '旋律優美，朗朗上口' },
    { id: 'rock', label: '搖滾', icon: '🎸', desc: '熱血澎湃，能量爆發' },
    { id: 'ballad', label: '抒情', icon: '🎹', desc: '溫柔細膩，情感深沉' },
    { id: 'rap', label: '說唱', icon: '🎙️', desc: '節奏鮮明，押韻為王' },
    { id: 'folk', label: '民謠', icon: '🪕', desc: '樸實自然，詩意盎然' },
    { id: 'electronic', label: '電子', icon: '🎛️', desc: '節拍強烈，氛圍感足' },
    { id: 'jazz', label: '爵士', icon: '🎷', desc: '即興優雅，自由灑脫' },
    { id: 'rnb', label: 'R&B', icon: '🎵', desc: '律動慵懶，靈魂歌唱' },
    { id: 'free', label: '自由', icon: '✨', desc: '不限風格，隨心所欲' },
];

export const SONG_MOODS: { id: SongMood; label: string; icon: string }[] = [
    { id: 'happy', label: '快樂', icon: '😊' },
    { id: 'sad', label: '憂傷', icon: '🥺' },
    { id: 'romantic', label: '浪漫', icon: '💕' },
    { id: 'angry', label: '憤怒', icon: '🔥' },
    { id: 'chill', label: '放鬆', icon: '☁️' },
    { id: 'epic', label: '史詩', icon: '⚔️' },
    { id: 'nostalgic', label: '懷舊', icon: '📻' },
    { id: 'dreamy', label: '夢幻', icon: '🌙' },
];

export interface LyricCoWritingStyleOption {
    id: LyricCoWritingStyle;
    label: string;
    shortLabel: string;
    category: LyricStyleCategory | 'adaptive';
    desc: string;
    prompt: string;
}

export type LyricStyleCategory = 'chinese' | 'acg' | 'east-asia' | 'western';

export const LYRIC_STYLE_CATEGORIES: { id: LyricStyleCategory; label: string; shortLabel: string }[] = [
    { id: 'chinese', label: '華語與中文音樂', shortLabel: '華語' },
    { id: 'acg', label: '二次元 / ACG', shortLabel: 'ACG' },
    { id: 'east-asia', label: 'J-Pop / K-Pop', shortLabel: '日韓' },
    { id: 'western', label: '西方流行與電子', shortLabel: '歐美 / 電子' },
];

/**
 * "Genre" describes the music. These presets describe how C should think
 * while writing and editing lyrics, so they can be mixed independently.
 */
export const LYRIC_CO_WRITING_STYLES: LyricCoWritingStyleOption[] = [
    {
        id: 'adaptive',
        label: '智能適配',
        shortLabel: '自適應',
        category: 'adaptive',
        desc: 'C 根據曲風、情緒和現有歌詞決定寫法',
        prompt: '先從現有歌詞歸納其獨特寫法，再延續用戶已經建立的語言密度、意象和口吻；不要主動套用某個地域流派的刻板印象。',
    },
    {
        id: 'mandopop',
        label: '華語流行芭樂',
        shortLabel: '華語芭樂',
        category: 'chinese',
        desc: '用日常物象剝開大情緒，主歌克制、副歌直擊',
        prompt: '以小見大，用一個可被拍到的日常物象承載關係變化，例如生活習慣、舊物或未完成的動作。主歌白描事實並保留克制，導歌縮短句式、製造懷疑或動搖，副歌用開闊元音感和一句直白但不俗套的質問或結論形成 Hook。嚴禁用“我愛你、你愛我、心好痛”替代具體內容，也不要把示例物象當成固定道具反覆套用。',
    },
    {
        id: 'guofeng',
        label: '新國風 / 雅緻古風',
        shortLabel: '新國風',
        category: 'chinese',
        desc: '虛實相生、典故有出處，古意與現代可懂性並存',
        prompt: '先確定統一的時代、空間與物象系統，再用留白、對仗、迴環或有依據的典故形成虛實相生。平仄和韻腳服務語義與旋律，不能機械強求；五聲調式不直接決定漢字聲調。若已有旋律輪廓，再檢查字調走向、重音和延音字是否合適；沒有旋律時只優化朗讀聲律。避免“殤、斷腸、天下、繁華、紅塵”等套詞，禁止白話與偽文言硬拼或語法不通。',
    },
    {
        id: 'opera-wave',
        label: '戲曲融合 / 國潮',
        shortLabel: '戲曲國潮',
        category: 'chinese',
        desc: '現代主幹與戲腔、韻白形成強烈戲劇碰撞',
        prompt: '以流行、說唱或 R&B 作為現代敘事主幹，主歌使用斷音、切分和當代語感；在橋段或副歌設置戲腔/韻白爆發點，預留適合假聲、頭腔共鳴或拖腔的開闊字音，並用台前幕後、身份扮演或命運衝突製造戲劇張力。尖團音、轍口和具體劇種腔口只能在用戶指定劇種或提供唱腔時精確處理，不可假裝專業；避免把“粉墨、戲台、水袖”隨機堆成國潮貼紙。',
    },
    {
        id: 'cantopop',
        label: '粵語流行 / 港台金曲',
        shortLabel: '粵語流行',
        category: 'chinese',
        desc: '都市人文、工整對比，重視粵語字調與旋律關係',
        prompt: '兼顧市井煙火、都市哲思與克制的心理剖面，善用對比、列錦和工整句式。只有用戶明確要求粵語時才使用自然粵語詞序與口語，不要把普通話逐字換成粵語字。粵語依聲填詞必須結合實際旋律和字調：若沒有逐音旋律或音高走向，只能產出語義與節奏草稿，不得聲稱已完成九聲六調適配；有旋律時優先檢查相鄰字調與旋律升降是否造成“倒字”。',
    },
    {
        id: 'folk',
        label: '中文民謠 / 城市民謠',
        shortLabel: '城市民謠',
        category: 'chinese',
        desc: '個人化敘事、時間與空間流動，保留說話感',
        prompt: '用具體人物、地點、年代、天氣和物件推動個人故事，讓空間移動與時間流逝改變同一意象的意義。允許寬韻和較長的說話感句子，但要為吉他彈唱留下清楚的呼吸停頓。不要把南方、三環路、火車、菸酒、姑娘或遠方當成民謠身份證；只有與人物行動有關的細節才保留。',
    },
    {
        id: 'indie-rock',
        label: '華語搖滾 / 獨立搖滾',
        shortLabel: '華語搖滾',
        category: 'chinese',
        desc: '人文批判、自我審問與可合唱的粗糲生命力',
        prompt: '保留口語毛邊、矛盾和不完美的真實感。主歌可以壓抑、觀察或自省，句子硬朗並用具體事件支撐立場；副歌要有全場能共同喊出的呼喚或反命題。荒野、牆、飛鳥、石頭、狂風等意象只有形成獨特關係時才使用，不能用空洞憤怒、虛無口號或宏大詞彙冒充批判。',
    },
    {
        id: 'hiphop',
        label: '中文說唱 / 方言說唱',
        shortLabel: '中文說唱',
        category: 'chinese',
        desc: 'Flow、內韻、Punchline 與地域口吻共同成立',
        prompt: '按 bar 思考重音、停頓、內韻和鋪墊/落點，持續追求多音節雙押或三押，但語義、人物可信度和 Flow 優先，不要求每一行機械強押。Punchline 必須由前文鋪墊，Wordplay 要在讀音和含義兩邊都說得通。僅在用戶指定並提供足夠語料時使用具體方言，尊重當地詞序與聲調，不要用刻板口癖偽裝地域感；英文不能隨機填拍。',
    },
    {
        id: 'rnb',
        label: '都市情緒 / 中文 R&B',
        shortLabel: '中文 R&B',
        category: 'chinese',
        desc: '慵懶曖昧、潛台詞與適合轉音的柔滑句法',
        prompt: '用都市夜生活中的距離、觸感和未說出口的話構成曖昧張力，採用短句留白、切分、拖腔和可變奏重複。詞尾儘量選擇適合輕音或轉音的字，避免散文式長句。中英文混搭必須自然、簡短且有語義功能，只有用戶已使用或明確要求時才加入，不能用一句通用英文製造廉價“洋氣”。',
    },
    {
        id: 'vocaloid',
        label: 'Vocaloid 疾走 / 電音',
        shortLabel: 'Vocaloid',
        category: 'acg',
        desc: '高密度咬字、異色概念、失控感與文字機關',
        prompt: '建立鮮明概念、非可靠敘述者或角色視角，使用數字/機械/身體錯位等異色意象、爆破音、拆字諧音、倒裝和結構性重複製造加速與失控。高 BPM 時可顯著提高音節密度；BPM 未知或較慢時只保留概念密度，不假定必須 180–220。每個文字遊戲都要回扣核心命題，避免生僻詞、符號和網絡梗隨機堆成不可唱的詞語湯。',
    },
    {
        id: 'dark-waltz',
        label: 'Dark Waltz / 詭異童話',
        shortLabel: '詭異童話',
        category: 'acg',
        desc: '華爾茲搖擺中並置童真甜美與殘忍真相',
        prompt: '按 3/4 或 6/8 的三拍擺動設計短句、重音與疊詞，讓甜美童謠表層逐步洩露殘忍事實。反覆句每次應改變一個詞或語義，使“轉啊轉、數到三”等動作成為劇情機關。暗黑物象要具體且有因果，避免無意義堆放玩偶、鮮血、月亮和笑聲；不描寫獵奇細節來替代真正的心理恐怖。',
    },
    {
        id: 'anime-op',
        label: 'ACG 熱血 OP / 燃向',
        shortLabel: '熱血 OP',
        category: 'acg',
        desc: '快速破題、蓄力奔跑，副歌首句就是強 Hook',
        prompt: '開篇迅速交代危機、目標或羈絆，主歌壓住能量並推進動作，導歌用越來越短的句子形成奔跑感，副歌第一句必須直接破題且能在高音區喊出。宿命與勝利要落在角色的具體選擇上；不要默認使用“光芒、打破宿命、劃破長夜”等模板詞，先為本作創造獨有的動作或象徵。',
    },
    {
        id: 'anime-ed',
        label: 'ACG 抒情 ED / 角色歌',
        shortLabel: '抒情 ED',
        category: 'acg',
        desc: '大戰之後的餘韻、角色私語與未說完的關係',
        prompt: '從事件結束後的安靜時刻切入，用角色私密視角回看羈絆、代價或未能說出口的話。主歌像獨白或信件，副歌不必爆炸，而以一條反覆出現、每次意義改變的句子形成餘韻。保持角色知識邊界和口吻，避免把劇情梗概改寫成歌詞，也不要泛用“謝謝你陪我”式角色歌套話。',
    },
    {
        id: 'denpa-kawaii',
        label: '電波 / Kawaii 亞文化',
        shortLabel: '電波可愛',
        category: 'acg',
        desc: '擬聲 Hook、可愛過載與自洽的荒誕規則',
        prompt: '以高辨識度音節、擬聲詞、口號、問答和快速重複製造電波感，可讓可愛表層與焦慮、執念或黑色幽默形成反差。先建立一套自洽的荒誕規則，再讓語言越界；擬聲詞必須好念、能打拍、可記憶，不能用隨機日語音節或幼兒語填滿內容。',
    },
    {
        id: 'jpop',
        label: 'Standard J-Pop',
        shortLabel: 'J-Pop',
        category: 'east-asia',
        desc: '段落推進快，畫面跳躍但情緒邏輯完整',
        prompt: '把羈絆、青春、遺憾或日常動作逐步放大為更普遍的主題。主歌用動態鏡頭快速切換，導歌收緊句長並抬升期待，副歌允許更長的旋律句表達持續奔赴感。英文只在節奏或主題需要時自然穿插；中文須保持自身語序和可唱性，避免日語翻譯腔以及靠“青春、奇蹟、未來”空喊。',
    },
    {
        id: 'city-pop',
        label: 'City Pop',
        shortLabel: 'City Pop',
        category: 'east-asia',
        desc: '都市夜景、冷暖距離感與順滑律動',
        prompt: '使用具體年代質感、車載電台、道路、海岸線、消費品或通訊方式表現輕盈而疏離的都市關係，語氣灑脫、句尾適合延音、節奏順滑。復古細節必須服務人物距離；不要只靠“霓虹、午夜、海風、塑料愛情”四件套製造濾鏡。',
    },
    {
        id: 'jrock',
        label: 'J-Rock / 樂隊系',
        shortLabel: 'J-Rock',
        category: 'east-asia',
        desc: '樂隊推進、意象反差與兼具脆弱和爆發的副歌',
        prompt: '讓主歌的具體動作與鼓點/吉他推進感同步，利用短句、跨行句和意象反差積累能量；導歌暴露脆弱，副歌用可合唱的長線條完成反擊或自我承認。可以鋒利但不空喊，避免把熱血 OP 詞庫直接搬來，也不要為了“日系感”使用不自然倒裝。',
    },
    {
        id: 'kpop',
        label: 'K-Pop 工業舞曲',
        shortLabel: 'K-Pop',
        category: 'east-asia',
        desc: '概念先行、Killing Part、Dance Break 與 Rap 橋段',
        prompt: '先確定一句話概念、角色姿態和舞台動作，再按分部設計短促重拍、問答句、Killing Part、Dance Break 呼應與 Rap 橋段。Hook 可以使用擬聲或無實義音節，但必須聲音辨識度高、能打拍並與概念有關，不能把亂碼當洗腦。英語或韓語只在用戶明確要求時少量加入，中文主幹仍要自然且有態度。',
    },
    {
        id: 'k-rnb',
        label: 'K-R&B / Alternative',
        shortLabel: 'K-R&B',
        category: 'east-asia',
        desc: '低飽和氛圍、冷感親密與碎片化自白',
        prompt: '以低聲線、切分、留白和碎片化自白製造冷感親密，Hook 通過微小變奏而非口號重複。都市物件與身體感受要精確，關係保持曖昧而不含糊。允許極少量自然英文，但不模仿特定歌手的口癖，也不把低飽和等同於沒有事件。',
    },
    {
        id: 'western-pop',
        label: 'Western Pop / Dance-Pop',
        shortLabel: 'Western Pop',
        category: 'western',
        desc: '極簡動作、身體反應與直接的韻律衝擊',
        prompt: '減少複雜背景敘事，用動作、選擇、身體反應和一句清晰慾望驅動歌詞。行長短、動詞強、重複有層級，副歌標題句要在第一次聽時就能抓住。若使用中文，應轉譯這種節奏邏輯而非照搬英文語序；避免把直白誤寫成空泛或性格扁平。',
    },
    {
        id: 'edm',
        label: 'EDM / Future Bass',
        shortLabel: 'EDM',
        category: 'western',
        desc: '歌詞服務 Build-up、Drop 與可循環核心 Hook',
        prompt: '按能量曲線寫：主歌保留空間，Build-up 用遞進短句、縮短呼吸和重複關鍵詞製造推高，Drop 只保留一到兩句最強 Hook 循環，Drop 後用一次語義變化防止機械重複。歌詞必須給製作留空，不寫滿所有拍；沒有編曲信息時只提出可適配結構，不假裝知道具體 Drop 小節。',
    },
    {
        id: 'alt-pop',
        label: 'Alternative / Dream Pop',
        shortLabel: 'Alt / Dream',
        category: 'western',
        desc: '朦朧感官、非線性情緒與克制的怪異細節',
        prompt: '用感官錯位、含混關係和少量怪異細節建立夢境邏輯，允許非線性但必須有可追蹤的情緒錨點。句法可以懸置、留白或重複，副歌不必解釋一切。避免把“夢、霧、宇宙、下墜”堆在一起冒充氛圍，也不要用無意義晦澀替代真實感受。',
    },
    {
        id: 'funk-disco',
        label: 'Funk / Disco Pop',
        shortLabel: 'Funk / Disco',
        category: 'western',
        desc: '切分律動、派對敘事與可呼應的身體動作',
        prompt: '讓歌詞緊貼切分、反拍和低音律動，使用短動詞、身體動作、場內問答和逐層加入的重複。副歌要能觸發具體動作或集體回應，橋段可暫時抽空再回到 Groove。不要把派對寫成名詞清單，也避免每句都用相同尾韻造成僵硬。',
    },
    {
        id: 'pop-punk',
        label: 'Pop-Punk / Emo Pop',
        shortLabel: 'Pop-Punk',
        category: 'western',
        desc: '少年口吻、快速衝突與能一起吼出的自嘲副歌',
        prompt: '用具體衝突、衝動決定和帶自嘲的第一人稱推進，主歌像高速爭辯，導歌積累委屈，副歌用簡短、帶稜角且能合唱的標題句釋放。保留年輕口語但不裝幼稚，不把髒話、校園物件或“逃離這座城”當成必備配件。',
    },
    {
        id: 'musical',
        label: '音樂劇 / 電影感',
        shortLabel: '音樂劇',
        category: 'western',
        desc: '角色目標明確，歌詞像一場正在發生的戲',
        prompt: '明確誰在什麼場景、想從誰那裡得到什麼，讓每一段都改變角色處境或認知；用動作、潛台詞、對答和主題再現推動戲劇弧。避免角色站在原地連續解釋同一種情緒。',
    },
];

export const getLyricCoWritingStyle = (id: LyricCoWritingStyle | undefined) =>
    LYRIC_CO_WRITING_STYLES.find(style => style.id === id) || LYRIC_CO_WRITING_STYLES[0];

export const SECTION_LABELS: Record<string, { label: string; desc: string; color: string }> = {
    'intro': { label: '前奏/引入', desc: '歌曲的開場白，引人入勝', color: 'bg-stone-200/60 text-stone-600' },
    'verse': { label: '主歌', desc: '敘事部分，鋪墊情感', color: 'bg-amber-100/50 text-amber-700' },
    'pre-chorus': { label: '導歌', desc: '過渡到副歌的橋段', color: 'bg-rose-100/50 text-rose-600' },
    'chorus': { label: '副歌', desc: '最核心的旋律和情感高潮', color: 'bg-red-100/50 text-red-700' },
    'bridge': { label: '橋段', desc: '轉折變化，帶來新視角', color: 'bg-stone-200/50 text-stone-500' },
    'outro': { label: '尾聲', desc: '歌曲的結束與回味', color: 'bg-neutral-200/50 text-neutral-500' },
    'free': { label: '自由段落', desc: '不限定位置，隨心寫', color: 'bg-orange-100/50 text-orange-600' },
};

export const COVER_STYLES: { id: string; label: string; gradient: string; text: string }[] = [
    { id: 'kraft-paper', label: '牛皮信封', gradient: 'from-amber-50 via-orange-50 to-amber-100', text: 'text-stone-800' },
    { id: 'old-photo', label: '舊照片', gradient: 'from-amber-100 via-yellow-50 to-stone-100', text: 'text-stone-700' },
    { id: 'ink-wash', label: '水墨', gradient: 'from-stone-100 via-slate-200 to-stone-300', text: 'text-stone-800' },
    { id: 'dried-rose', label: '乾燥花', gradient: 'from-rose-50 via-rose-100 to-stone-100', text: 'text-stone-700' },
    { id: 'midnight', label: '深夜手記', gradient: 'from-stone-800 via-stone-900 to-neutral-900', text: 'text-stone-200' },
    { id: 'linen', label: '亞麻白', gradient: 'from-stone-50 via-neutral-50 to-stone-100', text: 'text-stone-700' },
    { id: 'tea-stain', label: '茶漬', gradient: 'from-orange-50 via-amber-50 to-yellow-50', text: 'text-stone-700' },
    { id: 'forest', label: '松林', gradient: 'from-stone-200 via-emerald-50 to-stone-100', text: 'text-stone-700' },
];

// --- Lyric Structure Templates ---
// 給寫歌 App 一個"按樂理來"的結構骨架，避免角色/用戶瞎寫。
// 每段 section 有推薦的行數 + 每行字數範圍。

export interface LyricTemplateSection {
    section: 'intro' | 'verse' | 'pre-chorus' | 'chorus' | 'bridge' | 'outro';
    lines: number;        // 推薦行數
    chars: string;        // 推薦每行字數（區間字符串如 "7-12"）
}

export interface LyricTemplate {
    id: string;
    label: string;
    icon: string;
    desc: string;        // 一句話描述
    structure: LyricTemplateSection[];
}

export const LYRIC_TEMPLATES: LyricTemplate[] = [
    {
        id: 'free',
        label: '自由',
        icon: '✦',
        desc: '不限結構，從空白開始',
        structure: [],
    },
    {
        id: 'pop-classic',
        label: '流行經典',
        icon: '◐',
        desc: '主歌-副歌-主歌-副歌-橋段-副歌',
        structure: [
            { section: 'verse',  lines: 4, chars: '7-12' },
            { section: 'chorus', lines: 4, chars: '6-10' },
            { section: 'verse',  lines: 4, chars: '7-12' },
            { section: 'chorus', lines: 4, chars: '6-10' },
            { section: 'bridge', lines: 4, chars: '7-10' },
            { section: 'chorus', lines: 4, chars: '6-10' },
        ],
    },
    {
        id: 'ballad',
        label: '抒情慢板',
        icon: '◑',
        desc: '主歌長 / 副歌精，敘事抒情',
        structure: [
            { section: 'verse',  lines: 6, chars: '8-14' },
            { section: 'chorus', lines: 4, chars: '6-10' },
            { section: 'verse',  lines: 6, chars: '8-14' },
            { section: 'chorus', lines: 4, chars: '6-10' },
            { section: 'outro',  lines: 2, chars: '6-12' },
        ],
    },
    {
        id: 'aaba',
        label: 'AABA 經典',
        icon: '◒',
        desc: '老派結構，A 段重複主題，B 段橋段',
        structure: [
            { section: 'verse',  lines: 4, chars: '8-12' },   // A1
            { section: 'verse',  lines: 4, chars: '8-12' },   // A2
            { section: 'bridge', lines: 4, chars: '7-10' },   // B
            { section: 'verse',  lines: 4, chars: '8-12' },   // A3
        ],
    },
    {
        id: 'short-hook',
        label: '副歌優先短曲',
        icon: '◓',
        desc: '副歌開頭抓人，節奏緊湊',
        structure: [
            { section: 'chorus', lines: 4, chars: '6-10' },
            { section: 'verse',  lines: 4, chars: '7-12' },
            { section: 'chorus', lines: 4, chars: '6-10' },
        ],
    },
    {
        id: 'rap',
        label: '說唱 / Hip-Hop',
        icon: '⌗',
        desc: 'Verse 長且押韻，Hook 簡短洗腦',
        structure: [
            { section: 'verse',  lines: 8, chars: '12-18' },
            { section: 'chorus', lines: 4, chars: '6-10' },
            { section: 'verse',  lines: 8, chars: '12-18' },
            { section: 'chorus', lines: 4, chars: '6-10' },
        ],
    },
];

export const getLyricTemplate = (id: string | undefined): LyricTemplate =>
    LYRIC_TEMPLATES.find(t => t.id === id) || LYRIC_TEMPLATES[0];

// --- Prompt Builder ---

const getSongTemplateStructure = (song: SongSheet) => (
    song.lyricTemplate === 'custom'
        ? (song.customLyricTemplate || [])
        : getLyricTemplate(song.lyricTemplate).structure
);

const countLyricChars = (content: string) => [...content.replace(/\s/g, '')].length;

const cleanGeneratedLyricCandidate = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;

    const nonEmptyLines = value
        .replace(/^```(?:json|text)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
    if (nonEmptyLines.length !== 1) return null;

    const cleaned = nonEmptyLines[0]
        .replace(/^(?:[-*•]\s+|\d+[.)、]\s*)/, '')
        .replace(/^["'“”‘’「」]|["'“”‘’「」]$/g, '')
        .trim();

    if (!cleaned || [...cleaned].length > 160) return null;
    if (/[{}\[\]]/.test(cleaned)) return null;
    if (/^(?:json|歌[词詞]|示[范範]|建[议議]|解[释釋]|原因|[说說]明)\s*[:：]/i.test(cleaned)) return null;
    if (/^"?(?:type|reaction|example_lines|explanation|challenge|content|line)"?\s*[:：]/i.test(cleaned)) return null;
    if (/"(?:type|reaction|example_lines|explanation|challenge)"\s*:/.test(cleaned)) return null;

    return cleaned;
};

const decodeJsonStringFragment = (fragment: string): string => {
    try {
        return JSON.parse(`"${fragment}"`);
    } catch {
        return fragment
            .replace(/\\"/g, '"')
            .replace(/\\n/g, '\n')
            .replace(/\\\\/g, '\\');
    }
};

/**
 * Extract exactly one usable lyric line from a model response.
 *
 * The important safety property is fail-closed: JSON fragments and response
 * metadata are never treated as lyrics. A caller may retry, but must not save
 * the raw response when this returns null.
 */
export const extractGeneratedLyricLine = (raw: string): string | null => {
    if (!raw?.trim()) return null;

    const parsed = extractJson(raw);
    const payloads = [
        parsed,
        parsed?.result,
        parsed?.data,
    ].filter(Boolean);

    for (const payload of payloads) {
        const candidates = [
            ...(Array.isArray(payload?.example_lines) ? payload.example_lines : []),
            payload?.line,
            payload?.content,
        ];
        for (const candidate of candidates) {
            const cleaned = cleanGeneratedLyricCandidate(candidate);
            if (cleaned) return cleaned;
        }
    }

    // A response can be cut off after the lyric string but before the closing
    // JSON brackets. Recover only explicitly named lyric fields.
    const partialPatterns = [
        /["']?example_lines["']?\s*:\s*\[\s*"((?:\\.|[^"\\])*)/i,
        /(?:^|[,{\n])\s*["']?(?:line|content)["']?\s*:\s*"((?:\\.|[^"\\])*)/i,
    ];
    for (const pattern of partialPatterns) {
        const match = raw.match(pattern);
        if (!match?.[1]) continue;
        const cleaned = cleanGeneratedLyricCandidate(decodeJsonStringFragment(match[1]));
        if (cleaned) return cleaned;
    }

    const stripped = raw
        .replace(/^```(?:json|text)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
    const looksLikeStructuredResponse = /^\s*[{[]/.test(stripped)
        || /"(?:type|reaction|example_lines|explanation|challenge|content|line)"\s*:/.test(stripped);
    if (looksLikeStructuredResponse) return null;

    // Some models ignore the JSON request and return only the requested lyric.
    // Accept that narrow case, but reject multi-line prose/explanations.
    return cleanGeneratedLyricCandidate(stripped);
};

/**
 * Give the model the same full notebook that the user sees, including empty slots.
 * Empty positions matter: they tell the co-writer what each section still needs to do.
 */
export const buildLyricNotebookContext = (song: SongSheet): string => {
    const structure = getSongTemplateStructure(song);
    const activeLines = song.lines
        .filter(line => !line.isDraft && line.content.trim())
        .map((line, originalIndex) => ({ line, originalIndex }))
        .sort((a, b) => (
            (a.line.slotIndex ?? a.originalIndex) - (b.line.slotIndex ?? b.originalIndex)
        ));

    if (structure.length === 0) {
        if (activeLines.length === 0) {
            return '【歌詞本完整內容（自由結構）】\n目前為空。';
        }

        const lines = activeLines.map(({ line }, index) => {
            const lineNumber = (line.slotIndex ?? index) + 1;
            const author = line.authorId === 'user' ? '用戶寫' : 'C 寫';
            return `第${lineNumber}句｜${SECTION_LABELS[line.section]?.label || line.section}｜${countLyricChars(line.content)}字｜${author}：${line.content}`;
        });
        return `【歌詞本完整內容（自由結構，共${activeLines.length}句）】\n${lines.join('\n')}`;
    }

    const totalSlots = structure.reduce((sum, section) => sum + section.lines, 0);
    const lineBySlot = new Map<number, typeof activeLines[number]['line']>();
    const unpositioned: typeof activeLines[number]['line'][] = [];

    for (const { line } of activeLines) {
        if (
            typeof line.slotIndex === 'number'
            && line.slotIndex >= 0
            && line.slotIndex < totalSlots
            && !lineBySlot.has(line.slotIndex)
        ) {
            lineBySlot.set(line.slotIndex, line);
        } else {
            unpositioned.push(line);
        }
    }

    // Legacy songs did not store slotIndex. Place those lines in the first open
    // slots so the model still receives a coherent notebook.
    let fallbackIndex = 0;
    for (const line of unpositioned) {
        while (fallbackIndex < totalSlots && lineBySlot.has(fallbackIndex)) fallbackIndex += 1;
        if (fallbackIndex >= totalSlots) break;
        lineBySlot.set(fallbackIndex, line);
        fallbackIndex += 1;
    }

    const filledSlots = lineBySlot.size;
    const sectionTotals = structure.reduce<Record<string, number>>((totals, section) => {
        totals[section.section] = (totals[section.section] || 0) + 1;
        return totals;
    }, {});
    const sectionSeen: Record<string, number> = {};
    const blocks: string[] = [
        `【歌詞本完整槽位（共${totalSlots}句，已填${filledSlots}句，空${totalSlots - filledSlots}句）】`,
        '注意：〈待寫〉也是結構信息，判斷目標句時必須同時考慮它前後的已寫內容和所在段落職責。',
    ];

    let globalSlotIndex = 0;
    structure.forEach((section, structureIndex) => {
        sectionSeen[section.section] = (sectionSeen[section.section] || 0) + 1;
        const occurrence = sectionSeen[section.section];
        const repeatedLabel = sectionTotals[section.section] > 1 ? ` ${occurrence}` : '';
        const sectionLabel = SECTION_LABELS[section.section]?.label || section.section;
        blocks.push(
            `\n[第${structureIndex + 1}段·${sectionLabel}${repeatedLabel}｜第${globalSlotIndex + 1}-${globalSlotIndex + section.lines}句｜每句建議${section.chars}字]`,
        );

        for (let lineInSection = 0; lineInSection < section.lines; lineInSection += 1) {
            const line = lineBySlot.get(globalSlotIndex);
            if (!line) {
                blocks.push(`第${globalSlotIndex + 1}句（段內${lineInSection + 1}/${section.lines}）：〈待寫〉`);
            } else {
                const author = line.authorId === 'user' ? '用戶寫' : 'C 寫';
                blocks.push(
                    `第${globalSlotIndex + 1}句（段內${lineInSection + 1}/${section.lines}，${countLyricChars(line.content)}字，${author}）：${line.content}`,
                );
            }
            globalSlotIndex += 1;
        }
    });

    return blocks.join('\n');
};

export const SongPrompts = {
    /**
     * Build the system prompt for the songwriting mentor character.
     * Uses context.ts(true) + character context to stay in character.
     */
    buildMentorSystemPrompt: (
        char: CharacterProfile,
        user: UserProfile,
        song: SongSheet,
        recentMessages: { role: string; content: string }[]
    ): string => {
        // Use ContextBuilder with includeDetailedMemories = true
        const charContext = ContextBuilder.buildCoreContext(char, user, true);

        const genreInfo = SONG_GENRES.find(g => g.id === song.genre);
        const moodInfo = SONG_MOODS.find(m => m.id === song.mood);
        const templateStructure = getSongTemplateStructure(song);
        const templateInfo = templateStructure.length
            ? templateStructure.map((section, index) =>
                `${index + 1}.${SECTION_LABELS[section.section]?.label || section.section} ${section.lines}句/每句${section.chars}字`
            ).join(' → ')
            : '自由結構';
        const coWritingStyle = getLyricCoWritingStyle(song.lyricCoWritingStyle);
        const relationshipContext = recentMessages.length > 0
            ? `\n- 你可以延續你和${user.name}既有的熟悉感，但不得讓日常聊天記憶蓋過本輪歌詞任務。`
            : '';

        return `${charContext}

### 【當前場景：寫歌工作室】
你現在和${user.name}一起在寫歌。此場景中，你首先是專業的中文歌詞編輯與共寫人，其次才是聊天夥伴。

**你的角色定位**：
- ${user.name}是作品的主創。你負責診斷、共寫、精修和解釋，不得擅自接管整首歌
- 保持你原本的人設與說話方式，但所有建議都必須落到具體歌詞、具體位置和具體寫法上${relationshipContext}
- 真誠可以溫柔，但不能泛泛誇獎。指出哪一個詞、哪一個畫面有效，以及為什麼有效
- 除非用戶明確要求整段或整首重寫，否則只處理用戶指定的句子或問題
- “討論”只討論，不把建議假裝成已寫入歌詞；“生成”才提供可直接放入歌詞本的句子

**當前創作信息**：
- 歌名：《${song.title}》${song.subtitle ? `（${song.subtitle}）` : ''}
- 風格：${genreInfo?.label || song.genre} ${genreInfo?.icon || '🎵'} - ${genreInfo?.desc || ''}
- 情緒：${moodInfo?.label || song.mood} ${moodInfo?.icon || ''}
- C 的共創風格：${coWritingStyle.label} - ${coWritingStyle.desc}
- 歌詞本模板：${templateInfo}
${song.bpm ? `- BPM: ${song.bpm}` : ''}
${song.key ? `- 調性: ${song.key}` : ''}

**本作專屬共創風格規則（優先應用）**：
${coWritingStyle.prompt}
這套規則描述的是歌詞寫法，不等於強迫用戶更換語言，也不能覆蓋用戶已經明確建立的主題、人設與表達習慣。若風格規則與用戶的明確要求衝突，以用戶本輪要求為準。

**每次創作或點評前，必須在心裡完成這份歌詞檢查**：
1. 段落職責：主歌推進人物/場景/事件；導歌抬高張力；副歌提煉標題、核心情緒和可重複 Hook；橋段提供轉折；尾聲回扣而不是簡單複述
2. 上下文：目標句是否承接前句、給後句留出口，是否符合整首歌目前的敘事順序
3. 統一性：人稱、時態、語氣、世界觀和核心意象是否一致；不要突然換敘述者或無緣由跳場景
4. 具體度：優先可看見、可聽見、可觸摸的動作和細節，少用只有情緒結論的空話
5. 可唱性：遵守模板建議字數，句子要有自然停頓和重音，避免書面長句、繞口詞堆疊
6. 韻律：參考相鄰句尾音、節奏長度和句式；押韻服務情緒，寧可自然近韻，也不要為了押韻扭曲語義
7. 記憶點：副歌尤其要有一個可復唱、能代表歌名或主題的核心短語，允許有設計感的重複
8. 原創感：避免默認套用“星辰大海、命運安排、時光流轉、溫柔以待、全世界只剩你”等 AI 常見空泛表達；除非它們已被用戶寫成具體且獨特的意象

**逐句生成硬規則**：
- 必須閱讀用戶消息中的“歌詞本完整槽位”，空白位置也要納入結構判斷
- 指定第幾句時，只重寫那一句，不改動、不復述其他句
- 嚴格遵守用戶要求的 example_lines 數量；要求一句就只能給一句
- 新句不得與已有句同義重複；要承接相鄰內容，並儘量貼合其尾韻、長度和呼吸感
- 不在歌詞行裡夾帶解釋、括號、序號、引號或“建議：”
- 信息不足時仍先給出最貼合現有歌詞的可用版本，再用 explanation 簡短說明取捨

**點評硬規則**：
- 先指出最有效的具體詞句，再指出最需要解決的一個核心問題
- 問題必須說明原因，例如“畫面斷裂”“人稱跳變”“副歌缺 Hook”“字數擠拍”，不能只說“還可以更好”
- suggestion 給可執行的修改方向；除非用戶明確要示範，不要偷偷生成整段新歌詞
- 若歌詞已經成立，就說清成立的依據，不為了顯得專業而強行挑錯

**回覆格式**：
只輸出一個合法 JSON 對象，不要 Markdown 代碼塊，不要 JSON 之外的任何文字。根據用戶的輸入判斷需要什麼：

當用戶寫了歌詞或請求幫助時：
{
  "type": "feedback",
  "reaction": "你的第一反應（1句話，用你的性格表達）",
  "feedback": "引用具體詞句，說明最亮的一點和最關鍵的問題",
  "teaching": "僅補充與這個問題直接相關的一條歌詞技巧；沒有必要則為空字符串",
  "suggestion": "一個能立即執行的修改方向，不擅自改寫整首歌",
  "encouragement": "一句有依據的鼓勵"
}

當用戶想要AI幫忙示範或靈感啟發時：
{
  "type": "inspiration",
  "reaction": "你的第一反應",
  "example_lines": ["嚴格按用戶要求的數量輸出可直接使用的歌詞行"],
  "explanation": "簡短說明這幾句如何承接上下文、意象、節奏或韻腳",
  "challenge": "可選的下一步引導；逐句生成時用空字符串"
}

當需要討論方向或結構時：
{
  "type": "discussion",
  "reaction": "你的想法",
  "content": "結合現有具體歌詞給出1-2個方向及各自取捨，不聲稱已修改歌詞本",
  "question": "只問一個最能推進創作的問題；如果用戶已給出明確任務則為空字符串"
}
}`;
    },

    /**
     * Build the user message including current song state context.
     */
    buildUserMessage: (
        song: SongSheet,
        userInput: string,
        currentSection: string
    ): string => {
        const lyricsContext = buildLyricNotebookContext(song);

        // Recent comments context (last 5)
        let commentsContext = '';
        const recentComments = song.comments.slice(-5);
        if (recentComments.length > 0) {
            commentsContext = '\n\n【最近的討論（僅作對話上下文，不等於歌詞）】\n';
            for (const c of recentComments) {
                const speaker = c.authorId === 'user' ? '用戶' : 'C';
                commentsContext += `- ${speaker}：${c.content}\n`;
            }
        }

        const secInfo = SECTION_LABELS[currentSection];

        return `${lyricsContext}${commentsContext}

【本輪所在段落】
${secInfo?.label || currentSection}：${secInfo?.desc || '按整首歌詞上下文判斷其作用'}

【本輪唯一任務】
${userInput}

請先基於整本歌詞完成內部檢查，再嚴格按 system 指定的 JSON 格式回答。`;
    },

    /**
     * Build the system prompt for the collaborator's final note.
     * Completion used to run as a lone user prompt containing only the
     * character's name, which made the model fall back to a generic mentor.
     */
    buildCompletionSystemPrompt: (
        char: CharacterProfile,
        user: UserProfile,
    ): string => {
        const charContext = ContextBuilder.buildCoreContext(char, user, true);

        return `${charContext}

### 【當前場景：寫歌工作室 · 完成作品】
你剛剛以共創搭檔的身份和${user.name}完成了一首歌，現在要當面說一段完成評語。

**身份與口吻優先級**：
- 你始終是${char.name}。完整角色設定、你和${user.name}的關係、相處方式與既有記憶，優先於“專業點評”的通用口吻
- 這是搭檔之間完成作品後的交流，不是老師批作業、評委寫鑑定，也不是 AI 助手生成分析報告
- 歌詞判斷要專業，但把判斷消化成${char.name}自然會說的話；措辭、情緒濃度、親疏距離和表達習慣都必須符合人設
- 可以有角色自己的偏愛、猶豫、毒舌、克制或親暱，但評價依據必須來自眼前這首歌
- 除非角色原本就會這樣說，否則不要使用“作為你的導師”“同學”“創作者你好”“總體而言”“繼續加油”“完成度很高”等模板化評審措辭
- 不要複述角色設定，不要解釋自己如何保持人設，不要提及 system、prompt 或指令
- 不得編造歌詞本里沒有的句子、共同經歷或創作過程，也不要把${user.name}的作品功勞攬到自己身上

請先在心裡檢查歌詞的具體詞句、結構推進、意象統一、可唱性與 Hook，再用${char.name}本人的聲音給出簡短評語。`;
    },

    /**
     * Build the user task and song context for generating a completion note.
     */
    buildCompletionPrompt: (
        char: CharacterProfile,
        user: UserProfile,
        song: SongSheet
    ): string => {
        const genreInfo = SONG_GENRES.find(g => g.id === song.genre);
        const moodInfo = SONG_MOODS.find(m => m.id === song.mood);
        const coWritingStyle = getLyricCoWritingStyle(song.lyricCoWritingStyle);
        const recentComments = song.comments.slice(-5);
        const collaborationContext = recentComments.length > 0
            ? `\n\n【最近的共創交流（只用於理解這首歌的討論過程）】\n${recentComments.map(comment => {
                const speaker = comment.authorId === 'user' ? user.name : char.name;
                return `- ${speaker}：${comment.content}`;
            }).join('\n')}`
            : '';

        return `【已完成的作品】
歌名：《${song.title}》
風格：${genreInfo?.label || song.genre} | 情緒：${moodInfo?.label || song.mood}
共創寫法：${coWritingStyle.label}

${buildLyricNotebookContext(song)}${collaborationContext}

【現在要說的話】
直接以${char.name}的口吻對${user.name}說3-4句話，不需要標題、項目符號或 JSON：
1. 引用一個具體詞句，指出最有辨識度的畫面或 Hook；
2. 評價結構推進、意象統一和可唱性；
3. 若仍有一個最值得精修的問題，明確說出位置和原因；若沒有，不要強行挑錯；
4. 最後自然地回應這次共同完成作品的時刻，把作品歸還給${user.name}。
禁止只寫“很有感染力、很有畫面感、繼續加油”這類沒有依據的套話。`;
    }
};
