import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AppID } from '../types';
import { shellHandlesSafeArea, SELF_SAFE_AREA_APPS } from './safeAreaApps';

// 已遷移成自理安全區的 App：外殼不該再替它加 padding（否則頂部雙重讓位、留白過多）。
// 這是迴歸守衛——誰把某個 App 從 SELF_SAFE_AREA_APPS 刪了，對應斷言立刻掛。
const SELF_HANDLED: AppID[] = [
    AppID.Launcher, AppID.VRWorld, AppID.Chat, AppID.ChatHub, AppID.GroupChat, AppID.Social,
    AppID.Settings, AppID.Character, AppID.ThemeMaker, AppID.Appearance, AppID.Gallery,
    AppID.Date, AppID.User, AppID.Journal, AppID.Schedule, AppID.Room, AppID.CheckPhone,
    AppID.Study, AppID.FAQ, AppID.Game, AppID.Worldbook, AppID.Novel, AppID.Bank,
    AppID.XhsStock, AppID.XhsFreeRoam, AppID.Browser, AppID.Songwriting, AppID.Music,
    AppID.Call, AppID.VoiceDesigner, AppID.Guidebook, AppID.LifeSim, AppID.MemoryPalace,
    AppID.Handbook, AppID.QQBridge, AppID.HotNews, AppID.WorldHome, AppID.CharCreatorDev,
    AppID.SpecialMoments,
];

describe('shellHandlesSafeArea', () => {
    it('所有已登記 App 都自理安全區，外殼不加 padding', () => {
        for (const appId of SELF_HANDLED) {
            expect(shellHandlesSafeArea(appId)).toBe(false);
        }
    });

    // 雙向一致：名單裡有的斷言裡也要有，反之亦然，防止以後加/刪 App 時漏更新其中一處。
    it('自理名單與斷言列表一一對應（防漏登記）', () => {
        expect([...SELF_HANDLED].sort()).toEqual([...SELF_SAFE_AREA_APPS].sort());
    });

    it('筆友會所有頂欄都避開共享狀態欄點擊層', () => {
        const appSource = readFileSync(path.resolve(__dirname, '../apps/NovelApp.tsx'), 'utf8');
        const writerSource = readFileSync(path.resolve(__dirname, '../components/novel/NovelWriter.tsx'), 'utf8');

        expect(appSource.match(/paddingTop: 'var\(--chrome-top\)'/g)).toHaveLength(3);
        expect(writerSource).toContain("style={{ paddingTop: 'var(--chrome-top)' }}");
    });
});
