/**
 * AI 批量生成配角（關係線第 6 批 6e，plans/persona-line-batch6.md 第 6 節）：純邏輯，不碰資料庫與網路。
 *
 * - 選一位主角，讀它的人設、世界觀、常駐世界書、所在世界，還有同一個世界裡已經有的人（避免撞名、能連關係）。
 * - 一次 1～5 個；方向一格自由填；跟你的關係有個勾選（預設不勾）。
 * - 輸出兩層容錯：整段 JSON 陣列 → 逐個物件搶救。
 * - 草稿轉成配角：所在世界、認識的你都跟那位主角；關係寫進自己的關係清單，兩邊查手機的通訊錄各加一筆。
 */
import type { CharacterProfile, PhoneContact } from '../types';
import { extractJson } from './safeApi';
import { CONTEXT_RANGE_POLICY_VERSION, DEFAULT_MANUAL_CONTEXT_LIMIT } from './chatContextRange';

export const CAST_GEN_MIN = 1;
export const CAST_GEN_MAX = 5;

export interface CastDraftRelation {
    /** 對象名字（主角、同一批的其他人、世界裡現有的角色，或你） */
    target: string;
    /** 這個人跟對象的關係，從這個人的角度寫 */
    relation: string;
}

export interface CastDraft {
    name: string;
    /** 一句話（別人眼中的 TA），當簡介 */
    brief: string;
    /** 完整人設，當核心指令 */
    persona: string;
    /** 外觀，畫頭像用 */
    appearance: string;
    relations: CastDraftRelation[];
}

type LeadRef = Pick<CharacterProfile, 'id' | 'name' | 'description' | 'systemPrompt' | 'worldview' | 'mountedWorldbooks' | 'groupId' | 'primaryPersonaKey'>;
type WorldRef = Pick<CharacterProfile, 'id' | 'name' | 'description' | 'castRole'>;

const clip = (s: unknown, max: number): string => (typeof s === 'string' ? s.trim() : '').slice(0, max);

