/**
 * Char 音樂 · Schedule 運行時 (純同步版)
 *
 * 設計目標：給 char 一個"此刻背景音"元數據，讓它能在聊天 / 拜訪頁裡感知。
 * 故意 **不** 拉歌詞、不做進度映射 —— char 作為敘事主體天然知道"自己在聽什麼"，
 * 不需要 app 模擬物理播放進度給它看。
 *
 * 因此這個模塊是純同步的：給定 char + schedule + now，直接返回一份 CharCurrentListening 或 null。
 * 可以在任意位置（chat 送信前、拜訪頁渲染時）自由調用，零網絡成本。
 */

import { CharacterProfile, CharCurrentListening, CharPlaylistSong, DailySchedule, ScheduleSlot } from '../types';
import { getLocalDateKey } from './localDate';
import { getScheduleWallClock } from './scheduleTime';

const LISTENING_KEYWORDS = [
    '聽歌', '聽音樂', '戴耳機', '戴上耳機', '戴著耳機', '耳機',
    '循環', '單曲循環', '播放', '耳畔', '耳旁',
    '播放列表', '歌單', '副歌', '前奏',
    'listening', 'music', 'song', 'playlist', 'vinyl', 'headphone', '🎵', '🎶', '🎧',
];

const MAX_SAMPLED_SONGS = 20;

/** 返回當前時間屬於哪一個 slot */
export const getCurrentSlot = (schedule: DailySchedule | null, at: Date = new Date()): ScheduleSlot | null => {
    if (!schedule?.slots?.length) return null;
    const nowMin = at.getHours() * 60 + at.getMinutes();
    for (let i = schedule.slots.length - 1; i >= 0; i--) {
        const [h, m] = schedule.slots[i].startTime.split(':').map(Number);
        if (!isFinite(h) || !isFinite(m)) continue;
        if (nowMin >= h * 60 + m) return schedule.slots[i];
    }
    return null;
};

/** 判斷 slot 是否暗示"在聽歌" */
export const slotIsListening = (slot: ScheduleSlot | null): boolean => {
    if (!slot) return false;
    const blob = `${slot.activity || ''} ${slot.description || ''} ${slot.innerThought || ''} ${slot.emoji || ''}`.toLowerCase();
    return LISTENING_KEYWORDS.some(kw => blob.includes(kw.toLowerCase()));
};

/** slot.startTime "08:00" → 今日 Date */
const slotStartToDate = (slot: ScheduleSlot, baseDate: Date): Date => {
    const [h, m] = slot.startTime.split(':').map(Number);
    const d = new Date(baseDate);
    d.setHours(h || 0, m || 0, 0, 0);
    return d;
};

/**
 * 抽樣池：按歌單順序去重取前 MAX_SAMPLED_SONGS 首。
 *
 * 單獨 export 是給主動消息用的——fire_pack 把這份池子隨包帶給 worker，worker 到點用
 * 下面同一個 pickSongFromPool 抽，抽出來的跟角色在聊天裡說的是同一首。
 */
export const buildSongPool = (char: CharacterProfile): CharPlaylistSong[] => {
    const p = char.musicProfile;
    if (!p) return [];
    const pool: CharPlaylistSong[] = [];
    const seen = new Set<number>();
    for (const pl of p.playlists) {
        for (const s of pl.songs) {
            if (seen.has(s.id)) continue;
            seen.add(s.id);
            pool.push(s);
            if (pool.length >= MAX_SAMPLED_SONGS) break;
        }
        if (pool.length >= MAX_SAMPLED_SONGS) break;
    }
    return pool;
};

/**
 * 基於 (today + slot.startTime + charId) 種子從池子裡穩定抽一首。
 * 同一 slot 期間永遠是同一首歌，不會跳。
 */
export const pickSongFromPool = <T,>(
    pool: T[],
    slotStartTime: string,
    today: string,
    charId: string,
): T | null => {
    if (pool.length === 0) return null;
    const seedStr = `${today}-${slotStartTime}-${charId}`;
    let h = 0;
    for (const ch of seedStr) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return pool[h % pool.length];
};

/**
 * 計算 char 此刻該"在聽"的歌（純同步，無網絡）。
 * - slot 不含聽歌關鍵詞 → 返回 null
 * - char 沒有歌單或歌單全為空 → 返回 null
 *
 * 調用方可以直接把結果掛到 char.musicProfile.currentListening (UI 展示)，
 * 或只臨時用於 prompt 注入，不必持久化。
 */
export function computeCurrentListening(
    char: CharacterProfile,
    schedule: DailySchedule | null,
    now: Date = new Date(),
): CharCurrentListening | null {
    if (!char.musicProfile) return null;

    const wallNow = getScheduleWallClock(char, now);
    const slot = getCurrentSlot(schedule, wallNow);
    if (!slot || !slotIsListening(slot)) return null;

    const today = getLocalDateKey(wallNow);
    const song = pickSongFromPool(buildSongPool(char), slot.startTime, today, char.id);
    if (!song) return null;

    return {
        songId: song.id,
        songName: song.name,
        artists: song.artists,
        albumPic: song.albumPic,
        vibe: slot.innerThought || slot.description || undefined,
        startedAt: slotStartToDate(slot, wallNow).getTime(),
    };
}
