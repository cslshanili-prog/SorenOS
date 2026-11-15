import { describe, expect, it } from 'vitest';
import { describeChatDecoration } from './decorationRead';
import type { CssData } from './cssLocations';
import type { CharacterProfile, GroupProfile, OSTheme } from '../../types';

const theme = { chatDefaultBubbleStyle: 'default', chatChromeCustomCss: '.sully-chat-header{color:red}\n.a{}', chatAvatarShape: 'circle', chatBackgroundStyle: 'grid' } as unknown as OSTheme;
const char = (patch: Partial<CharacterProfile>) => ({ id: 'c1', name: '阿澈', ...patch }) as CharacterProfile;
const data = (chars: CharacterProfile[], groups: GroupProfile[] = []): CssData => ({ theme, characters: chars, groups, customThemes: [{ id: 'mine', name: '奶茶', type: 'custom', user: {} as any, ai: {} as any, customCss: '.x{}' }] });

describe('讀取聊天裝扮', () => {
    it('全局：氣泡、背景、白框行數、佈局值，列出有自己裝扮的角色', () => {
        const r = describeChatDecoration('全局', data([char({ bubbleStyle: 'mine' }), char({ id: 'c2', name: '小白' })]));
        expect(r.ok).toBe(true);
        expect(r.content).toContain('白框 CSS（chat_chrome_global）：2 行');
        expect(r.content).toContain('chatAvatarShape（頭像形狀）= circle');
        expect(r.content).toContain('有自己裝扮的角色：阿澈');
        expect(r.content).not.toContain('小白、');
    });

    it('角色：自己的氣泡、背景，佈局標出自己的', () => {
        const c = char({ bubbleStyle: 'mine', chatBackground: 'blobref:x', chatAppearance: { chatAvatarShape: 'square' }, chatFineTune: { enabled: true, chatBubbleFontSize: 16 } });
        const r = describeChatDecoration('阿澈', data([c]));
        expect(r.content).toContain('氣泡主題：奶茶（有自己的 CSS）（自己選的）');
        expect(r.content).toContain('背景：有一張圖片（自己的）');
        expect(r.content).toContain('chatAvatarShape（頭像形狀）= square　← 這個角色自己的');
        expect(r.content).toContain('chatBubbleFontSize（正文字號(0=默認)）= 16　← 這個角色自己的');
        expect(r.content).toContain('有 2 項是這個角色自己的');
    });

    it('角色沒設：都跟著全局', () => {
        const r = describeChatDecoration('c1', data([char({})]));
        expect(r.content).toContain('氣泡主題：跟著全局');
        expect(r.content).toContain('全部跟著全局');
    });

    it('群：只講群有的三樣', () => {
        const g = { id: 'g1', name: '宿舍', members: [], userBubbleThemeId: 'mine', chromeCustomCss: '.a{}' } as unknown as GroupProfile;
        const r = describeChatDecoration('宿舍', data([], [g]));
        expect(r.content).toContain('我的氣泡：奶茶');
        expect(r.content).toContain('白框 CSS（chat_chrome_group）：1 行');
    });

    it('找不到、同名', () => {
        expect(describeChatDecoration('誰', data([char({})])).ok).toBe(false);
        const r = describeChatDecoration('阿澈', data([char({}), char({ id: 'c9' })]));
        expect(r.ok).toBe(false);
        expect(r.content).toContain('c9');
    });
});