export function buildCastGenPrompt(args: {
    lead: LeadRef;
    /** 同一個世界裡已經有的角色（不含主角自己） */
    worldChars: WorldRef[];
    count: number;
    direction?: string;
    /** 讓 AI 也能寫跟你的關係 */
    includeUser?: boolean;
    userName: string;
    /** 單張重生時，這些名字不要再用 */
    avoidNames?: string[];
}): string {
    const { lead, worldChars, direction, includeUser, userName } = args;
    const count = Math.max(CAST_GEN_MIN, Math.min(CAST_GEN_MAX, Math.round(args.count)));
    const books = (lead.mountedWorldbooks || []).filter(b => b.constant && b.content?.trim()).slice(0, 6)
        .map(b => `- ${b.title || '設定'}：${clip(b.content, 600)}`).join('\n');
    const others = worldChars.slice(0, 30).map(c => `- ${c.name}${c.castRole === 'supporting' ? '（配角）' : ''}：${clip(c.description, 80) || '（沒有簡介）'}`).join('\n');
    const avoid = [...new Set([lead.name, ...worldChars.map(c => c.name), ...(args.avoidNames || [])].filter(Boolean))];
    return `你是幫角色扮演故事補人物的編劇。請為主角「${lead.name}」生成 ${count} 個配角：戲份比主角少、不會變成主角，但在劇情上用得到、能推動故事的人。

## 主角「${lead.name}」
- 簡介：${clip(lead.description, 200) || '（沒有）'}
- 人設：
${clip(lead.systemPrompt, 3000) || '（沒有）'}
${lead.worldview?.trim() ? `- 世界觀：\n${clip(lead.worldview, 1500)}\n` : ''}${books ? `\n## 常駐設定\n${books}\n` : ''}
## 這個世界裡已經有的人（不要重複，可以拿來連關係）
${others || '（還沒有別人）'}

## 方向
${direction?.trim() || '照主角的人設和世界，挑劇情上最用得到的人（例如會跟主角產生拉扯、合作、衝突、牽絆的人）。'}

## 規則
- 名字要符合這個世界的風格，不要用這些名字：${avoid.map(n => `「${n}」`).join('、')}。
- 每個人至少要有一條跟「${lead.name}」的關係；彼此之間、跟世界裡現有的人有關係也寫上。
- ${includeUser ? `可以讓其中幾個人跟用戶「${userName}」有關係（例如舊識、前任、對手），對象就寫「${userName}」；不是每個人都要有。` : `不要寫跟用戶的關係，也不要在人設裡提到用戶。`}
- 人設用第二人稱「你是……」寫，300～600 字：身份、背景、性格、說話方式、想要什麼、跟主角之間的張力。不要寫成主角的附屬品，TA 有自己的生活。

## 輸出
只輸出一個 JSON 陣列，不要其他文字。每個元素：
{"name":"名字","brief":"一句話介紹（別人眼中的 TA）","persona":"完整人設","appearance":"外觀（給畫頭像用）：年紀感、髮型、五官、穿著、氛圍，一兩句","relations":[{"target":"對象名字","relation":"這個人跟對象是什麼關係（從這個人的角度寫，例如：家裡安排的聯姻對象）"}]}`;
}

function normalizeDraft(raw: any): CastDraft | null {
    if (!raw || typeof raw !== 'object') return null;
    const name = clip(raw.name, 20);
    if (!name) return null;
    const relations = (Array.isArray(raw.relations) ? raw.relations : [])
        .map((r: any) => ({ target: clip(r?.target, 20), relation: clip(r?.relation ?? r?.description, 80) }))
        .filter((r: CastDraftRelation) => r.target && r.relation)
        .slice(0, 8);
    return {
        name,
        brief: clip(raw.brief ?? raw.description, 80),
        persona: clip(raw.persona ?? raw.systemPrompt, 3000),
        appearance: clip(raw.appearance, 300),
        relations,
    };
}

/** 兩層容錯：整段 JSON（陣列或 {characters:[...]}）→ 逐個帶 name 的物件搶救。名字重複的只留第一個。 */
export function parseCastDrafts(raw: string): CastDraft[] {
    const text = String(raw ?? '').replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '');
    let items: any[] = [];
    const parsed = extractJson(text, { silent: true });
    if (Array.isArray(parsed)) items = parsed;
    else if (parsed && Array.isArray(parsed.characters)) items = parsed.characters;
    let drafts = items.map(normalizeDraft).filter((d): d is CastDraft => !!d);
    if (!drafts.length) {
        for (const m of text.match(/\{[^{}]*"name"[\s\S]*?\}\s*\]\s*\}|\{[^{}]*"name"[^{}]*\}/g) || []) {
            try { const d = normalizeDraft(JSON.parse(m)); if (d) drafts.push(d); } catch { /* 這個壞了，救下一個 */ }
        }
    }
    const seen = new Set<string>();
    drafts = drafts.filter(d => (seen.has(d.name) ? false : (seen.add(d.name), true)));
    return drafts;
}

/** 頭像的畫圖提示詞（畫風照畫風庫解析：角色、世界、各處畫風的頭像那格；style 是舊的「這次的風格」，還收著） */
export function castAvatarPrompt(draft: Pick<CastDraft, 'name' | 'appearance' | 'brief'>, style?: string): string {
    return `角色頭像，胸像，正面或微側，乾淨的背景。${draft.appearance || draft.brief}${style?.trim() ? `\n風格：${style.trim()}` : ''}`;
}

const contactFor = (target: Pick<CharacterProfile, 'id' | 'name'>, identity: string, now: number, seq: number): PhoneContact => ({
    id: `ct-${now.toString(36)}-${seq}-${Math.random().toString(36).slice(2, 6)}`,
    name: target.name,
    identity: clip(identity, 20),
    kind: 'real',
    linkedCharId: target.id,
    affinity: 0,
    status: 'friend',
    createdAt: now,
});

export interface CastBuildResult {
    chars: CharacterProfile[];
    /** 既有角色要加的通訊錄（charId → 新聯繫人）；新角色自己的通訊錄已經寫在 chars 裡 */
    contactsForExisting: Record<string, PhoneContact[]>;
}

/** 勾選的草稿 → 配角。關係對象照名字對：主角、同一批、世界裡現有的、你（勾了才算）；對不上的丟掉。 */
export function buildCastCharacters(args: {
    drafts: Array<CastDraft & { avatar?: string }>;
    lead: LeadRef;
    existing: Array<Pick<CharacterProfile, 'id' | 'name' | 'phoneState'>>;
    userName: string;
    includeUser: boolean;
    defaultAvatar: (name: string) => string;
    now?: number;
}): CastBuildResult {
    const now = args.now ?? Date.now();
    const ids = args.drafts.map((_, i) => `char-${now}-${i}-${Math.random().toString(36).slice(2, 7)}`);
    const byName = new Map<string, Pick<CharacterProfile, 'id' | 'name'>>();
    for (const c of args.existing) if (!byName.has(c.name)) byName.set(c.name, c);
    byName.set(args.lead.name, args.lead);
    args.drafts.forEach((d, i) => byName.set(d.name, { id: ids[i], name: d.name }));
    const contactsForExisting: Record<string, PhoneContact[]> = {};
    const existingIds = new Set(args.existing.map(c => c.id));
    let seq = 0;

    const chars = args.drafts.map((d, i): CharacterProfile => {
        const id = ids[i];
        const relationships: NonNullable<CharacterProfile['relationships']> = [];
        const contacts: PhoneContact[] = [];
        for (const r of d.relations) {
            if (r.target === args.userName) {
                if (args.includeUser) relationships.push({ id: `rel-${now}-${seq++}`, targetId: 'user', description: r.relation });
                continue;
            }
            const target = byName.get(r.target);
            if (!target || target.id === id || relationships.some(x => x.targetId === target.id)) continue;
            relationships.push({ id: `rel-${now}-${seq++}`, targetId: target.id, description: r.relation });
            contacts.push(contactFor(target, r.relation, now, seq++));
            // 對方的手機也加一筆（同一批的，在它自己那張上加；既有的另外回傳）
            if (existingIds.has(target.id)) {
                const theirs = args.existing.find(c => c.id === target.id);
                const already = theirs?.phoneState?.contacts?.some(c => c.linkedCharId === id);
                if (!already) (contactsForExisting[target.id] ||= []).push(contactFor({ id, name: d.name }, r.relation, now, seq++));
            }
        }
        return {
            id,
            name: d.name,
            avatar: d.avatar || args.defaultAvatar(d.name),
            castRole: 'supporting',
            description: d.brief || '配角',
            systemPrompt: d.persona,
            memories: [],
            relationships,
            ...(args.lead.groupId ? { groupId: args.lead.groupId } : {}),
            ...(args.lead.primaryPersonaKey ? { primaryPersonaKey: args.lead.primaryPersonaKey, knownPersonaKeys: [args.lead.primaryPersonaKey] } : {}),
            phoneState: { records: [], contacts },
            contextLimit: DEFAULT_MANUAL_CONTEXT_LIMIT,
            contextRangeMode: 'manual',
            contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
            emotionConfig: { enabled: true },
        } as CharacterProfile;
    });

    // 同一批之間：B 記了跟 A 的關係，A 的手機也加 B（A 自己沒記的話）
    chars.forEach(c => {
        for (const r of c.relationships || []) {
            const other = chars.find(x => x.id === r.targetId);
            if (!other || other.phoneState?.contacts?.some(k => k.linkedCharId === c.id)) continue;
            other.phoneState!.contacts!.push(contactFor(c, r.description, now, seq++));
        }
    });

    return { chars, contactsForExisting };
}
