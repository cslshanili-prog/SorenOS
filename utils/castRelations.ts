/**
 * 提示詞「你身邊的人」（關係線第 6 批，plans/persona-line-batch6.md 第 6 節）：角色的關係清單，
 * 加上別人關係清單裡記到它的（不然生了一個聯姻對象，主角自己卻不知道）。主角配角都適用。純邏輯。
 */
import type { CharacterProfile } from '../types';

type Relation = { targetId: string; description: string };
type RelationSource = { id: string; name: string; relationships: ReadonlyArray<Relation> };

export const CAST_RELATION_LIMIT = 20;

export function castRelationLines(args: {
    char: Pick<CharacterProfile, 'id' | 'relationships'>;
    /** 所有有關係清單的角色（含自己也沒關係） */
    others: ReadonlyArray<RelationSource>;
    nameOf: (id: string) => string | null | undefined;
    /** 這個人的別名（plans/character-identity-fields.md 3.5）：有就寫在名字後面，聊到「Vivian」時角色才知道是清單上的誰 */
    aliasesOf?: (id: string) => ReadonlyArray<string> | null | undefined;
    userName: string;
    /** 跟「你」的那條只在主線上算（寫的是主線那張卡；別條線上的你是另一個人）。不給＝算 */
    includeUser?: boolean;
    /** 跟某個角色的羈絆路線補一句（友情、親情線；plans/bond-batch1.md 2.2）。沒有就不加 */
    routeNoteOf?: (id: string) => string | undefined;
}): string[] {
    const { char, others, nameOf, aliasesOf, userName, includeUser = true, routeNoteOf } = args;
    const withRoute = (id: string, line: string) => { const note = routeNoteOf?.(id); return note ? `${line}（${note}）` : line; };
    const tag = (id: string, name: string) => {
        const aliases = (aliasesOf?.(id) || []).filter(a => a && a !== name);
        return aliases.length ? `「${name}」（又叫 ${aliases.join('、')}）` : `「${name}」`;
    };
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const r of char.relationships || []) {
        const desc = r.description?.trim();
        if (!desc) continue;
        if (r.targetId === 'user') { if (includeUser) lines.push(`跟「${userName}」：${desc}`); continue; }
        const name = nameOf(r.targetId);
        if (!name) continue;
        seen.add(r.targetId);
        lines.push(withRoute(r.targetId, `跟${tag(r.targetId, name)}：${desc}`));
    }
    for (const o of others) {
        if (o.id === char.id) continue;
        for (const r of o.relationships) {
            const desc = r.description?.trim();
            if (r.targetId !== char.id || !desc) continue;
            lines.push(seen.has(o.id) ? `（「${o.name}」那邊記的是：${desc}）` : withRoute(o.id, `${tag(o.id, o.name)}跟你：${desc}`));
        }
    }
    return lines.slice(0, CAST_RELATION_LIMIT);
}

export function formatCastRelationsBlock(args: Parameters<typeof castRelationLines>[0]): string {
    const lines = castRelationLines(args);
    if (!lines.length) return '';
    return `### 你身邊的人\n${lines.map(l => `- ${l}`).join('\n')}\n\n`;
}
