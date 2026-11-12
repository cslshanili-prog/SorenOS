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
    userName: string;
}): string[] {
    const { char, others, nameOf, userName } = args;
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const r of char.relationships || []) {
        const desc = r.description?.trim();
        if (!desc) continue;
        if (r.targetId === 'user') { lines.push(`跟「${userName}」：${desc}`); continue; }
        const name = nameOf(r.targetId);
        if (!name) continue;
        seen.add(r.targetId);
        lines.push(`跟「${name}」：${desc}`);
    }
    for (const o of others) {
        if (o.id === char.id) continue;
        for (const r of o.relationships) {
            const desc = r.description?.trim();
            if (r.targetId !== char.id || !desc) continue;
            lines.push(seen.has(o.id) ? `（「${o.name}」那邊記的是：${desc}）` : `「${o.name}」跟你：${desc}`);
        }
    }
    return lines.slice(0, CAST_RELATION_LIMIT);
}

export function formatCastRelationsBlock(args: Parameters<typeof castRelationLines>[0]): string {
    const lines = castRelationLines(args);
    if (!lines.length) return '';
    return `### 你身邊的人\n${lines.map(l => `- ${l}`).join('\n')}\n\n`;
}
