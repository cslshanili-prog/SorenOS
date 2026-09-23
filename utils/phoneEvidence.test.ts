import { describe, expect, it } from 'vitest';
import { buildPhoneEvidenceChatCard, normalizePhoneEvidence, phoneFieldToText } from './phoneEvidence';

describe('phone evidence safety', () => {
    it('把 LLM 返回的對象字段轉成可讀文本，而不是 React 對象子節點', () => {
        const value = phoneFieldToText({ tags: ['懸疑', '連載'], reading_progress: 42 });
        expect(value).toBe('tags: 懸疑\n連載\nreading_progress: 42');
    });

    it('處理數組、空值和循環引用時不會拋錯', () => {
        const cyclic: any = { excerpt: '片段' };
        cyclic.self = cyclic;
        expect(phoneFieldToText(cyclic)).toContain('self: [循環引用]');
        expect(phoneFieldToText(null, '缺省')).toBe('缺省');
    });

    it('能修復已經存進 phoneState 的舊記錄供 UI 安全渲染', () => {
        const record = normalizePhoneEvidence({
            id: 'bad-record',
            type: 'novel',
            title: { chapter: '第一章' },
            detail: ['第一段', '第二段'],
            value: { reading_progress: '70%' },
            timestamp: 1,
        } as any);
        expect(record.title).toBe('chapter: 第一章');
        expect(record.detail).toBe('第一段\n第二段');
        expect(record.value).toBe('reading_progress: 70%');
    });

    it('事後同步複用首次生成時的 phone_card 內容和元數據', () => {
        const card = buildPhoneEvidenceChatCard({
            id: 'record-1',
            type: 'novel',
            title: '第三章 夜航',
            detail: '她把沒發出去的話藏進草稿箱。',
            value: '1.2萬字',
            timestamp: 1,
        }, '閱讀');
        expect(card.content).toBe('[你手機的閱讀] 第三章 夜航 · 1.2萬字 — 她把沒發出去的話藏進草稿箱。');
        expect(card.metadata.phoneCard).toMatchObject({ app: '閱讀', kind: 'novel', title: '第三章 夜航' });
    });
});
