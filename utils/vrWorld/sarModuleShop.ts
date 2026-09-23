import { readSARCommerceValue } from './sarCommerceStorage';

export type SARModuleCategory = 'voice' | 'bond' | 'genre' | 'stage';

export interface SARModuleConfigurationDefinition {
    label: string;
    placeholder: string;
    promptLabel: string;
    maxLength: number;
}

export interface SARModuleDefinition {
    id: string;
    title: string;
    category: SARModuleCategory;
    effectLabel: string;
    description: string;
    /** Model-only performance rules, resolved from the current catalog even for an installed module. */
    promptRules?: string;
    caianNote: string;
    example: string;
    price: number;
    supportsUserTarget: boolean;
    configuration?: SARModuleConfigurationDefinition;
}

export interface SARModulePurchase {
    id: string;
    moduleId: string;
    purchasedAt: number;
    pricePaid: number;
}

export interface SARModuleDailyMarket {
    dayKey: string;
    offerIds: string[];
    rollsRemaining: number;
}

export interface SARModuleShopState {
    version: 1;
    credits: number;
    inventory: Record<string, number>;
    purchases: SARModulePurchase[];
    market: SARModuleDailyMarket;
}

export interface SARModulePurchaseResult {
    ok: boolean;
    state: SARModuleShopState;
    reason?: 'not-offered' | 'not-found' | 'insufficient-credits';
}

export interface SARModuleConsumeResult {
    ok: boolean;
    state: SARModuleShopState;
    reason?: 'not-found' | 'not-owned';
}

export const SAR_MODULE_SHOP_STORAGE_KEY = 'vr_sar_module_shop_v1';
export const SAR_MODULE_SHOP_DEVELOPMENT_MODE = false;
export const SAR_MODULE_DAILY_OFFER_COUNT = 5;
export const SAR_MODULE_DAILY_ROLLS = 3;

type ModuleSeed = Omit<SARModuleDefinition, 'id' | 'price'> & { id?: string; price?: number };

const moduleId = (title: string, index: number) =>
    `sar_module_${index.toString().padStart(2, '0')}_${title
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9\u4e00-\u9fff-]/g, '')}`;

const priceFor = (category: SARModuleCategory, index: number) => {
    const base: Record<SARModuleCategory, number> = { voice: 18, bond: 24, genre: 28, stage: 22 };
    return base[category] + (index % 4) * 2;
};

