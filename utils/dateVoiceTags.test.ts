import { describe, expect, it } from 'vitest';
import type { APIConfig } from '../types';
import { applyDateVoiceTags, parseDateBody, parseDateLine } from './dateVoiceTags';

const api = (patch: Partial<APIConfig>): APIConfig => ({ baseUrl: '', apiKey: '', model: '', ...patch } as APIConfig);

describe('parseDateLine', () => {
    it('台詞開頭的語氣標籤收進 tags，顯示時藏掉', () => {
        const line = parseDateLine('[lazy] [chuckles] 「再睡五分鐘。」');
        expect(line).toEqual({ text: '「再睡五分鐘。」', isDialogue: true, spoken: '再睡五分鐘。', tags: ['lazy', 'chuckles'] });
    });

    it('旁白不是台詞，沒有 spoken', () => {
        const line = parseDateLine('他把手邊的書合上。');
        expect(line.isDialogue).toBe(false);
        expect(line.spoken).toBe('');
        expect(line.tags).toEqual([]);
    });

    it('舊消息：行首立繪表情和行尾 [v:xxx] 都藏掉，[v:xxx] 當語氣標籤', () => {
        const line = parseDateLine('[happy] "……真的嗎？" [v:calm]');
        expect(line.text).toBe('"……真的嗎？"');
        expect(line.isDialogue).toBe(true);
        expect(line.spoken).toBe('……真的嗎？');
        expect(line.tags).toEqual(['happy', 'calm']);
        expect(parseDateLine('[normal] 指尖從髮梢滑落。').text).toBe('指尖從髮梢滑落。');
    });

    it('句中的標籤也藏掉；多段引號的台詞合併成一句念', () => {
        const line = parseDateLine('「好。」[sighs]「走吧。」');
        expect(line.text).toBe('「好。」「走吧。」');
        expect(line.spoken).toBe('好。 走吧。');
        expect(line.tags).toEqual(['sighs']);
    });

    it('中文方括號內容不當標籤', () => {
        expect(parseDateLine('[系統] 這行不動').text).toBe('[系統] 這行不動');
    });

    it('parseDateBody 丟掉空行和只有標籤的行', () => {
        expect(parseDateBody('[normal]\n\n他笑了。\n[softly] 「嗯。」').map(line => line.text)).toEqual(['他笑了。', '「嗯。」']);
    });
});

describe('applyDateVoiceTags', () => {
    it('ElevenLabs v3：任意英文標籤放回句首', () => {
        expect(applyDateVoiceTags('再睡五分鐘。', ['lazy', 'chuckles'], api({ ttsProvider: 'elevenlabs', elevenLabsModel: 'eleven_v3' })))
            .toEqual({ text: '[lazy] [chuckles] 再睡五分鐘。' });
    });

    it('ElevenLabs 其它模型：不帶標籤', () => {
        expect(applyDateVoiceTags('嗯。', ['lazy'], api({ ttsProvider: 'elevenlabs', elevenLabsModel: 'eleven_flash_v2_5' })))
            .toEqual({ text: '嗯。' });
    });

    it('魚聲：只留官方支援的', () => {
        expect(applyDateVoiceTags('嗯。', ['lazy', 'sighs', 'whispers'], api({ ttsProvider: 'fishaudio' })))
            .toEqual({ text: '[sighing] [whispering] 嗯。' });
    });

    it('MiniMax：不放進文字，認得的情緒當 emotion', () => {
        expect(applyDateVoiceTags('嗯。', ['lazy', 'calm'], api({ ttsProvider: 'minimax' }))).toEqual({ text: '嗯。', emotion: 'calm' });
        expect(applyDateVoiceTags('嗯。', ['lazy'], api({}))).toEqual({ text: '嗯。' });
    });
});
