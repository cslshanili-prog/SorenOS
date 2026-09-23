import { describe, expect, it } from 'vitest';
import {
    buildInPersonContinueInstruction,
    buildStoryContinueInstruction,
    MEETING_CONTINUE_DISPLAY_TEXT,
} from './meetingContinue';

describe('meeting continue instructions', () => {
    it('keeps the saved turn compact while framing companionship as real co-presence', () => {
        const prompt = buildInPersonContinueInstruction('阿明', '小白');

        expect(MEETING_CONTINUE_DISPLAY_TEXT).toBe('（繼續）');
        expect(prompt).toContain('阿明沒有主動說話');
        expect(prompt).toContain('仍然真實地待在同一物理空間');
        expect(prompt).toContain('面對面共處');
        expect(prompt).toContain('加強真實陪伴感');
        expect(prompt).toContain('不要擅自替阿明補寫新的主動行為');
    });

    it('hands plot initiative back without bypassing the active native preset', () => {
        const prompt = buildStoryContinueInstruction('林夏');

        expect(prompt).toContain('林夏沒有新增主動行為');
        expect(prompt).toContain('當前劇情已經啟用的原生預設');
        expect(prompt).toContain('文風、敘事視角、格式規則、轉述檔位');
        expect(prompt).toContain('“用戶執筆權”邊界');
        expect(prompt).toContain('其他角色的自身目標');
        expect(prompt).toContain('不要切換成普通聊天');
    });
});
