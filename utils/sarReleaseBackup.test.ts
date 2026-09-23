import { beforeEach, describe, expect, it } from 'vitest';
import { collectSARLocalBackup, restoreSARLocalBackup } from './vrWorld/sarBackup';
import { loadChatInputPreferences, saveChatInputPreferences, CHAT_INPUT_PREFERENCES_KEY } from './chatInputPreferences';

beforeEach(() => localStorage.clear());
describe('SAR / 私聊偏好備份兼容', () => {
    it('完整還原已關閉的開關、配色和引導記錄，不把 false 當成沒保存', () => {
        localStorage.setItem('vr_fishing_simple_mode', 'false');
        localStorage.setItem('vr_sar_session_theme_v1', 'light');
        localStorage.setItem('sar-garden-guide-v1', 'done');
        const backup = collectSARLocalBackup();
        localStorage.clear();
        restoreSARLocalBackup(JSON.parse(JSON.stringify(backup)), { replaceMissing: true });
        expect(collectSARLocalBackup()).toEqual(backup);
    });
    it('舊主歷史清理 SAR 偏好；僅媒體/局部備份不清理', () => {
        localStorage.setItem('vr_fishing_simple_mode', 'true');
        restoreSARLocalBackup(undefined, { replaceMissing: false });
        expect(localStorage.getItem('vr_fishing_simple_mode')).toBe('true');
        restoreSARLocalBackup(undefined, { replaceMissing: true });
        expect(localStorage.getItem('vr_fishing_simple_mode')).toBeNull();
    });
    it('備份中的未知鍵與非法值不能寫入其他配置', () => {
        restoreSARLocalBackup({ version: 1, preferences: { os_api_config: 'poison', vr_sar_session_theme_v1: 'poison', vr_fishing_simple_mode: 'true' } }, { replaceMissing: true });
        expect(localStorage.getItem('os_api_config')).toBeNull();
        expect(localStorage.getItem('vr_sar_session_theme_v1')).toBeNull();
        expect(localStorage.getItem('vr_fishing_simple_mode')).toBe('true');
    });
    it('聊天偏好保留明確布爾值，舊字段缺省按用戶指定默認值，忽略未知內容', () => {
        saveChatInputPreferences({ sendButtonGenerates: true, enterToSend: false, autoReply: true, emojiSuggestions: true });
        expect(loadChatInputPreferences()).toEqual({ sendButtonGenerates: true, enterToSend: false, autoReply: true, emojiSuggestions: true });
        saveChatInputPreferences({ enterToSend: false, private: 'poison', autoReply: 'true' } as any);
        expect(loadChatInputPreferences()).toEqual({ sendButtonGenerates: false, enterToSend: false, autoReply: false, emojiSuggestions: false });
        expect(localStorage.getItem(CHAT_INPUT_PREFERENCES_KEY)).not.toContain('poison');
    });
});


it('導出舊日期商店不刷新貨架，也不消耗或重置當天次數', () => {
    const shop = { version:1, credits:0, inventory:{}, purchases:[], market:{ dayKey:'2020-01-01', offerIds:['saved-offer'], rollsRemaining:1 } };
    localStorage.setItem('vr_sar_module_shop_v1', JSON.stringify(shop));
    const before = localStorage.getItem('vr_sar_module_shop_v1');
    expect(collectSARLocalBackup().moduleShop).toEqual(shop);
    expect(collectSARLocalBackup().moduleShop).toEqual(shop);
    expect(localStorage.getItem('vr_sar_module_shop_v1')).toBe(before);
});
