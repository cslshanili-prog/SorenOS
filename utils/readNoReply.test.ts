import { describe, expect, it } from 'vitest';
import {
    buildCharDecidesPrompt, buildNoReplyNarration, buildResumeAfterNoReplyNote, classifyScheduleSlot,
    cleanGeneratedAutoReply, DEFAULT_AUTO_REPLY, extractNoReplyDirective, findActiveQuietSlot,
    pickAutoReplyText, resolveReadNoReply,
} from './readNoReply';
import type { QuietHoursSlot } from '../types';

// 2026-09-23 是週三
const at = (hhmm: string, date = '2026-09-23') => new Date(`${date}T${hhmm}:00`);

describe('classifyScheduleSlot', () => {
    it('睡覺、在忙，簡繁都認', () => {
        expect(classifyScheduleSlot({ activity: '睡覺' })).toBe('sleep');
        expect(classifyScheduleSlot({ activity: '午睡', emoji: '😴' })).toBe('sleep');
        expect(classifyScheduleSlot({ activity: '开会' })).toBe('busy');
        expect(classifyScheduleSlot({ activity: '上課', description: '微積分' })).toBe('busy');
        expect(classifyScheduleSlot({ activity: 'Team meeting' })).toBe('busy');
    });

    it('睡前、睡醒、不忙、幫忙不算', () => {
        expect(classifyScheduleSlot({ activity: '睡前讀書' })).toBeNull();
        expect(classifyScheduleSlot({ activity: '剛睡醒，賴床' })).toBeNull();
        expect(classifyScheduleSlot({ activity: '今天不忙，在家追劇' })).toBeNull();
        expect(classifyScheduleSlot({ activity: '去幫忙搬家' })).toBeNull();
        expect(classifyScheduleSlot({ activity: '散步' })).toBeNull();
        expect(classifyScheduleSlot(null)).toBeNull();
    });
});

describe('findActiveQuietSlot', () => {
    const weekday: QuietHoursSlot = { id: 'a', days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00', title: '上班' };
    const overnight: QuietHoursSlot = { id: 'b', days: [3], start: '23:00', end: '07:00' };

    it('同日時段含頭不含尾', () => {
        expect(findActiveQuietSlot([weekday], at('09:00'))?.id).toBe('a');
        expect(findActiveQuietSlot([weekday], at('11:59'))?.id).toBe('a');
        expect(findActiveQuietSlot([weekday], at('12:00'))).toBeNull();
        expect(findActiveQuietSlot([weekday], at('10:00', '2026-09-27'))).toBeNull(); // 週日
    });

    it('跨夜時段以開始那天為準', () => {
        expect(findActiveQuietSlot([overnight], at('23:30'))?.id).toBe('b');
        expect(findActiveQuietSlot([overnight], at('06:00', '2026-09-24'))?.id).toBe('b'); // 週四清晨，屬週三那段
        expect(findActiveQuietSlot([overnight], at('06:00'))).toBeNull(); // 週三清晨，屬週二（沒勾）
    });

    it('開始等於結束是整天；格式壞的跳過', () => {
        expect(findActiveQuietSlot([{ id: 'c', days: [3], start: '00:00', end: '00:00' }], at('15:00'))?.id).toBe('c');
        expect(findActiveQuietSlot([{ id: 'd', days: [3], start: '25:00', end: '26:00' }], at('15:00'))).toBeNull();
    });
});

describe('resolveReadNoReply', () => {
    it('沒開就不管', () => {
        expect(resolveReadNoReply(undefined, { activity: '睡覺' }, at('02:00'))).toBeNull();
        expect(resolveReadNoReply({ enabled: false }, { activity: '睡覺' }, at('02:00'))).toBeNull();
    });

    it('日程忙碌：預設強制，開了由角色決定就交給角色', () => {
        expect(resolveReadNoReply({ enabled: true }, { activity: '開會' }, at('10:00')))
            .toEqual({ mode: 'force', state: 'busy', reason: '開會' });
        expect(resolveReadNoReply({ enabled: true, charDecides: true }, { activity: '睡覺' }, at('02:00')))
            .toEqual({ mode: 'charDecides', state: 'sleep', reason: '睡覺' });
    });

    it('不回訊時段永遠強制，即使由角色決定', () => {
        const d = resolveReadNoReply({
            enabled: true, charDecides: true,
            quietSlots: [{ id: 'a', days: [3], start: '09:00', end: '12:00', title: '午休' }],
        }, { activity: '散步' }, at('10:00'));
        expect(d).toEqual({ mode: 'force', state: 'normal', reason: '午休' });
    });

    it('日程沒命中也沒時段就照常回', () => {
        expect(resolveReadNoReply({ enabled: true }, { activity: '散步' }, at('10:00'))).toBeNull();
    });
});

describe('auto reply text', () => {
    it('該狀態 → 普通 → 內建預設', () => {
        expect(pickAutoReplyText({ enabled: true, busyText: '開會中' }, 'busy')).toBe('開會中');
        expect(pickAutoReplyText({ enabled: true, normalText: '等等回你' }, 'sleep')).toBe('等等回你');
        expect(pickAutoReplyText({ enabled: true }, 'sleep')).toBe(DEFAULT_AUTO_REPLY.sleep);
    });

    it('旁白與恢復提醒', () => {
        expect(buildNoReplyNarration('Susu', { state: 'busy', reason: '開會' })).toBe('[系統: Susu 已讀，正在開會，暫時沒有回覆]');
        expect(buildResumeAfterNoReplyNote({ readNoReply: { state: 'sleep' } })).toContain('在睡覺');
        expect(buildResumeAfterNoReplyNote(undefined)).toBe('');
    });

    it('清理副 API 寫的自動回覆', () => {
        expect(cleanGeneratedAutoReply('「[會議中] 稍後回」\n解釋')).toBe('[會議中] 稍後回');
        expect(cleanGeneratedAutoReply('')).toBeNull();
        expect(cleanGeneratedAutoReply('很'.repeat(41))).toBeNull();
    });
});

describe('NO_REPLY 標籤與提示詞', () => {
    it('剝掉標籤，帶不帶自動回覆都認', () => {
        expect(extractNoReplyDirective('[[ACTION:NO_REPLY]]')).toEqual({ cleanedText: '', noReply: true });
        expect(extractNoReplyDirective('[[ACTION：已讀不回｜「在洗澡」]]')).toEqual({ cleanedText: '', noReply: true, autoReply: '在洗澡' });
        expect(extractNoReplyDirective('普通回覆')).toEqual({ cleanedText: '普通回覆', noReply: false });
    });

    it('由角色決定的提示詞依是否 AI 生成教不同寫法', () => {
        const decision = { mode: 'charDecides' as const, state: 'busy' as const, reason: '開會' };
        expect(buildCharDecidesPrompt(decision, false)).toContain('[[ACTION:NO_REPLY]]');
        expect(buildCharDecidesPrompt(decision, true)).toContain('[[ACTION:NO_REPLY|自動回覆內容]]');
    });
});
