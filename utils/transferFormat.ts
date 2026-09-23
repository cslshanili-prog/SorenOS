/**
 * 轉帳指令的容錯解析 —— 純函數, 無 DB / 無副作用, 便於 vitest 直測。
 *
 * 為什麼需要這層:
 * 拼歷史上下文時, 角色自己發出的轉帳被渲染成第二人稱系統日誌餵給模型
 * (chatPrompts.ts buildMessageHistory: `[系統: 你向xx轉帳 1999]`)。人設裡寫了
 * "經常轉帳" 的角色, 會直接照抄這行文本, 而不是輸出規範的 `[[ACTION:TRANSFER:1999]]`
 * —— 於是用戶看到的是一條普通文字氣泡, 不是轉帳卡片。
 *
 * 這類 "掉格式" 是常態而非異常 (OBSERVE 面板 / 信號墜落處 / 群聊紅包都各自寫了兩層容錯),
 * 所以解析端認得出角色的口語版寫法, 比在 prompt 裡讓它別抄可靠。
 *
 * 三條設計約束:
 *
 *  1. **只認方括號包裹的整塊**, 自由散文一律不認。角色在正文裡敘述 "我剛給你轉了1999"
 *     是在說話, 不是在轉帳; 把敘述也當指令會憑空多出一筆。
 *
 *  2. **方向由調用方的 role 決定, 不由文本決定**。文本里的方向信息只用來*校驗*:
 *     `[系統: xx向你轉帳 1999]` 是角色在替用戶轉帳 —— 這是偽造, 整塊剝掉且不產生事件。
 *     現在方向本就不可偽造 (chatParser 落庫時 role 硬編碼 'assistant'), 這條保證
 *     容錯層不會把這個安全性削掉。任何為了 "讓模型看懂" 而加進語法的字段都只參與校驗。
 *
 *  3. **解析不了就剝掉, 保正文** —— 對齊 groupChat/redpacket.ts extractPacketCommands
 *     的既有慣例。殘留的日誌文本落進氣泡就是這次 bug 的原樣復現。
 */

// ─── 記錄形態: 歷史渲染與輸出語法的統一詞彙表 ──────────────────────────────
//
// 歷史上下文裡同一條轉帳曾有四副面孔 (私聊 `[系統: 你向xx轉帳 1999]` / 歸檔第三人稱 /
// 群摘要 `[轉帳1999]` / 輸出語法 `[[ACTION:TRANSFER:100]]`), 模型每次輸出都要做一次
// "從見過的翻譯成該寫的", 翻譯就有失敗率 —— 掉格式的根源。統一成共用詞彙表:
//
//     歷史:  [[記錄:TRANSFER|to=user|amount=1999|status=已收下]]
//     輸出:  [[ACTION:TRANSFER|to=user|amount=1999]]
//
// 字段是包含關係 (ACTION ⊂ 記錄): status 只在記錄裡有 —— 模型沒有"替用戶宣佈已收下"
// 的權限。前綴差異天然是冪等哨兵: 模型復讀歷史抄出來的是 [[記錄:...]], 解析端消費丟棄,
// 不產生新轉帳。to 固定寫 user / char 兩個詞, 不寫真名 (改名不炸; 真名在 tag 外的
// 自然語言裡本來就有)。
//
// TODO(記錄形態推廣): 轉帳這版觀察一段時間, 沒問題後把戳一戳 (interaction) / 時間間隔
// 提示等其他系統事件也遷到 [[記錄:...]] 形態 —— 冪等哨兵和 sanitize 終線已按整個
// 記錄命名空間實現, 遷移時只需要改渲染端。

export interface TransferRecordInput {
    /** 消息的 role —— 方向的唯一真理來源 (約束 2) */
    role: 'user' | 'assistant';
    amount?: string | number;
    /** 回執消息 (metadata.receipt) */
    receipt?: 'accepted' | 'returned';
    /** 原始轉帳的 live 狀態 (metadata.status) —— 收/退後歷史不再顯示"待處理" */
    status?: string;
}

/**
 * 把一條 transfer 消息渲染成歷史記錄行。chatPrompts.buildMessageHistory (私聊歷史) 與
 * messageFormat.normalizeMessageContent (歸檔 / 記憶宮殿) 共用, 保證全鏈路一副面孔。
 *
 * to 的取值: 原始轉帳 = role 的對手方 (assistant 發的錢流向 user); 回執 = 出回執一方
 * 自己 (user 出的回執說明錢當初流向 user)。status 的收/退主語恆為收款方, 無歧義。
 */
