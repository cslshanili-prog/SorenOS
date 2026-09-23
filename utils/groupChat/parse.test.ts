import { describe, it, expect } from 'vitest';
import { parseDirectorActions, parseSummaryYaml, parseGroupTopicBox } from './parse';

describe('parseDirectorActions', () => {
    it('標準 JSON 數組直接解析', () => {
        const raw = '[{"charId": "c1", "content": "早啊"}, {"charId": "c2", "content": "困死了"}]';
        expect(parseDirectorActions(raw)).toEqual([
            { charId: 'c1', content: '早啊' },
            { charId: 'c2', content: '困死了' },
        ]);
    });

    it('帶 markdown 圍欄也能解析', () => {
        const raw = '```json\n[{"charId": "c1", "content": "哈哈哈"}]\n```';
        expect(parseDirectorActions(raw)).toEqual([{ charId: 'c1', content: '哈哈哈' }]);
    });

    it('第二層：沒裹數組的單對象也能救回來', () => {
        const raw = '{"charId": "c1", "content": "就我一個人說話嗎"}';
        expect(parseDirectorActions(raw)).toEqual([{ charId: 'c1', content: '就我一個人說話嗎' }]);
    });

    it('第二層：數組整體損壞時逐個摳對象，壞的跳過好的保留', () => {
        const raw = '好的，以下是本輪群聊：[{"charId": "c1", "content": "第一條"}, {"charId": "c2", "content": "第二條"},]（生成完畢）';
        // 尾逗號讓整體 JSON.parse 失敗，但兩個對象都應被逐個救回
        expect(parseDirectorActions(raw)).toEqual([
            { charId: 'c1', content: '第一條' },
            { charId: 'c2', content: '第二條' },
        ]);
    });

    it('content 為數字 / charId 為數字時強轉 string，空 content 丟棄', () => {
        const raw = '[{"charId": 42, "content": 123}, {"charId": "c2", "content": "  "}]';
        expect(parseDirectorActions(raw)).toEqual([{ charId: '42', content: '123' }]);
    });

    it('完全無法解析時返回空數組而不是拋錯', () => {
        expect(parseDirectorActions('今天大家聊得很開心。')).toEqual([]);
        expect(parseDirectorActions('')).toEqual([]);
    });
});

describe('parseSummaryYaml', () => {
    it('標準 YAML 帶雙引號', () => {
        expect(parseSummaryYaml('summary: "群裡討論了貓的照片。"')).toBe('群裡討論了貓的照片。');
    });

    it('帶圍欄的 YAML', () => {
        expect(parseSummaryYaml('```yaml\nsummary: "大家一起吐槽天氣。"\n```')).toBe('大家一起吐槽天氣。');
    });

    it('多行內容（引號閉合配對，不會在中途截斷）', () => {
        const raw = 'summary: "第一行。\n第二行。"';
        expect(parseSummaryYaml(raw)).toBe('第一行。\n第二行。');
    });

    it('無引號裸值取到文末', () => {
        expect(parseSummaryYaml('summary: 群成員分享了新歌。')).toBe('群成員分享了新歌。');
    });

    it('第二層：完全沒有 summary 前綴時整段當正文', () => {
        expect(parseSummaryYaml('大家圍觀了一隻貓，氣氛輕鬆。')).toBe('大家圍觀了一隻貓，氣氛輕鬆。');
    });

    it('中文引號包裹時剝掉', () => {
        expect(parseSummaryYaml('summary: “今天聊了旅行計劃。”')).toBe('今天聊了旅行計劃。');
    });

    it('空輸入返回空串', () => {
        expect(parseSummaryYaml('')).toBe('');
    });
});

describe('parseGroupTopicBox', () => {
    it('第一層：標準 JSON', () => {
        expect(parseGroupTopicBox('{"title":"貓貓圍觀","summary":"群裡圍觀了一隻貓。"}'))
            .toEqual({ title: '貓貓圍觀', summary: '群裡圍觀了一隻貓。' });
    });

    it('第一層：帶 ```json 圍欄 + 前後廢話', () => {
        const raw = '好的：\n```json\n{"title":"旅行計劃","summary":"大家聊了去哪玩。"}\n```\n以上。';
        expect(parseGroupTopicBox(raw)).toEqual({ title: '旅行計劃', summary: '大家聊了去哪玩。' });
    });

    it('第一層：剝推理模型 <think> 塊', () => {
        const raw = '<think>我先想想標題</think>{"title":"深夜emo","summary":"半夜大家都睡不著。"}';
        expect(parseGroupTopicBox(raw)).toEqual({ title: '深夜emo', summary: '半夜大家都睡不著。' });
    });

    it('第二層：summary 裡有裸換行（嚴格 JSON.parse 會掛）也能摳出字段', () => {
        // 這正是線上"總結格式無法解析"的主因：字符串值裡帶真實換行
        const raw = '{"title":"復盤","summary":"第一段發生了A。\n第二段發生了B。"}';
        const parsed = parseGroupTopicBox(raw);
        expect(parsed?.title).toBe('復盤');
        expect(parsed?.summary).toContain('第一段發生了A。');
        expect(parsed?.summary).toContain('第二段發生了B。');
    });

    it('第二層：缺 title 時給默認標題', () => {
        const raw = '{"summary":"只有總結沒標題。"}';
        expect(parseGroupTopicBox(raw)).toEqual({ title: '一段群聊回憶', summary: '只有總結沒標題。' });
    });

    it('第三層：完全沒結構但有實質文本，整段兜底當總結', () => {
        const raw = '群裡今天聊了很多，氣氛不錯，大家分享了各自的近況。';
        expect(parseGroupTopicBox(raw)).toEqual({ title: '一段群聊回憶', summary: raw });
    });

    it('空 / 無實質內容返回 null', () => {
        expect(parseGroupTopicBox('')).toBeNull();
        expect(parseGroupTopicBox('```json\n```')).toBeNull();
        expect(parseGroupTopicBox('{}')).toBeNull();
    });
});
