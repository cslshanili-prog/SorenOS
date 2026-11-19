/**
 * 劇情的「誰跟誰同場過」登記表（plans/story-multi-persona.md 第 6 節）。
 *
 * 劇情清單存在資料庫裡，只有見面的劇情頁會載入；朋友圈算「見過的身份」時要知道哪些身份卡
 * 跟哪些角色在劇情裡同場過，從這裡拿。開機時 OSContext 載一次，劇情存檔、刪除時劇情頁更新它。
 * 只記算得到「見過」的那幾欄，跟 utils/charNameRegistry.ts 同一個做法。
 */

import type { StoryTheaterEntry } from '../types';

export type StoryScene = Pick<StoryTheaterEntry, 'id' | 'characterIds' | 'presence' | 'mask'>;

let scenes: StoryScene[] = [];

const slim = (entry: StoryScene): StoryScene => ({
    id: entry.id,
    characterIds: [...(entry.characterIds || [])],
    ...(entry.presence ? { presence: entry.presence } : {}),
    ...(entry.mask ? { mask: entry.mask } : {}),
});

export const setStoryScenes = (entries: StoryScene[]): void => { scenes = entries.map(slim); };

export const upsertStoryScene = (entry: StoryScene): void => {
    scenes = [slim(entry), ...scenes.filter(item => item.id !== entry.id)];
};

export const removeStoryScene = (id: string): void => { scenes = scenes.filter(item => item.id !== id); };

export const getStoryScenes = (): StoryScene[] => scenes;
