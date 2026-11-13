import { describe, expect, it } from 'vitest';
import { addLibraryGenDrafts, LIBRARY_GEN_DRAFTS_MAX, type LibraryGenDraft } from './libraryGenDrafts';

const d = (id: string, saved = false): LibraryGenDraft => ({ id, ref: `r-${id}`, kind: 'scenery', userPrompt: '', scenePrompt: '', subjects: [], locked: 0, wanted: 0, peopleCount: 0, createdAt: 1, ...(saved ? { savedImageId: 'g' } : {}) });

describe('暫存', () => {
    it('新的在前；超過上限先丟最舊的已存過的，再丟最舊的', () => {
        const full = Array.from({ length: LIBRARY_GEN_DRAFTS_MAX }, (_, i) => d(`o${i}`, i === 3));
        const r = addLibraryGenDrafts(full, [d('new')]);
        expect(r.next[0].id).toBe('new');
        expect(r.next).toHaveLength(LIBRARY_GEN_DRAFTS_MAX);
        expect(r.dropped.map(x => x.id)).toEqual(['o3']);
        const r2 = addLibraryGenDrafts(full.filter(x => !x.savedImageId).concat(d('o99')), [d('n2')]);
        expect(r2.dropped.map(x => x.id)).toEqual(['o99']);
    });
});