const seeds: ModuleSeed[] = [
    {
        title: '古風譯碼器', category: 'voice', effectLabel: '現代口語古風化',
        description: '將現代口語轉譯為自然的古風表達，並適當改變稱謂、語序和日常用詞，不強制使用生僻文言。',
        caianNote: '一鍵穿越古代！不過只是說話方式變了，不會真的突然多出一座王府。',
        example: '“這麼晚了，你怎麼還不睡？” → “夜都深了，你怎麼還不歇息？”', supportsUserTarget: true,
    },
    {
        title: '王庭貴族協議', category: 'voice', effectLabel: '中世紀貴族化',
        description: '將交流包裝成中世紀宮廷與貴族社交風格，強化禮儀、身份稱謂、騎士與領地等意象。',
        caianNote: '突然變成貴族了！請注意，本活動室暫時不提供城堡、封地和繼承權。',
        example: '“坐我旁邊吧。” → “若你願意，今日我身側的位置仍為你留著。”', supportsUserTarget: true,
    },
    {
        title: '莎翁戲劇感染', category: 'voice', effectLabel: '莎士比亞式戲劇化',
        description: '將普通交流轉換為舞台劇式的誇張抒情表達，加入獨白、感嘆、比喻和戲劇衝突感。',
        caianNote: '會讓對方像突然被拖去演舞台劇一樣講話！一句“你遲到了”都可能演成生離死別。',
        example: '“你怎麼現在才來？” → “你終於來了！可憐的時鐘早已替我數盡等待的每一刻。”', supportsUserTarget: true,
    },
    {
        title: '直球增壓器', category: 'voice', effectLabel: '表達更加直接',
        description: '刪除委婉、試探和退路，讓已有意圖直接表達。', caianNote: '讓對方說話更加直白！',
        example: '“要不有空的話……” → “留下來陪我。”', supportsUserTarget: true,
    },
    {
        title: '讚美迴路', category: 'voice', effectLabel: '批評強制變誇獎',
        description: '將抱怨、批評與負面評價重新編碼為正向稱讚。', caianNote: '批評會被改寫為一種鼓勵……雖然聽起來可能比罵人還陰陽怪氣。',
        example: '“你又在亂來。” → “你真是每次都很有創意。”', supportsUserTarget: true,
    },
    {
        title: '情話汙染模塊', category: 'voice', effectLabel: '日常語言過度浪漫化',
        description: '將普通日常表達自動包裝成誇張浪漫的說法。', caianNote: '這個名字不是我起的！它會把普通表達自動包裝得……非常不普通。你們似乎管這個叫“土味情話”？',
        example: '“記得帶傘。” → “我不允許雨碰到你。”', supportsUserTarget: true,
    },
    {
        title: '關鍵詞消音器', category: 'stage', effectLabel: '指定內容顯示為 ■■',
        description: '自動遮蔽指定詞語，可用於名字、稱呼或特定關鍵詞。', caianNote: '把你指定的關鍵詞馬賽克掉！非常容易讓聊天記錄變得非常可疑。',
        example: '“我很想你。” → “我很■■。”', supportsUserTarget: true,
        configuration: {
            label: '要消音的詞語',
            placeholder: '例如：想你',
            promptLabel: '必須替換為 ■■ 的詞語',
            maxLength: 40,
        },
    },
    {
        title: '貓科語法包', category: 'voice', effectLabel: '添加貓語習慣',
        description: '在不改變原意的情況下加入貓科語尾、停頓和語言習慣。', caianNote: '這是銷冠模塊喵！',
        example: '“別碰那個。” → “不許碰那個……喵。”', supportsUserTarget: true,
    },
    {
        title: '惡役大小姐協議', category: 'voice', effectLabel: '日式大小姐翻譯腔',
        description: '沿用角色原有語種，呈現日式乙女遊戲裡優雅、從容又傲慢的惡役大小姐口吻；中文時就是日式大小姐的中文翻譯腔。',
        promptRules: `【惡役大小姐 · 悪役令嬢／お嬢様口調】
- 演出核心：以精緻的禮貌、禮儀意識和理所當然的自信形成上位感。可以華麗地誇耀、從容地主導或禮貌地譏諷；認可對方時坦然讚賞，關心時以從容照料、提攜的口吻表達，不必否認自己的好意。
- 語種由角色自己的語言設定和既有會話要求決定，沿用待轉譯原文的語種與翻譯格式；用戶的外顯同樣保留用戶原文語種。這個模塊改變腔調，不負責切換語言。
- 中文台詞要呈現日式大小姐的中文翻譯腔：禮貌而帶鋒芒的反問、慢條斯理的評價，以及「哎呀」「您」「可真是……呢」「這不是理所當然的嗎？」「就交給我好了」等句式。日語「〜ですわ」是氣質參照，不是要輸出的固定後綴；中文裡不額外混入「ですわ」「わたくし」等日文、羅馬字 desuwa 或機械的「的說」。得意時偶爾可以「哦呵呵」，不把高笑寫成每輪必打的招呼。
- 只有角色本來使用日語時，才自然使用「わたくし」、敬體及「〜ですわ」「〜ますわ」「〜ですの？」「〜ですこと」等合乎語法的語尾；使用其他語言時表達相同的禮貌、矜持與上位感。已有雙語輸出的原文、譯文保持各自語種，中文譯文仍是自然的大小姐翻譯腔。
- 與傲嬌的邊界：本模塊不額外製造害羞口吃、先否認關心再找藉口的套路，也不把「才、才沒有」「不是為了你」「笨蛋」當標配。原意確實含有羞怯或否認時照實保留；模塊新增的是大小姐式禮貌與自信，不是隱藏愛意的動機。
- 僅改變對應外顯字段裡的措辭與語氣，不改變原有性別、真實意圖和關係；不新增貴族身世、婚約、財富、隨從或身份特權，不憑空製造敵意與威脅。表達對模塊的抱怨或試圖糾正時，也讓外顯保持大小姐腔，真實反應仍按原人格。
- 轉譯示例（只借語氣，不照抄事實）：
  「你怎麼才來？」→「哎呀，讓人等了這麼久，您倒是從容得很呢。」
  「我來幫你。」→「就交給我好了，您安心看著便是。」
  「先喝點水吧。」→「哎呀，先用些水吧，可別怠慢了自己呢。」`,
        caianNote: '這個也很有人氣！至於為什麼大家都想看自己的朋友突然變成惡役大小姐……難道是最近相關番劇很流行？',
        example: '“你怎麼才來？” → “哎呀，讓人等了這麼久，您倒是從容得很呢。”', supportsUserTarget: true,
    },
    {
        title: '宿敵語法包', category: 'bond', effectLabel: '普通關心帶上競爭意味',
        description: '將雙方關係臨時包裝成長期競爭的宿敵關係。', caianNote: '對方會默認和你存在一種莫名其妙的宿命競爭關係。',
        example: '“你吃了嗎？” → “別餓死了，我可不接受這種勝法。”', supportsUserTarget: true,
    },
    {
        title: '青梅竹馬錯覺', category: 'bond', effectLabel: '增加長期熟人感',
        description: '讓表達呈現出已經認識對方很多年的熟悉感，但不會新增共同記憶。', caianNote: '讓對方說話聽起來像你的青梅竹馬！',
        example: '“早點睡。” → “你從以前開始就這樣，一忙起來就不睡覺。”', supportsUserTarget: true,
    },
    {
        title: '初見重置器', category: 'bond', effectLabel: '熟人語氣轉生疏',
        description: '暫時將雙方交流距離拉回初次認識時的陌生與禮貌狀態。', caianNote: '讓對方變得過分禮貌吧！',
        example: '“你怎麼才回來？” → “你好……請問你剛剛去哪了？”', supportsUserTarget: true,
    },
    {
        title: '老夫老妻協議', category: 'bond', effectLabel: '增加長期同居感',
        description: '將交流包裝成共同生活多年的自然熟稔狀態。', caianNote: '這算老夫老妻模擬器嗎？',
        example: '“幫我拿水。” → “你順手把水帶過來，杯子還是老地方。”', supportsUserTarget: true,
    },
    {
        title: '秘密社團腔', category: 'genre', effectLabel: '日常交流秘密任務化',
        description: '將普通交流包裝成地下組織接頭或秘密任務。', caianNote: '普通聊天會被說得像地下組織接頭。非常適合討論一些完全不值得保密的事情！',
        example: '“晚上見。” → “老時間，老地方。別被人跟上。”', supportsUserTarget: true,
    },
    {
        title: '魔法少女變身包', category: 'genre', effectLabel: '行為魔法少女化',
        description: '為普通動作與發言自動增加誇張的變身、淨化與必殺技式演出。', caianNote: '感覺會有華麗麗的 BGM 圍繞在身邊！',
        example: '“我要去洗澡了。” → “淨化程序啟動！暫時離隊！”', supportsUserTarget: false,
    },
    {
        title: '邪神低語包', category: 'voice', effectLabel: '日常語言神秘化',
        description: '將普通表達轉換為神秘、古怪而略帶不祥感的低語風格。', caianNote: '聽起來像中二病發作了！',
        example: '“別熬夜。” → “今夜不屬於清醒的人，趁門還沒打開，睡吧。”', supportsUserTarget: true,
    },
    {
        title: '世界末日前五分鐘', category: 'genre', effectLabel: '日常表達終末化',
        description: '默認每句話都像世界將在幾分鐘後毀滅，讓日常交流帶上終局感。', caianNote: '會讓對方每句話都像世界毀滅前的最後幾句。要在這個時候告白嗎？',
        example: '“你想吃什麼？” → “趁世界還沒結束，最後選一次吧。”', supportsUserTarget: true,
    },
    {
        title: '戀愛喜劇事故包', category: 'genre', effectLabel: '普通交流曖昧誤解化',
        description: '自動將中性表達包裝成容易產生曖昧誤解的戀愛喜劇台詞。', caianNote: '會把普通對話自動解釋成很容易被誤會的東西。現代情景喜劇必備！',
        example: '“來我這裡一下。” → “現在，立刻，來我房間……等等，不是那個意思！”', supportsUserTarget: true,
    },
    {
        title: '傲嬌故障包', category: 'voice', effectLabel: '全局傲嬌化',
        description: '將已有的關心與好意包裝成嘴硬、找藉口、難為情的彆扭口吻，保留角色原本的真實意圖。',
        promptRules: `【傲嬌故障包 · 嘴硬與難為情】
- 演出核心是已有好意難以坦率說出口：先辯解、彆扭一下，再用原本要做的事或笨拙措辭露出關心。偶爾停頓、輕微口吃或羞惱即可，不讓每句話都套「才、才沒有」。沒有關心或戀愛含義的原話，不擅自補出暗戀、佔有慾或關係進展。
- 採用當前語言裡的日常口語；日語語境可以用「べ、別に……」「勘違いしないでよね」等彆扭表達，保留既有語種和翻譯格式。
- 與惡役大小姐的邊界：本模塊不額外加入貴族禮儀、上位者的從容宣言、「わたくし」「〜ですわ」大小姐語尾或高笑。角色原有的禮貌與身份可以保留，但本模塊新增的是嘴硬與羞窘，不是惡役令嬢氣場。
- 只改寫對應外顯字段；事實、行動、承諾及真實感受保持原樣。示例：「給你買了飲料。」→「只是順便多買了一瓶，你別想太多。」`,
        caianNote: '才、才沒有打算賣給你這個……！',
        example: '“給你買了飲料。” → “只是順便多買了一瓶，你別想太多。”', supportsUserTarget: true,
    },
    {
        title: '離家出走語氣包', category: 'voice', effectLabel: '抱怨災難化',
        description: '將普通抱怨表現得像即將收拾行李離家出走。', caianNote: '所有不滿都會像準備收拾行李一樣嚴重！',
        example: '“你又忘了。” → “行，我知道這個家已經沒有我的位置了。”', supportsUserTarget: true,
    },
    {
        title: '神秘轉學生包', category: 'genre', effectLabel: '增加神秘感',
        description: '將任何自我介紹和普通信息包裝成隱藏著巨大秘密的神秘人物語氣。', caianNote: '搭配教室最後一排靠窗位食用更佳！',
        example: '“我叫凱恩。” → “名字只是稱呼。你可以叫我凱恩。”', supportsUserTarget: true,
    },
    {
        title: '電波頻道', category: 'voice', effectLabel: '電波式聯想表達',
        description: '將邏輯連接方式變得跳躍、聯想式，但保持核心語義仍可理解。', caianNote: '艾文說這個沒必要，因為有些人本來就在這個頻道上。',
        example: '“我想你了。” → “今天窗外沒有鳥，所以有點想你。”', supportsUserTarget: true,
    },
    {
        title: '夢話模式', category: 'voice', effectLabel: '語言朦朧化',
        description: '將語言處理成半夢半醒時的模糊、鬆散和輕聲表達。', caianNote: '會讓對方開始迷迷糊糊說夢話……好睏。',
        example: '“你還在嗎？” → “你別消失……我還沒睡著。”', supportsUserTarget: true,
    },
    {
        title: '嘴瓢模擬器', category: 'voice', effectLabel: '模擬口誤',
        description: '隨機制造輕度用詞錯誤、詞序錯位或口誤，並允許隨後自行修正。', caianNote: '會隨機交換幾個詞，但又剛好能聽懂——危險程度取決於對方正在說什麼。',
        example: '“你今天很好看。” → “你今天很……好吃。等等。”', supportsUserTarget: true,
    },
    {
        title: '禁止說名字', category: 'stage', effectLabel: '名字自動替換為代稱',
        description: '暫時禁止直接使用指定對象的名字，必須自行尋找其他代稱。', caianNote: '對於記不住人名的人來說特別受用。',
        example: '“艾文。” → “那個白頭髮釣魚的。”', supportsUserTarget: true,
        configuration: {
            label: '禁止直接說出的名字',
            placeholder: '例如：艾文',
            promptLabel: '禁止直接說出的名字',
            maxLength: 40,
        },
    },
    {
        title: '反差強制器', category: 'voice', effectLabel: '表達風格反差化',
        description: '優先選擇與當前角色既有氣質反差最大的表達方式。', caianNote: '完、完全把對方的說話風格變了個樣的說……',
        example: '冷淡角色：“晚安。” → “晚安哦！做個超級好的夢！”', supportsUserTarget: true,
    },
    {
        title: '過場動畫綜合徵', category: 'stage', effectLabel: '行為遊戲劇情化',
        description: '將出現、離開、拿取物品等普通動作表現成遊戲過場台詞。', caianNote: '像在玩什麼劇情遊戲！',
        example: '“我出去一下。” → “那麼，這裡就暫時交給你了。”', supportsUserTarget: false,
    },
    {
        title: '最終章語氣包', category: 'genre', effectLabel: '日常對話終章化',
        description: '讓所有普通交流帶有故事即將結束的氛圍。', caianNote: '感覺也像 flag 模擬器呢。',
        example: '“明天見。” → “如果明天還能見面的話，就在那裡等我。”', supportsUserTarget: true,
    },
    {
        title: '戀愛番第十二集', category: 'genre', effectLabel: '曖昧懸停',
        description: '將普通關係推進包裝成即將告白卻永遠差一點的曖昧狀態。', caianNote: '所有氣氛都會變成“馬上要告白”，然後永遠卡在最後半句話。',
        example: '“有件事想告訴你。” → “其實我一直……算了，下次再說。”', supportsUserTarget: true,
    },
    {
        title: '輕小說標題病', category: 'stage', effectLabel: '自動生成章節名',
        description: '為當前普通場景自動生成冗長、誇張的輕小說章節標題。', caianNote: '一句話說完以後，系統會偷偷給當前場面起一個很長的標題。很長。',
        example: '“你又遲到了。” → 〔第17話：明明約好了卻再次遲到的你與已經等了二十分鐘的我〕', supportsUserTarget: false,
    },
    {
        title: 'Bad End 預告器', category: 'genre', effectLabel: '普通語言伏筆化',
        description: '隨機將普通台詞處理成像壞結局伏筆一樣的不祥表達。', caianNote: '只是演出！不會真的給你判 Bad End。',
        example: '“路上小心。” → “路上小心。今天不知道為什麼，總覺得該多說一次。”', supportsUserTarget: true,
    },
    {
        title: 'Gal 選項汙染', category: 'stage', effectLabel: '聊天出現 Gal 選項',
        description: '在普通發言後自動生成看似重要、實際未必必要的遊戲式選項。', caianNote: '說完一句話後，會自動冒出幾個根本沒必要的選項。[明白了] [什麼鬼？] [（離開）]',
        example: '“你吃飯了嗎？” → [吃了] [沒有] [為什麼突然關心我？]', supportsUserTarget: false,
    },
    {
        title: '句子補完故障', category: 'stage', effectLabel: '關鍵句中途停止',
        description: '部分發言會在關鍵位置突然中斷，把最後一點內容留給對方自行理解。', caianNote: '會在最重要的地方斷掉。誰做的這個？',
        example: '“其實我一直都……” → 〔信號中斷〕', supportsUserTarget: true,
    },
    {
        title: '舞台提示汙染', category: 'stage', effectLabel: '添加演出指令',
        description: '系統隨機給當前交流加入舞台動作、燈光或鏡頭提示。', caianNote: '會把兩個普通聊天的人強行送上舞台，好尷尬啊！',
        example: '“你回來了。” → 〔燈光亮起〕“你回來了。”', supportsUserTarget: false,
    },
    {
        title: '背景音樂幻覺', category: 'stage', effectLabel: '顯示虛構 BGM',
        description: '根據聊天氣氛自動顯示並不存在的 BGM 名稱。', caianNote: '沒有真的音樂，主要負責讓普通聊天突然像有製作組。',
        example: '“那明天見。” → ♪ BGM：還沒有結束的今天', supportsUserTarget: false,
    },
    {
        title: '片尾字幕故障', category: 'stage', effectLabel: '普通結束觸發 ED 演出',
        description: '在某些告別或結束語後錯誤觸發片尾字幕。', caianNote: '一句“晚安”就給你播片尾。我也不知道系統為什麼這麼急著下班。',
        example: '“晚安。” → 〔CAST / User · Char〕', supportsUserTarget: false,
    },
    {
        title: '回合制對話協議', category: 'stage', effectLabel: '對話遊戲回合化',
        description: '將自由聊天臨時顯示為雙方輪流行動的回合制界面。', caianNote: '理論上只是顯示方式。實際效果是連吵架都變得很文明，因為得等對面回合。',
        example: 'User 回合結束 → Char 回合開始', supportsUserTarget: false,
    },
    {
        title: '隨機事件警報', category: 'stage', effectLabel: '插入假事件彈窗',
        description: '普通聊天期間隨機彈出虛假“特殊事件發生”提示。', caianNote: '事件不一定真的特殊。比如對方喝了口水，也可能被系統判定成突發事件。',
        example: '〔突發事件：對方靠近了 12cm〕', supportsUserTarget: false,
    },
    {
        title: '今日關鍵詞', category: 'stage', effectLabel: '特定詞觸發演出',
        description: '隨機指定一個普通詞為今日特殊詞，每次出現都會觸發誇張反饋。', caianNote: '今天可能是“雨”，明天可能是“飯”。系統對什麼東西有執念完全隨機。',
        example: '“下雨了。” → 〔今日關鍵詞觸發！〕', supportsUserTarget: false,
    },
    {
        title: '只能說半句', category: 'voice', effectLabel: '發言被截斷',
        description: '每句話只允許表達前半段，剩餘部分自動消失。', caianNote: '我覺得這種模塊根本……',
        example: '“我其實挺喜歡今天這樣的。” → “我其實挺喜歡……”', supportsUserTarget: true,
    },
    {
        title: '不準解釋', category: 'voice', effectLabel: '禁止解釋和找補',
        description: '刪除“因為、其實、我的意思是”等補充解釋，只保留第一層表達。', caianNote: '會讓對方失去事後找補的機會。慎用！',
        example: '“我不是那個意思，我只是……” → “我不是那個意思。”', supportsUserTarget: true,
    },
    {
        title: '命運相遇濾鏡', category: 'bond', effectLabel: '普通出現史詩重逢化',
        description: '將雙方普通的見面、上線或重新說話包裝成命中註定的重逢。', caianNote: '命運中必然邂逅的中二病模塊！',
        example: '“你來了。” → “果然，我們還是會在這裡遇見。”', supportsUserTarget: true,
    },
    {
        title: '臨時失憶喜劇', category: 'genre', effectLabel: '小型信息臨時缺失',
        description: '隨機忘記一項極小、無關核心關係的信息，用於製造日常喜劇，不觸碰重要記憶。', caianNote: '只會忘記很小的東西！比如剛才把杯子放哪了……我剛剛說的是哪個模塊？',
        example: '“我的筆呢？” → “……我剛才是不是拿著？”', supportsUserTarget: false,
    },
    {
        title: '物品擬人協議', category: 'genre', effectLabel: '物品被擬人化',
        description: '暫時把聊天中出現的普通物品當成有性格的小角色描述。', caianNote: '杯子、門、雨傘突然都有意見……艾文說這很正常。',
        example: '“傘壞了。” → “這把傘今天決定退休了。”', supportsUserTarget: true,
    },
    {
        title: '全世界都在拆台', category: 'stage', effectLabel: '氛圍被隨機破壞',
        description: '任何稍有氣氛的時刻都會出現滑稽干擾提示。', caianNote: '被打斷真的超級急人的！',
        example: '“我其實想說……” → 〔遠處傳來東西摔碎的聲音〕', supportsUserTarget: false,
    },
    {
        title: '結局名稱生成器', category: 'stage', effectLabel: '會話獲得假結局標題',
        description: '在對話結束時，根據本次互動隨機生成一個完全非正式的“結局名”。', caianNote: '努力尋找 Happy End 吧！',
        example: 'ENDING 07：誰也沒有先說晚安', supportsUserTarget: false,
    },
];

