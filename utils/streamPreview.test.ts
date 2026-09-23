import { describe, it, expect } from 'vitest';
import {
    computeStreamPreviewBubbles,
    extractStreamingEmbeddedThinking,
    findNewStreamPreviewHandoverIds,
} from './streamPreview';
import type { Message } from '../types';

// 流式預覽氣泡的過濾策略：普通尾句持續增長；遇到指令/語音/翻譯/日記/HTML 塊時
// 只展示控制標記前的安全正文。最終渲染仍由 applyAssistantPostProcessing 負責。

describe('computeStreamPreviewBubbles', () => {
    it('無換行的當前尾句也實時展示', () => {
        expect(computeStreamPreviewBubbles('今天天氣真好')).toEqual(['今天天氣真好']);
    });

    it('已完成的行逐條成為氣泡，最後的尾句持續增長', () => {
        const bubbles = computeStreamPreviewBubbles('今天天氣真好\n要不要出去走走\n我在想');
        expect(bubbles).toEqual(['今天天氣真好', '要不要出去走走', '我在想']);
    });

    it('未完成尾句只顯示控制標記前的安全正文', () => {
        expect(computeStreamPreviewBubbles('先說一句，然後[[SEARCH: 半截')).toEqual(['先說一句，然後']);
        expect(computeStreamPreviewBubbles('<think>不能漏')).toEqual([]);
        expect(computeStreamPreviewBubbles('[html')).toEqual([]);
    });

    it('含 [[...]] 指令的行不預覽（表情/動作/召回等）', () => {
        const text = '哼，看在你可憐的份上\n[[SEND_EMOJI: 傲嬌]]\n[[RECALL: 2024-05]]\n明天見\n';
        expect(computeStreamPreviewBubbles(text)).toEqual(['哼，看在你可憐的份上', '明天見']);
    });

    it('定時消息指令行不預覽', () => {
        const text = '晚安啦\n[schedule_message | 2026-07-15 08:00:00 | fixed | 早安！]\n';
        expect(computeStreamPreviewBubbles(text)).toEqual(['晚安啦']);
    });

    it('單行語音標籤整行跳過', () => {
        const text = '先打個字\n<語音 emotion="happy">你猜猜我在幹嘛？</語音>\n再打一行\n';
        expect(computeStreamPreviewBubbles(text)).toEqual(['先打個字', '再打一行']);
    });

    it('尚未換行、仍在增長的語音/字幕標籤不會漏出內容', () => {
        expect(computeStreamPreviewBubbles('<語')).toEqual([]);
        expect(computeStreamPreviewBubbles('<語音 emotion="happy">你猜猜')).toEqual([]);
        expect(computeStreamPreviewBubbles('<語音>Hello</語音><字幕>你好')).toEqual([]);
    });

    it('跨行語音塊（未閉合時全部扣住，閉合後仍不預覽塊內容）', () => {
        const open = '好\n<語音 emotion="sad">I do not wanna\n';
        expect(computeStreamPreviewBubbles(open)).toEqual(['好']);
        const closed = open + 'move anymore</語音>\n<字幕>不想動了</字幕>\n但是沒辦法\n';
        expect(computeStreamPreviewBubbles(closed)).toEqual(['好', '但是沒辦法']);
    });

    it('日記多行塊不洩漏為聊天氣泡', () => {
        const text = '我寫篇日記去\n[[DIARY_START: 今天 | 開心]]\n# 大標題\n正文絮絮叨叨\n[[DIARY_END]]\n寫完了\n';
        expect(computeStreamPreviewBubbles(text)).toEqual(['我寫篇日記去', '寫完了']);
    });

    it('飛書/Notion 同構日記塊同樣不洩漏', () => {
        const text = '稍等\n[[FS_DIARY_START: 今天 | 平靜]]\n不該成為聊天氣泡\n[[FS_DIARY_END]]\n好了\n';
        expect(computeStreamPreviewBubbles(text)).toEqual(['稍等', '好了']);
    });

    it('HTML 卡片塊不洩漏', () => {
        const text = '給你做張卡\n[html]\n<div>card</div>\n[/html]\n好看嗎\n';
        expect(computeStreamPreviewBubbles(text)).toEqual(['給你做張卡', '好看嗎']);
    });

    it('think 塊（content 內嵌形態）不洩漏', () => {
        const text = '<think>\n她這句話是什麼意思…\n</think>\n沒什麼，隨口一問\n';
        expect(computeStreamPreviewBubbles(text)).toEqual(['沒什麼，隨口一問']);
    });

    it('雙語翻譯標籤行不預覽', () => {
        const text = '<翻譯>\n<原文>こんにちは</原文>\n<譯文>你好</譯文>\n</翻譯>\n';
        expect(computeStreamPreviewBubbles(text)).toEqual([]);
    });

    it('CJK 之間的空格按最終管線保留在同一個氣泡', () => {
        const bubbles = computeStreamPreviewBubbles('你來了 坐吧\n');
        expect(bubbles).toEqual(['你來了 坐吧']);
    });

    it('空文本 / 純空行返回空數組', () => {
        expect(computeStreamPreviewBubbles('')).toEqual([]);
        expect(computeStreamPreviewBubbles('\n\n')).toEqual([]);
    });
});

describe('extractStreamingEmbeddedThinking', () => {
    it('實時提取仍未閉合的 think 尾塊', () => {
        expect(extractStreamingEmbeddedThinking('<think>剛想到這裡')).toBe('剛想到這裡');
    });

    it('合併已閉合塊與後續仍在增長的塊', () => {
        expect(extractStreamingEmbeddedThinking(
            '<think>第一段</think>正文<thinking>第二段還沒寫完',
        )).toBe('第一段\n\n第二段還沒寫完');
    });
});

describe('findNewStreamPreviewHandoverIds', () => {
    const message = (id: number, content: string, type: Message['type'] = 'text'): Message => ({
        id,
        charId: 'char-1',
        role: 'assistant',
        type,
        content,
        timestamp: id,
    });

    it('只匹配基線後確實展示過的文本，不誤傷二次回覆和卡片', () => {
        const messages = [
            message(10, '舊消息'),
            message(11, '第一句'),
            message(12, '表情', 'emoji'),
            message(13, '第二句'),
            message(14, '二次調用的新回覆'),
        ];

        expect(findNewStreamPreviewHandoverIds(messages, ['第一句', '第二句'], 10, new Set()))
            .toEqual([11, 13]);
    });

    it('多次刷新消息列表時只返回尚未登記的接棒消息', () => {
        const claimed = new Set([11]);
        expect(findNewStreamPreviewHandoverIds(
            [message(10, '舊消息'), message(11, '第一句'), message(12, '第二句')],
            ['第一句', '第二句'],
            10,
            claimed,
        )).toEqual([12]);
    });
});
