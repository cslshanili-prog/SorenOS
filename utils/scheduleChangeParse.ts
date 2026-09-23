/**
 * 日程修改標籤的容錯解析 —— 純函數，零依賴（連 type import 都沒有），瀏覽器與
 * Cloudflare Worker 共用同一份。
 *
 * 為什麼要單獨立一個葉子：apply 那半邊拖著 DB / dailySchedule，worker 引不動；
 * 而 worker 側**必須**認得出這個標籤——它留在正文裡的話，會被 sanitizeIntoSegments
 * 的 stripBusinessTagsForNotification（正則含 ACTION）整塊剝掉，連 raw 都不留，
 * 客戶端永遠收不到，角色嘴上說「日程改好了」而表其實沒動。走 directive 通道才到得了。
 * 同 utils/transferFormat.ts 之於轉帳，是同一條路子。
 *
 * 兩邊各寫一份解析的話，前台認得的寫法後台不認，同一個角色在聊天裡改得動日程、
 * 在主動消息裡改不動。
 */

export interface ScheduleChangeDirective {
    startTime: string;
    activity: string;
}

export interface ExtractedScheduleChanges {
    cleanedText: string;
    directives: ScheduleChangeDirective[];
    malformedCount: number;
}

const KEYWORD_RE = /^\s*(?:ACTION\s*[:：]\s*CHANGE_SCHEDULE|change[\s_-]*(?:schedule|schedue)|modify[\s_-]*schedule|修改(?:未[来來])?日程|更改(?:未[来來])?日程|改日程)(?=\s|[:：|=→>\-（(]|\d|$)/iu;

type ParsedBody =
    | { recognized: false }
    | { recognized: true; directive: ScheduleChangeDirective | null };

const parseDirectiveBody = (input: string): ParsedBody => {
    const body = input
        .replace(/^[\s【\[]+|[\s】\]]+$/gu, '')
        .trim();
    const keyword = body.match(KEYWORD_RE);
    if (!keyword) return { recognized: false };

    const rest = body
        .slice(keyword[0].length)
        .replace(/^\s*[:：|=→>\-]+\s*/u, '');
    // canonical: 18:30；同時兜底 18：30 /（18:30）/ 18點30分 / 18時。
    const time = rest.match(/[（(]?\s*(\d{1,2})\s*(?:[:：点點时時])\s*(\d{1,2})?\s*(?:分)?\s*[）)]?/u);
    if (!time || time.index == null) return { recognized: true, directive: null };

    const hour = Number(time[1]);
    const minute = time[2] == null || time[2] === '' ? 0 : Number(time[2]);
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        return { recognized: true, directive: null };
    }

    const activity = rest
        .slice(time.index + time[0].length)
        .replace(/^\s*(?:[:：|=→>\-]+)\s*/u, '')
        .replace(/[】\]]+\s*$/gu, '')
        .trim();
    if (!activity) return { recognized: true, directive: null };

    return {
        recognized: true,
        directive: {
            startTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
            // 日程卡本來就是短標題；截斷異常長輸出，避免一條標籤撐壞 UI / prompt。
            activity: activity.slice(0, 120),
        },
    };
};

/**
 * 從回覆裡取出日程修改標籤並隱藏標籤本身。
 *
 * 正式格式跟其它動作一致：`[[ACTION:CHANGE_SCHEDULE | 18:30 | 去超市]]`。解析端額外接受：
 * - 單層 / 中文括號；
 * - `change schedule`、舊版 `change schedue`、中文「修改日程」；
 * - 全角冒號、圓括號時段、`18點30分`；
 * - 忘記閉合括號但整條指令仍獨佔一行。
 */
export const extractScheduleChangeDirectives = (text: string): ExtractedScheduleChanges => {
    const directives: ScheduleChangeDirective[] = [];
    let malformedCount = 0;

    const consumeBody = (body: string, original: string): string => {
        const parsed = parseDirectiveBody(body);
        if (!parsed.recognized) return original;
        if (parsed.directive) directives.push(parsed.directive);
        else malformedCount += 1;
        return '';
    };

    // 先吃帶括號的塊。允許左右各一層或兩層，避免少打一枚括號時留下孤立的 `[` / `]`。
    let cleanedText = (text || '').replace(
        /(?:【{1,2}|\[{1,2})([^【】\[\]\r\n]{1,360})(?:】{1,2}|\]{1,2})/gu,
        (whole, body) => consumeBody(body ?? '', whole),
    );

    // 兜底模型漏掉一側或全部括號的情況。能力標籤要求獨佔一行，所以這一層**從行首起算**、
    // 也只消費到本行末尾（`m` 讓 `^` 認每一行的行首）。
    //
    // 行首這個錨是硬要求：不錨的話「好，我改日程：22點陪你聊天」這種純敘述會從「改日程」
    // 一路被吃到行尾——既憑空造出一條 22:00 的改動，又把用戶看到的正文截成「好，我」。
    // 而這份解析跑在每一條模型輸出上，代價是全局的。跟在同一行別的內容後面的寫法就此不再
    // 識別：漏掉一條要靠猜才認得出的指令，比誤改一條日程 + 吞掉半句話便宜。規範寫法
    // （`[[ACTION:CHANGE_SCHEDULE | 18:30 | 去超市]]`）有括號兜底，走上面那一層。
    //
    // 各處空白都用 `[ \t]` 而不是 `\s`：`\s` 含換行，會讓這一層跨行吞到下一段正文裡去。
    cleanedText = cleanedText.replace(
        /^[ \t]*(?:【【?|\[\[?)?[ \t]*(?:ACTION[ \t]*[:：][ \t]*CHANGE_SCHEDULE|change[ \t_-]*(?:schedule|schedue)|modify[ \t_-]*schedule|修改(?:未[来來])?日程|更改(?:未[来來])?日程|改日程)[ \t]*[:：|]?[^\r\n]{0,360}/gimu,
        (whole) => consumeBody(whole, whole),
    );

    // 一個日程標籤都沒認出來時原樣奉還，連空白都不碰。
    //
    // 清洗那幾步（剝標籤留下的空行、去首尾空白）只有在「確實剝掉了什麼」時才說得通。
    // 沒認出東西還照樣清洗的話，每一條普通回覆都會被順手壓掉空行——而這份解析跑在
    // 所有模型輸出上。更要緊的是它得**由解析器自己保證**：客戶端和 worker 都調這裡，
    // 誰忘了在外面加一道「沒認出就別用 cleanedText」的守衛，誰那一側的正文就會悄悄
    // 少一截，同一條回覆走推送和走本地長得不一樣（這份文件頂部說的就是這件事）。
    const recognizedSomething = directives.length > 0 || malformedCount > 0;
    if (!recognizedSomething) {
        return { cleanedText: text || '', directives, malformedCount };
    }

    return {
        cleanedText: cleanedText
            .replace(/[ \t]+\r?\n/gu, '\n')
            .replace(/\n{3,}/gu, '\n\n')
            .trim(),
        directives,
        malformedCount,
    };
};
