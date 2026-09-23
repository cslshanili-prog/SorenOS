/**
 * 小屋「生活動態」涓流 → 私聊 room_card
 *
 * 思路（用戶拍板的極簡版）：情緒評估（副 API）本來就在每輪聊完後跑，讓它**偶爾順便**
 * 捎帶一句「角色小屋裡發生的小變化」（換了桌上的書 / 窗台多了盆花……），落成一張
 * 輕量 room_card 進私聊——卡片 content 進上下文，角色自然記得自己幹過啥，
 * 後續歸檔/記憶全走現有管線。**不綁角色字段、不做獨立 feed**：卡片本身就是記錄，
 * 一切交給上下文和看到上下文的 AI。
 *
 * 管線（雙路徑通吃）：
 *   1. buildEmotionEvalPrompt 構建時，若 shouldRequestAmbient 雙閘通過，追加
 *      buildAmbientEvalSection 的可選輸出段。instant 模式的 eval prompt 也是客戶端
 *      構建後傳給 worker 的，所以這一處覆蓋在線 + instant 兩條路徑。
 *   2. applyEmotionEvalRaw（兩條路徑的共用落點）解析可選 ambientEvent，
 *      落 room_card + 記錄 localStorage 水位。
 *
 * 節流雙閘（客戶端判，判不過連 prompt 段都不加、零成本）：
 *   - 時間閘：距上一條 < AMBIENT_MIN_INTERVAL_MS 不生成
 *   - 概率閘：過了時間閘也只有 AMBIENT_PROBABILITY 概率真出——"偶爾"的驚喜，不是準點打卡
 */

import { CharacterProfile } from '../types';
import { DB } from './db';

export const AMBIENT_MIN_INTERVAL_MS = 90 * 60 * 1000; // 90 分鐘
export const AMBIENT_PROBABILITY = 0.3;
const AMBIENT_TEXT_MAX = 60;

const lastKey = (charId: string) => `room_ambient_last_${charId}`;

interface AmbientMark { ts: number; text: string }

function readLastMark(charId: string): AmbientMark | null {
    try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(lastKey(charId)) : null;
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return typeof parsed?.ts === 'number' ? parsed : null;
    } catch { return null; }
}

function writeLastMark(charId: string, text: string): void {
    try { localStorage.setItem(lastKey(charId), JSON.stringify({ ts: Date.now(), text } satisfies AmbientMark)); } catch { /* ignore */ }
}

/** 雙閘判定。random 可注入便於測試。 */
export function shouldRequestAmbient(charId: string, random: () => number = Math.random): boolean {
    const last = readLastMark(charId);
    if (last && Date.now() - last.ts < AMBIENT_MIN_INTERVAL_MS) return false;
    return random() < AMBIENT_PROBABILITY;
}

/** 情緒評估 prompt 的可選輸出段。只在雙閘通過時拼進去。 */
export function buildAmbientEvalSection(char: CharacterProfile): string {
    const items = (char.roomConfig?.items || [])
        .slice(0, 15)
        .map(i => i.name)
        .filter(Boolean)
        .join('、');
    const lastText = readLastMark(char.id)?.text;
    return `

## [可選] 小屋生活動態 (ambientEvent)
角色有一間自己的小屋。如果你覺得 ta 這段時間裡、在自己的生活裡自然會發生一個**微小的變化**
（換了桌上的書、窗台多了盆花、燈還亮著、杯子挪了位置……），可以在上述 JSON 裡額外加一個可選字段：
"ambientEvent": { "text": "把飄窗那本書換成了新的一本", "emoji": "📖" }
- text ≤ ${AMBIENT_TEXT_MAX} 字，客觀白描一句，不帶心理描寫（心理歸 innerState）。
- 變化要貼合角色此刻的日程/情緒，且是 ta 自己生活的痕跡，與用戶無關。
${items ? `- 小屋裡現有的物件可以參考：${items}。` : ''}
${lastText ? `- 上一條動態是「${lastText}」，不要重複或雷同。` : ''}
- **絕大多數時候不需要**——沒有值得一提的變化就省略整個 ambientEvent 字段，不要硬編。`;
}

/**
 * 從 eval 結果裡解析可選 ambientEvent 並落地：私聊 room_card + localStorage 水位。
 * 寬鬆校驗，不合法/失敗靜默返回 false，絕不影響情緒主鏈路。
 */
export async function landAmbientEventFromEval(parsed: any, char: CharacterProfile): Promise<boolean> {
    try {
        const ev = parsed?.ambientEvent;
        if (!ev || typeof ev.text !== 'string' || !ev.text.trim()) return false;
        const text = ev.text.trim().slice(0, AMBIENT_TEXT_MAX);
        const emoji = (typeof ev.emoji === 'string' && ev.emoji.trim()) ? ev.emoji.trim().slice(0, 4) : undefined;
        await DB.saveMessage({
            charId: char.id,
            role: 'assistant',
            type: 'room_card',
            content: `[小屋動態] ${char.name}${text}`,
            metadata: { roomAmbient: true, text, emoji },
        });
        writeLastMark(char.id, text);
        console.log(`🏠 [RoomAmbient] ${char.name}: ${text}`);
        return true;
    } catch (e: any) {
        console.warn('🏠 [RoomAmbient] land failed (non-fatal):', e?.message);
        return false;
    }
}
