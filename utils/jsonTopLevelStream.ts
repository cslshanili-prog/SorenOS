/**
 * 把一個很大的 JSON 物件邊讀邊拆開（plans/backup-streaming.md 第 3c 批）。
 *
 * 早期的備份是一整根 `data.json`：`{"characters":[…],"messages":[…],"theme":{…},…}`。
 * 整根讀成字串再 JSON.parse，文字多的人光字串就幾百 MB。這裡只認最外面那一層的結構：
 * - 頂層的值是陣列 → 一筆一筆把原文吐出來（onArrayItem），不等整個陣列讀完
 * - 頂層的其他值 → 讀完那一個值就把原文吐出來（onValue）
 * 每一筆的原文由呼叫端自己 JSON.parse。這裡不解析內容，只追蹤字串、跳脫、括號深度。
 *
 * 文字可以切成任意大小一段一段餵進來（push），切在字串中間、跳脫中間都沒關係。
 * 零依賴。
 */

export interface TopLevelJsonHandlers {
    /** 頂層某個鍵的值是陣列，開始了 */
    onArrayStart?(key: string): void;
    /** 那個陣列裡的一筆（原文，還沒 parse） */
    onArrayItem(key: string, itemText: string): void;
    /** 那個陣列結束了 */
    onArrayEnd?(key: string): void;
    /** 頂層某個鍵的值（不是陣列）：物件、字串、數字、true／false／null 的原文 */
    onValue(key: string, valueText: string): void;
}

export interface TopLevelJsonParser {
    push(chunk: string): void;
    /** 餵完了。沒收尾（括號沒關、字串沒關）會丟錯 */
    end(): void;
}

const enum S {
    Start,        // 等最外面的 {
    KeyOrEnd,     // 等 "鍵 或 }
    Key,          // 在鍵的字串裡
    Colon,        // 等 :
    ValueStart,   // 等值的第一個字
    Value,        // 在頂層的非陣列值裡
    ArrayItemOrEnd, // 在頂層陣列裡，等下一筆的第一個字或 ]
    ArrayItem,    // 在頂層陣列的某一筆裡
    AfterArrayItem, // 一筆結束，等 , 或 ]
    AfterValue,   // 值結束，等 , 或 }
    Done,
}

const isSpace = (code: number) => code === 0x20 || code === 0x0A || code === 0x0D || code === 0x09;
const fail = (message: string): never => { throw new SyntaxError(`JSON 格式錯誤：${message}`); };