export const SAR_MODULE_CATALOG: SARModuleDefinition[] = seeds.map((seed, index) => ({
    ...seed,
    id: seed.id || moduleId(seed.title, index + 1),
    price: seed.price ?? priceFor(seed.category, index),
}));

const catalogById = new Map(SAR_MODULE_CATALOG.map(module => [module.id, module]));

const clampInt = (value: unknown, min: number, max: number) => {
    const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : min;
    return Math.min(max, Math.max(min, number));
};

export const getSARModuleDayKey = (date = new Date()) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

const shuffledModuleIds = (random = Math.random) => {
    const ids = SAR_MODULE_CATALOG.map(module => module.id);
    for (let index = ids.length - 1; index > 0; index -= 1) {
        const target = Math.floor(random() * (index + 1));
        [ids[index], ids[target]] = [ids[target], ids[index]];
    }
    return ids.slice(0, SAR_MODULE_DAILY_OFFER_COUNT);
};

export const createSARModuleShopState = (now = new Date(), random = Math.random): SARModuleShopState => ({
    version: 1,
    credits: 0,
    inventory: {},
    purchases: [],
    market: {
        dayKey: getSARModuleDayKey(now),
        offerIds: shuffledModuleIds(random),
        rollsRemaining: SAR_MODULE_DAILY_ROLLS,
    },
});