export function formatTransferRecord(input: TransferRecordInput): string {
    const { role, amount, receipt } = input;
    const to = receipt
        ? (role === 'user' ? 'user' : 'char')
        : (role === 'user' ? 'char' : 'user');
    const status = receipt
        ? (receipt === 'accepted' ? '已收下' : '已退回')
        : input.status === 'accepted' ? '已收下'
        : input.status === 'returned' ? '已退回'
        : '待處理';
    const amountPart = (amount !== undefined && amount !== null && String(amount).trim() !== '')
        ? `|amount=${amount}`
        : '';
    return `[[記錄:TRANSFER|to=${to}${amountPart}|status=${status}]]`;
}

/** 一條轉帳相關指令。方向不在這裡 —— 見約束 2。 */
export type TransferEvent =
    /** 角色向用戶轉帳。amount 是規範化後的字符串 (與 metadata.amount 的既有形態一致) */
    | { kind: 'send'; amount: string }
    /** 角色收下用戶那筆待處理轉帳 */
    | { kind: 'accept' }
    /** 角色退回用戶那筆待處理轉帳 */
    | { kind: 'return' };

/** 被剝掉的一段文本 + 它產生的事件 (null = 剝掉但不產生事件: 偽造 / 金額非法) */
interface Hit {
    start: number;
    end: number;
    event: TransferEvent | null;
}

/**
 * 寬鬆金額解析。放寬的動機: 原正則是 `(\d+)`, 角色寫 `520元` / `1,999` / `[[ACTION:TRANSFER: 520]]`
 * (多一個空格) 時匹配失敗, 標籤接著被 sanitize 當無效業務標籤清掉 —— 轉帳徹底消失,
 * 連文字都不剩, 比 "渲染成文字" 更難排查。
 *
 * 接受: 全角數字 / 千分位 / 幣種符號 / 元·塊·圓·RMB·CNY 後綴 / 兩側空白。
 * 拒絕: 非數字、0、負數、NaN、Infinity。上限不設 —— 人設引導出來的天價轉帳由用戶自己負責。
 */
export function parseTransferAmount(raw: unknown): number | null {
    if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null;
    if (typeof raw !== 'string') return null;

    // 全角數字 / 全角句點 → 半角 (０-９ 與 ． 在 Unicode 裡都是 +0xFEE0 偏移)
    let s = raw.replace(/[０-９．]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    s = s
        .replace(/[¥￥$＄]/g, '')
        .replace(/(?:元|[块塊][钱錢]|[块塊]|[圆圓]|RMB|CNY|credits?)/gi, '')
        .replace(/[,，\s]/g, '');

    if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
}

/**
 * 金額 → 落庫形態。整數去小數點 (`520.00` → `520`), 非整數保留兩位。
 * 存字符串是為了跟歷史數據對齊 —— 老實現存的是正則捕獲組, 本來就是字符串。
 */
export function formatTransferAmount(n: number): string {
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

// ─── 規範標籤 ──────────────────────────────────────────────────────────────

// 記錄哨兵: `[[記錄:TRANSFER|...]]` 是歷史渲染形態 (formatTransferRecord), 模型復讀歷史
// 會連前綴一起抄出來。消費丟棄、恆不產生事件 —— 復讀本來就不該產生新轉帳, 這個行為是對的。
const RECORD_TRANSFER_RE = /\[\[\s*[记記記][录錄錄]\s*[:：]\s*TRANSFER[^\]]*\]\]/gi;

// 新 canonical: `[[ACTION:TRANSFER|to=user|amount=520]]` —— 跟記錄行只差前綴和少一個
// status, 模型從"見過的"到"該寫的"只換一個詞。kv 順序不敏感, 裸值容錯 (`|520` 當 amount)。
// `(?:\|...)?` 不吃冒號, 所以跟老冒號形態 ACTION_SEND_RE 互不重疊; 也匹配裸
// `[[ACTION:TRANSFER]]` (無金額 → 剝掉不產生事件, 比漏進氣泡好)。
const ACTION_SEND_KV_RE = /\[\[\s*ACTION\s*[:：]\s*TRANSFER\s*((?:\|[^\]]*)?)\s*\]\]/gi;

// `[[ACTION:TRANSFER:1999]]` (老寫法, 永久兼容 —— 存量世界書 / 用戶自定義 prompt 還會寫它)。
// 冒號兩側容空白 / 全角, 金額交給 parseTransferAmount。
// 注意 payload 用 `[^\]]*?` 而不是 `\d+`: 金額非法時也要匹配上, 才能剝掉不留殘骸。
// `TRANSFER` 後必須跟冒號, 所以不會誤吃 `[[ACTION:TRANSFER_ACCEPT]]`。
const ACTION_SEND_RE = /\[\[\s*ACTION\s*[:：]\s*TRANSFER\s*[:：]\s*([^\]]*?)\s*\]\]/gi;

