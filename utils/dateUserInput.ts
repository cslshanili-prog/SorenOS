/**
 * 見面裡用戶那段話的「聽得到／看得到」分界（2026-10-12）。
 *
 * 用戶常這樣寫：「好。」但我其實一點也不餓，過來只是想看著他
 * 說出口的只有引號裡那句，後面是旁白和心裡話。模型看到的是一整段字，分不清界線，
 * 就會當成全都聽到了，接著回應用戶根本沒說出口的心事。
 *
 * 所以在交給模型之前，先按引號把這段話切開、逐段標好：引號裡的是說出口的，
 * 引號外的是旁白——角色只看得到外在動作，心裡的想法、動機、感受它不知道。
 * 整段沒有引號時原樣返回（很多人不加引號，整段就是台詞，跟以前的行為一樣）。
 * 只處理見面的用戶輸入；私聊打字本來就全是說出口的，不經過這裡。
 */

/** 開引號 → 對應的閉引號。英文直引號開閉同字，靠成對出現來分。 */
const QUOTE_PAIRS: Record<string, string> = {
    '「': '」',
    '『': '』',
    '“': '”',
    '"': '"',
    '＂': '＂',
};

export interface DateInputSegment {
    kind: 'spoken' | 'narration';
    text: string;
}

/** 按引號切段；沒有任何引號時回 null。沒閉合的開引號，後面全部算說出口的。 */
export function splitDateUserInput(text: string): DateInputSegment[] | null {
    const segments: DateInputSegment[] = [];
    let buffer = '';
    let closing: string | null = null;
    let sawQuote = false;

    const flush = (kind: DateInputSegment['kind']) => {
        const trimmed = buffer.trim();
        if (trimmed) segments.push({ kind, text: trimmed });
        buffer = '';
    };

    for (const ch of text) {
        if (closing === null && QUOTE_PAIRS[ch]) {
            flush('narration');
            closing = QUOTE_PAIRS[ch];
            sawQuote = true;
            buffer = ch;
            continue;
        }
        if (closing !== null && ch === closing) {
            buffer += ch;
            flush('spoken');
            closing = null;
            continue;
        }
        buffer += ch;
    }
    flush(closing !== null ? 'spoken' : 'narration');

    if (!sawQuote) return null;
    return segments;
}

/** 只取說出口的部分（固定台詞比對之類只該看用戶真的說了什麼）。沒有引號時就是整段。 */
export function spokenPartOfDateInput(text: string): string {
    const segments = splitDateUserInput(text);
    if (!segments) return text;
    return segments.filter(s => s.kind === 'spoken').map(s => s.text).join(' ');
}

/** 交給模型的版本：有引號就逐段標「說出口的／旁白」，沒有就原樣。 */
export function formatDateUserInput(text: string): string {
    const segments = splitDateUserInput(text);
    if (!segments || !segments.some(s => s.kind === 'narration')) return text;
    return segments
        .map(s => (s.kind === 'spoken' ? `【說出口的】${s.text}` : `【旁白】${s.text}`))
        .join('\n');
}

/** 寫進見面系統提示：怎麼讀上面那種標記。正面說法，不寫成一串禁止。 */
export function buildDateInputPerceptionRule(userName: string): string {
    return `### 你聽得到什麼、看得到什麼
${userName}的話裡，引號裡的是說出口的，你聽得到；引號外的是旁白——其中做出來、看得見的動作你看得到，心裡的想法、動機和感受你不知道。歷史裡標成【說出口的】【旁白】的也是這個意思。
想知道${userName}在想什麼，就像真人一樣從看得到的表情、舉動和語氣去察覺：可以猜，但猜的要像猜的；猜不到就照${userName}說出口的話回應。
${userName}的台詞、動作和決定由${userName}自己寫。你寫你自己的動作和話，可以邀請、可以留話頭，接下來${userName}怎麼回應，留給${userName}。
`;
}
