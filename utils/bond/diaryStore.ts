/**
 * 開機讀日記：替舊日記補 bondId（算在那個角色主線那張卡的空間），再放進登記表（plans/bond-batch3.md 1.1）。
 * 只補欄位不動內容；補過的下次就不會再改。
 */
import type { CharacterProfile, DiaryEntry } from '../../types';
import { DB } from '../db';
import { personaBondId } from './model';
import { setDiaryRegistry } from './diaryRegistry';

export function legacyDiaryBondIds(all: DiaryEntry[], characters: Array<Pick<CharacterProfile, 'id' | 'primaryPersonaKey'>>): DiaryEntry[] {
    const byId = new Map(characters.map(c => [c.id, c]));
    return all.flatMap(d => {
        if (d.bondId) return [];
        const c = byId.get(d.charId);
        return c ? [{ ...d, bondId: personaBondId(c.id, c.primaryPersonaKey) }] : [];
    });
}

export async function refreshDiaryRegistry(characters: Array<Pick<CharacterProfile, 'id' | 'primaryPersonaKey'>>): Promise<void> {
    const all = await DB.getAllDiaries().catch(() => [] as DiaryEntry[]);
    const patched = legacyDiaryBondIds(all, characters);
    if (patched.length) {
        for (const d of patched) await DB.saveDiaryQuiet(d).catch(() => {});
    }
    const byId = new Map(all.map(d => [d.id, d]));
    for (const d of patched) byId.set(d.id, d);
    setDiaryRegistry([...byId.values()]);
}