/**
 * `to=` 的偽造值 —— 明確指向角色自己的寫法。命中即整塊丟棄 (約束 2: 文本里的方向
 * 只做校驗, 不做授權; 方向永遠由 role 決定)。其餘取值 (user / 用戶 / 任意名字 / 缺省)
 * 一律放行: 私聊對手方唯一, 寫名字大概率就是對方, 不需要把 userName 傳進純函數。
 */
const FORGED_TO_VALUES = new Set(['char', 'self', 'me', '角色', '自己', '我', '自分', '本人']);

/** `to=user|amount=520` → { to: 'user', amount: '520' }。裸值 (無 `=`) 且像金額 → 當 amount。 */
function parseKvArgs(argStr: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of argStr.split(/[|｜]/)) {
        const seg = part.trim();
        if (!seg) continue;
        const eq = seg.search(/[=＝]/);
        if (eq < 0) {
            if (!('amount' in out) && parseTransferAmount(seg) !== null) out.amount = seg;
            continue;
        }
        const k = seg.slice(0, eq).trim().toLowerCase();
        const v = seg.slice(eq + 1).trim();
        if (k) out[k] = v;
    }
    return out;
}

/** kv 形態 → 事件。to 偽造 / 金額非法 → null (剝掉不產生事件)。 */
function kvToSendEvent(argStr: string): TransferEvent | null {
    const kv = parseKvArgs(argStr);
    const to = (kv.to ?? kv['給'] ?? '').toLowerCase();
    if (to && FORGED_TO_VALUES.has(to)) return null;
    const amount = parseTransferAmount(kv.amount ?? kv['金額']);
    return amount === null ? null : { kind: 'send', amount: formatTransferAmount(amount) };
}
const ACTION_ACCEPT_RE = /\[\[\s*ACTION\s*[:：]\s*TRANSFER_ACCEPT\s*\]\]/gi;
const ACTION_RETURN_RE = /\[\[\s*ACTION\s*[:：]\s*TRANSFER_RETURN\s*\]\]/gi;

// ─── 模仿歷史渲染的口語形態 ────────────────────────────────────────────────

/**
 * `[系統: ...]` / `[系統：...]` / `[系統提示: ...]` / `[System: ...]` / `【系統：...】` 整塊。
 * 全角括號【】一併認 (master 的 extractAssistantTransfers 覆蓋過這個變體, 合併時併入)。
 * 內層禁止再出現任何一種括號, 保證不會跨塊吞掉正文。
 */
const SYSTEM_LOG_RE = /[\[【]\s*(?:系[统統]|系統|System)\s*(?:提示)?\s*[:：]\s*([^\[\]【】]*?)\s*[\]】]/gi;

/**
 * 群活動注入到私聊背景時的壓縮形態 (chatPrompts.ts summarizeGroupMsgContent): `[轉帳1999]`。
 * 沒有方向信息 —— 私聊只有兩方, 方向由 role 決定, 見約束 2。
 */
const BARE_TRANSFER_RE = /\[\s*[转轉][账賬帳帐帳]\s*[:：]?\s*([^\[\]]{0,24}?)\s*\]/gi;

/** 金額片段: 可選幣種符號 + 數字 (含全角/千分位/小數) + 可選單位 */
const AMOUNT_FRAGMENT = String.raw`[¥￥$＄]?\s*([0-9０-９][0-9０-９.,，]*)\s*(?:元|塊錢|塊|圓)?`;

/**
 * 角色 → 用戶: `你向xx轉帳 1999` / `你給xx轉了1999` / `我向你轉帳￥520元`。
 * 主語錨定「你/我」—— 歷史日誌用第二人稱「你」稱呼角色, 而模型以第一人稱說話時會寫
 * 「我向你轉帳」, 這裡的「我」同樣是角色自己 (說話者是 assistant), 都是合法轉帳。
 * 主語是第三方名字 (`用戶向你轉帳`) 的不在此列, 落到 LOG_FORGED_RE。
 */
const LOG_SEND_RE = new RegExp(String.raw`^(?:你|我)\s*(?:向|給).*?轉(?:[帳帳]了?|了)\s*${AMOUNT_FRAGMENT}`);
/** 角色處理用戶的轉帳: `你接收了xx的轉帳 520` / `你退回了xx的轉帳 520` */
const LOG_ACCEPT_RE = /^你(?:接收|接受|收下|[领領]取)了.*?[转轉][账賬帳帐帳]/;
const LOG_RETURN_RE = /^你退回了.*?[转轉][账賬帳帐帳]/;
/**
 * 偽造: 主語是用戶 (第三方名字)。`xx向你轉帳 1999` 是角色在替用戶轉帳;
 * `xx接收了你的轉帳` 是角色在替用戶簽收。兩者都必須攔下, 不能渲染。
 *
 * 判定順序上必須排在 LOG_SEND_RE **之後**: `我向你轉帳 520` 也含「向你轉帳」,
 * 但主語「我」= 角色自己, 是合法 send —— 先按主語錨定認領, 剩下的才算偽造。
 */
