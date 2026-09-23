import { describe, it, expect } from 'vitest';
import { deriveRecentTrackSwitchForChar } from './chatRequestPayload';
import type { RecentTrackChange } from '../context/MusicContext';

const record = (overrides: Partial<RecentTrackChange> = {}): RecentTrackChange => ({
    previousSong: { id: 1, name: '起風了', artists: '買辣椒也用券' },
    charIds: ['char-1'],
    at: Date.now(),
    ...overrides,
});

describe('deriveRecentTrackSwitchForChar 換歌察覺判定', () => {
    it('換歌那刻在一起聽名單裡、未重新加入、剛發生 → 命中，返回上一首信息', () => {
        expect(deriveRecentTrackSwitchForChar(record(), 'char-1', false)).toEqual({
            songName: '起風了',
            artists: '買辣椒也用券',
        });
    });

    it('沒有換歌記錄 → null', () => {
        expect(deriveRecentTrackSwitchForChar(null, 'char-1', false)).toBeNull();
        expect(deriveRecentTrackSwitchForChar(undefined, 'char-1', false)).toBeNull();
    });

    it('char 已重新加入一起聽 → 不再提示', () => {
        expect(deriveRecentTrackSwitchForChar(record(), 'char-1', true)).toBeNull();
    });

    it('換歌那刻 char 不在一起聽名單裡 → 與它無關，不提示', () => {
        expect(deriveRecentTrackSwitchForChar(record(), 'char-2', false)).toBeNull();
    });

    it('換歌已過去太久（超過新鮮窗口）→ 不再提示', () => {
        const stale = record({ at: Date.now() - 11 * 60 * 1000 });
        expect(deriveRecentTrackSwitchForChar(stale, 'char-1', false)).toBeNull();
    });
});
