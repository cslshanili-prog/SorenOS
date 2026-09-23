import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SongSheet } from '../types';
import { ContextBuilder } from './context';
import {
    buildLyricNotebookContext,
    extractGeneratedLyricLine,
    getLyricCoWritingStyle,
    LYRIC_CO_WRITING_STYLES,
    SongPrompts,
} from './songPrompts';

const makeSong = (overrides: Partial<SongSheet> = {}): SongSheet => ({
    id: 'song-1',
    title: '站台雨',
    genre: 'pop',
    mood: 'nostalgic',
    collaboratorId: 'char-1',
    lines: [],
    comments: [],
    status: 'draft',
    coverStyle: 'linen',
    createdAt: 1,
    lastActiveAt: 1,
    lyricTemplate: 'short-hook',
    lyricCoWritingStyle: 'adaptive',
    ...overrides,
});

describe('song lyric prompt context', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('shows every fixed-template slot, including blanks and stable line numbers', () => {
        const context = buildLyricNotebookContext(makeSong({
            lines: [{
                id: 'line-3',
                authorId: 'user',
                content: '雨停在舊站台',
                section: 'chorus',
                slotIndex: 2,
                timestamp: 2,
            }],
        }));

        expect(context).toContain('共12句，已填1句，空11句');
        expect(context).toContain('[第1段·副歌 1｜第1-4句｜每句建議6-10字]');
        expect(context).toContain('第1句（段內1/4）：〈待寫〉');
        expect(context).toContain('第3句（段內3/4，6字，用戶寫）：雨停在舊站台');
        expect(context).toContain('[第3段·副歌 2｜第9-12句｜每句建議6-10字]');
    });

    it('uses the custom template rather than silently falling back to free writing', () => {
        const context = buildLyricNotebookContext(makeSong({
            lyricTemplate: 'custom',
            customLyricTemplate: [
                { section: 'intro', lines: 1, chars: '4-6' },
                { section: 'verse', lines: 2, chars: '8-10' },
            ],
        }));

        expect(context).toContain('共3句');
        expect(context).toContain('[第1段·前奏/引入｜第1-1句｜每句建議4-6字]');
        expect(context).toContain('[第2段·主歌｜第2-3句｜每句建議8-10字]');
    });

    it('injects the selected co-writing grammar into the system prompt', () => {
        vi.spyOn(ContextBuilder, 'buildCoreContext').mockReturnValue('CHARACTER CONTEXT');
        const song = makeSong({ lyricCoWritingStyle: 'vocaloid' });
        const prompt = SongPrompts.buildMentorSystemPrompt(
            { id: 'char-1', name: 'C' } as any,
            { name: 'U' } as any,
            song,
            [],
        );

        expect(prompt).toContain('C 的共創風格：Vocaloid');
        expect(prompt).toContain('數字/機械/身體錯位等異色意象');
        expect(prompt).toContain('指定第幾句時，只重寫那一句');
        expect(prompt).toContain('只輸出一個合法 JSON 對象');
    });

    it('keeps discussion separate from the notebook and states one current task', () => {
        const prompt = SongPrompts.buildUserMessage(makeSong({
            comments: [{
                id: 'comment-1',
                authorId: 'user',
                type: 'reaction',
                content: '副歌想更克制一點',
                timestamp: 3,
            }],
        }), '只生成第2句', 'chorus');

        expect(prompt).toContain('最近的討論（僅作對話上下文，不等於歌詞）');
        expect(prompt).toContain('用戶：副歌想更克制一點');
        expect(prompt).toContain('【本輪唯一任務】\n只生成第2句');
    });

    it('anchors the completion note in the full character context instead of a generic mentor role', () => {
        const buildCoreContext = vi.spyOn(ContextBuilder, 'buildCoreContext')
            .mockReturnValue('CHARACTER CONTEXT WITH RELATIONSHIP');
        const systemPrompt = SongPrompts.buildCompletionSystemPrompt(
            { id: 'char-1', name: 'C' } as any,
            { name: 'U' } as any,
        );

        expect(buildCoreContext).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'C' }),
            expect.objectContaining({ name: 'U' }),
            true,
        );
        expect(systemPrompt).toContain('CHARACTER CONTEXT WITH RELATIONSHIP');
        expect(systemPrompt).toContain('不是老師批作業、評委寫鑑定');
        expect(systemPrompt).toContain('完整角色設定、你和U的關係、相處方式與既有記憶');
        expect(systemPrompt).toContain('不要使用“作為你的導師”');
    });

    it('keeps the completed song and recent collaboration in the user task', () => {
        const prompt = SongPrompts.buildCompletionPrompt(
            { id: 'char-1', name: 'C' } as any,
            { name: 'U' } as any,
            makeSong({
                lines: [{
                    id: 'line-1',
                    authorId: 'user',
                    content: '雨停在舊站台',
                    section: 'chorus',
                    slotIndex: 0,
                    timestamp: 2,
                }],
                comments: [{
                    id: 'comment-1',
                    authorId: 'char-1',
                    type: 'suggestion',
                    content: '副歌別急著把答案說完。',
                    timestamp: 3,
                }],
            }),
        );

        expect(prompt).toContain('雨停在舊站台');
        expect(prompt).toContain('C：副歌別急著把答案說完。');
        expect(prompt).toContain('直接以C的口吻對U說3-4句話');
        expect(prompt).not.toContain('你是C');
    });

    it('exposes a useful set of distinct co-writing styles', () => {
        expect(LYRIC_CO_WRITING_STYLES).toHaveLength(25);
        expect(new Set(LYRIC_CO_WRITING_STYLES.map(style => style.id)).size).toBe(25);
        expect(getLyricCoWritingStyle('jpop').prompt).toContain('日語翻譯腔');
        expect(getLyricCoWritingStyle('kpop').prompt).toContain('Killing Part');
        expect(getLyricCoWritingStyle('hiphop').prompt).toContain('多音節雙押或三押');
        expect(getLyricCoWritingStyle('anime-ed').category).toBe('acg');
        expect(getLyricCoWritingStyle('alt-pop').category).toBe('western');
    });

    it('does not overclaim melody-dependent tone matching', () => {
        expect(getLyricCoWritingStyle('cantopop').prompt).toContain('沒有逐音旋律或音高走向');
        expect(getLyricCoWritingStyle('cantopop').prompt).toContain('不得聲稱已完成九聲六調適配');
        expect(getLyricCoWritingStyle('guofeng').prompt).toContain('五聲調式不直接決定漢字聲調');
        expect(getLyricCoWritingStyle('vocaloid').prompt).toContain('不假定必須 180–220');
    });
});