const LOG_FORGED_RE = /(?:向|[给給])你[转轉][账賬帳帐帳]|(?:接收|接受|收下|[领領]取|退回)了你的[转轉][账賬帳帐帳]/;

/**
 * 是否是轉帳相關的系統日誌 (用來區分 "該消費但無事件" 和 "根本不歸我管")。
 * 第二個分支收口語版 `轉了1999` —— 沒有"帳"字, 但後面直接跟金額。
 */
const LOG_IS_TRANSFER_RE = /[转轉][账賬帳帐帳]|[转轉]了?\s*[¥￥$＄]?\s*[0-9０-９]/;

/**
 * 分類一條 `[系統: ...]` 的內層文本。
 * @returns 事件 / null (消費但不產生事件) / undefined (不歸轉帳管, 別消費)
 */
function classifySystemLog(inner: string): TransferEvent | null | undefined {
    const s = inner.trim();
    if (!LOG_IS_TRANSFER_RE.test(s)) return undefined;

    // 主語錨定 (^你 / ^我) 的形態先認領 —— `我向你轉帳` 的「我」是角色自己, 合法 send,
    // 不能被下面按「向你轉帳」子串判偽造的規則誤殺。
    if (LOG_ACCEPT_RE.test(s)) return { kind: 'accept' };
    if (LOG_RETURN_RE.test(s)) return { kind: 'return' };

    const m = s.match(LOG_SEND_RE);
    if (m) {
        const amount = parseTransferAmount(m[1]);
        return amount === null ? null : { kind: 'send', amount: formatTransferAmount(amount) };
    }

    // 主語不是你/我的剩餘形態: 偽造 (角色替用戶轉帳/簽收), 剝掉且零事件 —— 約束 2
    if (LOG_FORGED_RE.test(s)) return null;

    // 其餘轉帳相關日誌 (回執的其它措辭等): 剝掉保正文, 不產生事件
    return null;
}

/** 收集一條正則的所有命中, 跳過與已有命中重疊的部分 (先註冊的模式優先) */
function collect(
    text: string,
    re: RegExp,
    toEvent: (m: RegExpExecArray) => TransferEvent | null | undefined,
    hits: Hit[],
): void {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (hits.some(h => start < h.end && end > h.start)) continue;
        const event = toEvent(m);
        if (event === undefined) continue; // 不歸轉帳管, 留給 sanitize 終線
        hits.push({ start, end, event });
    }
}

/**
 * 從角色輸出裡摳出全部轉帳指令, 返回剝淨後的正文 + 按出現順序排列的事件。
 *
 * 一條回覆裡的多筆轉帳全部保留, 不設數量上限 —— "經常轉帳" 的人設一次回覆轉兩筆是
 * 合理行為。(順帶修掉老實現的一個靜默丟失: 它只 match 第一個標籤, 第二筆會留在正文裡
 * 被 sanitize 當無效業務標籤清掉, 既不落庫也不顯示。)
 */
export function extractTransferCommands(content: string): {
    text: string;
    events: TransferEvent[];
    /** 被剝掉的塊數 (含無事件的偽造/非法塊) —— 調用方據此判斷要不要回寫 text */
    consumed: number;
} {
    const src = String(content ?? '');
    if (!src) return { text: '', events: [], consumed: 0 };

    const hits: Hit[] = [];

    // 記錄哨兵最先註冊 —— 復讀歷史的記錄行在任何其他模式之前被消費掉 (恆零事件)
    collect(src, RECORD_TRANSFER_RE, () => null, hits);
    collect(src, ACTION_SEND_KV_RE, m => kvToSendEvent(m[1] ?? ''), hits);
    collect(src, ACTION_SEND_RE, m => {
        const amount = parseTransferAmount(m[1]);
        return amount === null ? null : { kind: 'send', amount: formatTransferAmount(amount) };
    }, hits);
    collect(src, ACTION_ACCEPT_RE, () => ({ kind: 'accept' }), hits);
    collect(src, ACTION_RETURN_RE, () => ({ kind: 'return' }), hits);
    collect(src, SYSTEM_LOG_RE, m => classifySystemLog(m[1] ?? ''), hits);
    collect(src, BARE_TRANSFER_RE, m => {
        const amount = parseTransferAmount(m[1]);
        return amount === null ? null : { kind: 'send', amount: formatTransferAmount(amount) };
    }, hits);

    hits.sort((a, b) => a.start - b.start);

    let text = '';
    let cursor = 0;
    for (const h of hits) {
        text += src.slice(cursor, h.start);
        cursor = h.end;
    }
    text += src.slice(cursor);

    return {
        text: text.trim(),
        events: hits.map(h => h.event).filter((e): e is TransferEvent => e !== null),
        consumed: hits.length,
    };
}
