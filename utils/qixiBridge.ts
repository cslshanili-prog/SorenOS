import type { UserProfile } from '../types';
import type { QixiJourneyBeat } from './qixiReunion';
import type { QixiMemoryBundle } from './qixiMemoryBundle';
import { parseQixiJsonObject } from './qixiJson';

export type QixiMagpieOwner = 'user' | 'char';

export interface QixiMagpie {
    id: string;
    evidenceId: string | null;
    name: string;
    memory: string;
    visualHint: string;
    owner: QixiMagpieOwner;
}

export type QixiBridgeNode = QixiMagpie;

export interface QixiFinalMagpie {
    name: string;
    line: string;
    visualHint: string;
}

export interface QixiBridgeBundle {
    source: 'generated' | 'fallback';
    userMagpies: QixiMagpie[];
    charMagpies: QixiMagpie[];
    finalMagpie: QixiFinalMagpie;
    /** Combined list retained for old replay/card readers. */
    nodes: QixiMagpie[];
}

const compact = (value: unknown, max: number): string => typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, max)
    : '';

const makeMagpie = (
    evidence: QixiMemoryBundle['evidence'][number],
    memoryBundle: QixiMemoryBundle,
    owner: QixiMagpieOwner,
    index: number,
): QixiMagpie => {
    const artifact = memoryBundle.artifacts.find(item => item.evidenceIds.includes(evidence.id));
    return {
        id: `${owner}-magpie-${index + 1}`,
        evidenceId: evidence.id,
        name: artifact?.label || evidence.object || `記憶 ${index + 1}`,
        memory: evidence.fact,
        visualHint: artifact?.kind || '一小段發光文字',
        owner,
    };
};

export function createQixiBridgeFallback(memoryBundle: QixiMemoryBundle, userName = 'User'): QixiBridgeBundle {
    const usable = memoryBundle.evidence.slice(0, 8);
    const userEvidence = usable.filter((_, index) => index % 2 === 0);
    const charEvidence = usable.filter((_, index) => index % 2 === 1);
    if (!charEvidence.length && userEvidence.length > 1) charEvidence.push(userEvidence.pop()!);
    const userMagpies = userEvidence.map((item, index) => makeMagpie(item, memoryBundle, 'user', index));
    const charMagpies = charEvidence.map((item, index) => makeMagpie(item, memoryBundle, 'char', index));
    return {
        source: 'fallback',
        userMagpies,
        charMagpies,
        finalMagpie: { name: userName, line: '不會真是那個人吧。', visualHint: '對岸最後亮起的名字' },
        nodes: [...userMagpies, ...charMagpies],
    };
}

export function normalizeQixiBridgeBundle(
    value: QixiBridgeBundle | undefined,
    memoryBundle: QixiMemoryBundle,
    userName: string,
): QixiBridgeBundle {
    if (value?.userMagpies?.length && value?.charMagpies?.length && value.finalMagpie) return value;
    const legacy = (value as any)?.nodes;
    if (Array.isArray(legacy) && legacy.length) {
        const migrated = legacy.map((node: any, index: number): QixiMagpie => ({
            id: compact(node.id, 40) || `legacy-magpie-${index + 1}`,
            evidenceId: compact(node.evidenceId, 32) || null,
            name: compact(node.name, 48) || compact(node.artifactLabel, 48) || `記憶 ${index + 1}`,
            memory: compact(node.memory, 120) || compact(node.memoryLine, 120),
            visualHint: compact(node.visualHint, 48) || compact(node.artifactLabel, 48) || '發光文字',
            owner: index % 2 === 0 ? 'user' : 'char',
        }));
        const userMagpies = migrated.filter(item => item.owner === 'user');
        const charMagpies = migrated.filter(item => item.owner === 'char');
        return {
            source: value?.source || 'fallback',
            userMagpies: userMagpies.length ? userMagpies : migrated.slice(0, 1),
            charMagpies: charMagpies.length ? charMagpies : migrated.slice(1, 2),
            finalMagpie: { name: userName, line: '這次可別讓我認錯。', visualHint: '對岸最後亮起的名字' },
            nodes: migrated,
        };
    }
    return createQixiBridgeFallback(memoryBundle, userName);
}