const normalizeState = (value: unknown, now = new Date(), random = Math.random): SARModuleShopState => {
    const fallback = createSARModuleShopState(now, random);
    if (!value || typeof value !== 'object') return fallback;
    const raw = value as Partial<SARModuleShopState>;
    const inventory = Object.fromEntries(Object.entries(raw.inventory || {})
        .filter(([id, count]) => catalogById.has(id) && typeof count === 'number' && Number.isFinite(count) && count > 0)
        .map(([id, count]) => [id, clampInt(count, 1, Number.MAX_SAFE_INTEGER)]));
    const purchases = Array.isArray(raw.purchases) ? raw.purchases
        .filter((entry): entry is SARModulePurchase => Boolean(entry && catalogById.has(entry.moduleId)))
        .map(entry => ({
            id: String(entry.id || `sar_purchase_${entry.purchasedAt || Date.now()}`),
            moduleId: entry.moduleId,
            purchasedAt: clampInt(entry.purchasedAt, 0, Number.MAX_SAFE_INTEGER),
            pricePaid: clampInt(entry.pricePaid, 0, 9999),
        })) : [];
    const rawMarket = raw.market;
    const today = getSARModuleDayKey(now);
    const validOfferIds = Array.isArray(rawMarket?.offerIds)
        ? [...new Set(rawMarket.offerIds.filter(id => typeof id === 'string' && catalogById.has(id)))].slice(0, SAR_MODULE_DAILY_OFFER_COUNT)
        : [];
    const market = rawMarket?.dayKey === today && validOfferIds.length === SAR_MODULE_DAILY_OFFER_COUNT
        ? {
            dayKey: today,
            offerIds: validOfferIds,
            rollsRemaining: clampInt(rawMarket.rollsRemaining, 0, SAR_MODULE_DAILY_ROLLS),
        }
        : fallback.market;
    return {
        version: 1,
        credits: clampInt(raw.credits, 0, 999999),
        inventory,
        purchases,
        market,
    };
};