export const createTopLevelJsonParser = (handlers: TopLevelJsonHandlers): TopLevelJsonParser => {
    let state: S = S.Start;
    let key = '';
    /** 目前這一筆（鍵、值或陣列元素）跨段累積的原文 */
    let carry = '';
    let inString = false;
    let escaped = false;
    /** 目前這一筆裡面的括號深度（0＝這一筆本身不是物件／陣列，或已經回到最外層） */
    let depth = 0;
    /** 目前這一筆是不是裸值（數字、true、false、null）：碰到 , ] } 或空白才結束 */
    let bare = false;

    const push = (chunk: string) => {
        let start = -1; // 目前這一筆在這一段裡從哪開始；-1＝這一段裡還沒有進行中的
        if (state === S.Key || state === S.Value || state === S.ArrayItem) start = 0;

        const finishText = (end: number): string => {
            const text = carry + chunk.slice(start, end);
            carry = '';
            start = -1;
            return text;
        };

        for (let i = 0; i < chunk.length; i++) {
            const code = chunk.charCodeAt(i);

            if (state === S.Key) {
                if (escaped) { escaped = false; continue; }
                if (code === 0x5C) { escaped = true; continue; }
                if (code === 0x22) {
                    // 鍵可能帶跳脫字元，交給 JSON.parse 還原
                    key = JSON.parse(finishText(i + 1));
                    state = S.Colon;
                }
                continue;
            }

            if (state === S.Value || state === S.ArrayItem) {
                if (inString) {
                    if (escaped) { escaped = false; continue; }
                    if (code === 0x5C) { escaped = true; continue; }
                    if (code === 0x22) {
                        inString = false;
                        if (depth === 0) {
                            // 這一筆本身就是一個字串，到這裡結束
                            const text = finishText(i + 1);
                            if (state === S.Value) { handlers.onValue(key, text); state = S.AfterValue; }
                            else { handlers.onArrayItem(key, text); state = S.AfterArrayItem; }
                        }
                    }
                    continue;
                }
                if (code === 0x22) { inString = true; continue; }
                if (code === 0x7B || code === 0x5B) { depth++; continue; }
                if (code === 0x7D || code === 0x5D) {
                    if (depth > 0) {
                        depth--;
                        if (depth === 0 && !bare) {
                            const text = finishText(i + 1);
                            if (state === S.Value) { handlers.onValue(key, text); state = S.AfterValue; }
                            else { handlers.onArrayItem(key, text); state = S.AfterArrayItem; }
                        }
                        continue;
                    }
                    // depth 0 碰到收尾括號：裸值到這裡結束，括號留給外層處理
                    if (!bare) fail('多了一個收尾括號');
                }
                if (bare && depth === 0 && (code === 0x2C || code === 0x7D || code === 0x5D || isSpace(code))) {
                    const text = finishText(i);
                    bare = false;
                    if (state === S.Value) { handlers.onValue(key, text); state = S.AfterValue; }
                    else { handlers.onArrayItem(key, text); state = S.AfterArrayItem; }
                    i--; // 這個字交給下一個狀態再看一次
                }
                continue;
            }

            if (isSpace(code)) continue;

            switch (state) {
                case S.Start:
                    if (code !== 0x7B) fail('最外層不是物件');
                    state = S.KeyOrEnd;
                    break;
                case S.KeyOrEnd:
                    if (code === 0x7D) { state = S.Done; break; }
                    if (code !== 0x22) fail('鍵要用雙引號');
                    state = S.Key; start = i; escaped = false;
                    break;
                case S.Colon:
                    if (code !== 0x3A) fail('鍵後面少了冒號');
                    state = S.ValueStart;
                    break;
                case S.ValueStart:
                    if (code === 0x5B) {
                        handlers.onArrayStart?.(key);
                        state = S.ArrayItemOrEnd;
                        break;
                    }
                    state = S.Value; start = i; depth = 0; inString = false; escaped = false; bare = false;
                    if (code === 0x22) inString = true;
                    else if (code === 0x7B) depth = 1;
                    else bare = true;
                    break;
                case S.ArrayItemOrEnd:
                    if (code === 0x5D) { handlers.onArrayEnd?.(key); state = S.AfterValue; break; }
                    state = S.ArrayItem; start = i; depth = 0; inString = false; escaped = false; bare = false;
                    if (code === 0x22) inString = true;
                    else if (code === 0x7B || code === 0x5B) depth = 1;
                    else bare = true;
                    break;
                case S.AfterArrayItem:
                    if (code === 0x2C) { state = S.ArrayItemOrEnd; break; }
                    if (code === 0x5D) { handlers.onArrayEnd?.(key); state = S.AfterValue; break; }
                    fail('陣列的兩筆之間少了逗號');
                    break;
                case S.AfterValue:
                    if (code === 0x2C) { state = S.KeyOrEnd; break; }
                    if (code === 0x7D) { state = S.Done; break; }
                    fail('兩個欄位之間少了逗號');
                    break;
                case S.Done:
                    fail('物件結束後還有內容');
                    break;
            }
        }

        if (start >= 0) carry += chunk.slice(start);
    };

    const end = () => {
        if (state !== S.Done) fail('內容沒有收尾（檔案可能被截斷）');
    };

    return { push, end };
};