describe('generated lyric response hardening', () => {
    it('extracts one lyric from a valid inspiration response', () => {
        expect(extractGeneratedLyricLine(JSON.stringify({
            type: 'inspiration',
            reaction: '這一句可以收緊。',
            example_lines: ['雨把站牌擦得很舊'],
            explanation: '承接上一句。',
        }))).toBe('雨把站牌擦得很舊');
    });

    it('recovers a lyric string from JSON truncated after example_lines', () => {
        const truncated = '{"type":"inspiration","reaction":"好","example_lines":["燈滅以後影子還醒著"],"explanation":"';
        expect(extractGeneratedLyricLine(truncated)).toBe('燈滅以後影子還醒著');
    });

    it('rejects JSON fragments before a lyric field instead of saving metadata', () => {
        expect(extractGeneratedLyricLine('{\n  "type": "inspiration",\n  "reaction":')).toBeNull();
        expect(extractGeneratedLyricLine('{"type":"inspiration","reaction":"讓我想想"')).toBeNull();
    });

    it('accepts a plain one-line fallback but rejects explanations and multi-line prose', () => {
        expect(extractGeneratedLyricLine('“咖啡涼在沒說完的清晨”')).toBe('咖啡涼在沒說完的清晨');
        expect(extractGeneratedLyricLine('歌詞：咖啡涼在沒說完的清晨')).toBeNull();
        expect(extractGeneratedLyricLine('這句可以這樣寫：\n咖啡涼在沒說完的清晨')).toBeNull();
    });

    it('rejects structured fields masquerading as a lyric candidate', () => {
        expect(extractGeneratedLyricLine(JSON.stringify({
            type: 'inspiration',
            content: '{"type":"inspiration","reaction":',
        }))).toBeNull();
        expect(extractGeneratedLyricLine(JSON.stringify({
            type: 'inspiration',
            example_lines: ['example_lines: ["並不存在的歌詞"]'],
        }))).toBeNull();
    });
});