const getStorage = (): Storage | null => {
    try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
};

const persistState = (state: SARModuleShopState, storage = getStorage()) => {
    storage?.setItem(SAR_MODULE_SHOP_STORAGE_KEY, JSON.stringify(state));
    return state;
};

export const readSARModuleShopState = (
    storage: Pick<Storage, 'getItem' | 'setItem'> | null = getStorage(),
    now = new Date(),
    random = Math.random,
) => {
    const raw = storage ? readSARCommerceValue(SAR_MODULE_SHOP_STORAGE_KEY, storage) : null;
    try {
        const parsed = JSON.parse(raw || 'null');
        const state = normalizeState(parsed, now, random);
        return state;
    } catch {
        const state = createSARModuleShopState(now, random);
        return state;
    }
};

export const getSARModuleById = (id: string) => catalogById.get(id);

/** 配置只接受一個短字面值，去掉控制字符/換行，避免把自由文本變成第二份 prompt。 */
export const normalizeSARModuleConfiguration = (
    module: SARModuleDefinition,
    rawValue: string,
): { keyword: string } | undefined => {
    if (!module.configuration) return undefined;
    const flattened = rawValue
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const keyword = Array.from(flattened).slice(0, module.configuration.maxLength).join('');
    if (!keyword) return undefined;
    return { keyword };
};

