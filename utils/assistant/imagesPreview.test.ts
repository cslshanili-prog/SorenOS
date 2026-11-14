import { describe, expect, it } from 'vitest';
import type { AssistantMessage, AssistantProposal, CharacterProfile, ChatTheme, GroupProfile, OSTheme } from '../../types';
import { SORE_IMAGE_MESSAGES_SENT, toModelMessages } from './engine';
import { buildProposalPreview, canPreviewProposal } from './preview';
import type { CssData } from './cssLocations';

const user = (id: string, images?: string[]): AssistantMessage => ({ id, role: 'user', text: id, at: 1, ...(images ? { images } : {}) });

describe('附圖', () => {
    it('最近幾則帶圖的才送圖，更早的換成一句話', () => {
        const history = [user('a', ['data:a']), user('b', ['data:b']), user('c'), user('d', ['data:d1', 'data:d2'])];
        const msgs = toModelMessages(history);
        expect(SORE_IMAGE_MESSAGES_SENT).toBe(2);
        expect(msgs[0].content).toBe('a\n（附了 1 張圖，太舊了沒再送）');
        expect(msgs[1].content).toEqual([{ type: 'text', text: 'b' }, { type: 'image_url', image_url: { url: 'data:b' } }]);
        expect(msgs[2].content).toBe('c');
        expect(Array.isArray(msgs[3].content) && msgs[3].content.length).toBe(3);
    });
});

describe('提案預覽', () => {
    const data: CssData = {
        theme: { chatChromeCustomCss: '.sully-chat-root{background:#111}' } as unknown as OSTheme,
        characters: [{ id: 'c1', name: '阿澈' }] as unknown as CharacterProfile[],
        groups: [] as GroupProfile[],
        customThemes: [] as ChatTheme[],
    };
    const proposal = (location: string, css: string, before = ''): AssistantProposal => ({
        id: 'p', kind: 'css', location, targetId: 'c1', targetLabel: 'x', css, before, status: 'pending',
    });
    it('見面沒有預覽，其他有', () => {
        expect(canPreviewProposal(proposal('date', '.date-line{}'))).toBe(false);
        expect(buildProposalPreview(proposal('date', '.date-line{}'), data, 'after')).toBeNull();
        for (const loc of ['chat_chrome_global', 'chat_chrome_char', 'chat_chrome_group', 'bubble_theme', 'journal', 'schedule', 'thinking_chain']) {
            expect(canPreviewProposal(proposal(loc, '.x{}'))).toBe(true);
        }
    });
    it('角色白框疊在全域上面；原本的／新的分開看', () => {
        const p = proposal('chat_chrome_char', '.sully-chat-name{color:red}', '.sully-chat-name{color:blue}');
        const after = buildProposalPreview(p, data, 'after')!;
        expect(after).toContain('.sully-chat-root{background:#111}');
        expect(after.indexOf('#111')).toBeLessThan(after.indexOf('color:red'));
        expect(buildProposalPreview(p, data, 'before')).toContain('color:blue');
    });
    it('新的氣泡主題用跟套用後一樣的底色', () => {
        const doc = buildProposalPreview({ ...proposal('bubble_theme', '.sully-bubble-ai{color:teal}'), targetId: 'new' }, data, 'after')!;
        expect(doc).toContain('#6366f1');
        expect(doc).toContain('.sully-bubble-ai{color:teal}');
    });
});