export function parseQixiBridge(raw: string, _memoryBundle: QixiMemoryBundle, userName = 'User'): QixiBridgeBundle | null {
    const parsed = parseQixiJsonObject(raw, ['userMagpies', 'charMagpies']);
    if (!parsed) return null;
    const asList = (value: unknown): any[] => Array.isArray(value)
        ? value
        : value && typeof value === 'object' ? Object.values(value as Record<string, unknown>) : [];
    const rawUserMagpies = asList(parsed.userMagpies);
    const rawCharMagpies = asList(parsed.charMagpies);
    if (!rawUserMagpies.length || !rawCharMagpies.length) return null;
    const generatedText = (value: unknown): string => typeof value === 'string'
        ? value.replace(/\r\n/g, '\n').trim()
        : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
    const parseSide = (items: any[], owner: QixiMagpieOwner): QixiMagpie[] => {
        return items.map((item, index): QixiMagpie => ({
            id: `${owner}-magpie-${index + 1}`,
            evidenceId: generatedText(item?.evidenceId) || null,
            name: generatedText(item?.name),
            memory: generatedText(item?.memory),
            visualHint: generatedText(item?.visualHint),
            owner,
        }));
    };
    const userMagpies = parseSide(rawUserMagpies, 'user');
    const charMagpies = parseSide(rawCharMagpies, 'char');
    if (!userMagpies.length || !charMagpies.length) return null;
    const rawFinalMagpie = parsed.finalMagpie && typeof parsed.finalMagpie === 'object' && !Array.isArray(parsed.finalMagpie)
        ? parsed.finalMagpie as Record<string, unknown>
        : null;
    if (!rawFinalMagpie) return null;
    return {
        source: 'generated',
        userMagpies,
        charMagpies,
        finalMagpie: {
            name: generatedText(rawFinalMagpie.name) || userName,
            line: generatedText(rawFinalMagpie.line),
            visualHint: generatedText(rawFinalMagpie.visualHint),
        },
        nodes: [...userMagpies, ...charMagpies],
    };
}

export function buildQixiBridgePrompt(memoryBundle: QixiMemoryBundle, journey: QixiJourneyBeat[], userName: string): string {
    const evidence = memoryBundle.evidence.map(item => `${item.id}｜${item.object}｜${item.fact}`).join('\n');
    const visited = journey.map(item => `${item.sceneName}｜共享內容：${item.sharedObject}｜Char 的另一層操作：${item.charAction}`).join('\n');
    return `### 七夕活動 Part 2：生成記憶鵲

這是探索結束後、最終見到 Char 之前的最後一段互動。記憶本身不是橋；User 或 Char 想起一段真實記憶時，那段記憶會喚來一隻鵲。鵲飛過星河留下像針線一樣細的軌跡，雙方從兩岸共同把路織到中央。

只使用 Part 1 已經召回並驗證的 evidence，不重新發明事實：
${evidence || '（沒有可用真實證據）'}

本輪會經過的地點：
${visited}

為兩岸分別選擇若干記憶：
- userMagpies：優先選擇 User 會由此想到 Char 的記憶。
- charMagpies：優先選擇 Char 會由此想到 User 的記憶。
- 兩側可以引用同一 evidence，但觀察角度必須不同；同一側不得重複 evidenceId。
- 數量根據有效記憶動態決定，寧可少而準確，不得為了畫面豐富偽造。
- name 極短，優先物件、稱呼、時間、地點或短語。
- memory 像兩個人自己會認出來的私人標籤，不寫檔案摘要，不把轉述偽裝成原話。
- visualHint 只抽象顏色、文字、光或剪影，不新增共同經歷。

最後一隻鵲必須從 Char 一岸飛來。finalMagpie.name 固定為“${userName}”；line 是 Char 已經強烈懷疑另一邊是 User、卻尚未親眼確認的一句極短反應，必須符合當前角色。不得在這裡說“果然是你 / 我就知道是你 / 找到你了”；身份確認留給最終見面。

禁止在任何字段解釋“思念就是鵲橋”“記憶讓我們相見”等中心思想。動畫會自己表達。

只輸出 JSON：
{
  "userMagpies": [
    { "evidenceId": "e1", "name": "記憶名稱", "memory": "一句極短真實記憶", "visualHint": "極短視覺意象" }
  ],
  "charMagpies": [
    { "evidenceId": "e2", "name": "記憶名稱", "memory": "一句極短真實記憶", "visualHint": "極短視覺意象" }
  ],
  "finalMagpie": {
    "name": "${userName}",
    "line": "Char 幾乎猜到但還不敢確認的極短反應",
    "visualHint": "從對岸飛來的名字"
  }
}`;
}

export async function prepareQixiBridge(
    user: UserProfile,
    memoryBundle: QixiMemoryBundle,
): Promise<QixiBridgeBundle> {
    if (memoryBundle.bridge) return normalizeQixiBridgeBundle(memoryBundle.bridge, memoryBundle, user.name);
    if (memoryBundle.source === 'fallback') return createQixiBridgeFallback(memoryBundle, user.name);
    throw new Error('Part 2 缺少隨 Part 1 後半段生成的記憶鵲，請重新生成 Part 1。');
}