export const getSARModuleOffers = (state: SARModuleShopState) =>
    state.market.offerIds.map(getSARModuleById).filter((module): module is SARModuleDefinition => Boolean(module));

export const rollSARModuleOffers = (
    state: SARModuleShopState,
    random = Math.random,
    storage: Pick<Storage, 'setItem'> | null = getStorage(),
) => {
    if (state.market.rollsRemaining <= 0) return state;
    let nextIds = shuffledModuleIds(random);
    const previous = state.market.offerIds.join('|');
    // Fixed test RNGs can otherwise return the identical rack forever; rotate once as a deterministic fallback.
    if (nextIds.join('|') === previous) nextIds = [...nextIds.slice(1), nextIds[0]];
    return persistState({
        ...state,
        market: { ...state.market, offerIds: nextIds, rollsRemaining: state.market.rollsRemaining - 1 },
    }, storage as Storage | null);
};

export const purchaseSARModule = (
    state: SARModuleShopState,
    moduleIdValue: string,
    options: { developmentMode?: boolean; now?: number; storage?: Pick<Storage, 'setItem'> | null } = {},
): SARModulePurchaseResult => {
    const module = getSARModuleById(moduleIdValue);
    if (!module) return { ok: false, state, reason: 'not-found' };
    if (!state.market.offerIds.includes(moduleIdValue)) return { ok: false, state, reason: 'not-offered' };
    const pricePaid = options.developmentMode ? 0 : module.price;
    if (state.credits < pricePaid) return { ok: false, state, reason: 'insufficient-credits' };
    const purchasedAt = options.now ?? Date.now();
    const next = {
        ...state,
        credits: state.credits - pricePaid,
        inventory: { ...state.inventory, [moduleIdValue]: (state.inventory[moduleIdValue] || 0) + 1 },
        purchases: [...state.purchases, {
            id: `sar_purchase_${purchasedAt}_${state.purchases.length}`,
            moduleId: moduleIdValue,
            purchasedAt,
            pricePaid,
        }],
    };
    persistState(next, (options.storage === undefined ? getStorage() : options.storage) as Storage | null);
    return { ok: true, state: next };
};

/** 裝載成功後才消耗庫存；確認頁退出或寫檔失敗都不會吞模塊。 */
export const consumeSARModule = (
    state: SARModuleShopState,
    moduleIdValue: string,
    storage: Pick<Storage, 'setItem'> | null = getStorage(),
): SARModuleConsumeResult => {
    if (!getSARModuleById(moduleIdValue)) return { ok: false, state, reason: 'not-found' };
    const owned = state.inventory[moduleIdValue] || 0;
    if (owned <= 0) return { ok: false, state, reason: 'not-owned' };
    const inventory = { ...state.inventory };
    if (owned === 1) delete inventory[moduleIdValue];
    else inventory[moduleIdValue] = owned - 1;
    const next = persistState({ ...state, inventory }, storage as Storage | null);
    return { ok: true, state: next };
};
