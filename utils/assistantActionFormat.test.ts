import { describe, expect, it } from 'vitest';
import { normalizeAssistantActionFormatting as normalize } from './assistantActionFormat';

describe('normalizeAssistantActionFormatting', () => {
    it.each(['[[SEND_EMOJI：咬你]]', '[[send_emoji: 咬你]]', '[凱恩 發送了表情包：咬你]'])('統一表情變體 %s 且重複處理不變', raw => {
        expect(normalize(raw)).toBe('[[SEND_EMOJI: 咬你]]');
        expect(normalize(normalize(raw))).toBe('[[SEND_EMOJI: 咬你]]');
    });

    it('修復單括號與展示態表情，並保持規範標籤冪等', () => {
        expect(normalize('[SEND_EMOJI: 開心]')).toBe('[[SEND_EMOJI: 開心]]');
        expect(normalize('[表情：小狗淚喪]')).toBe('[[SEND_EMOJI: 小狗淚喪]]');
        expect(normalize('[[SEND_EMOJI: 開心]]')).toBe('[[SEND_EMOJI: 開心]]');
    });

    it('修復轉帳 ACTION 的單括號，不碰普通轉帳敘述', () => {
        expect(normalize('[ACTION:TRANSFER|to=user|amount=520]'))
            .toBe('[[ACTION:TRANSFER|to=user|amount=520]]');
        expect(normalize('[ACTION:TRANSFER: 13]')).toBe('[[ACTION:TRANSFER:13]]');
        expect(normalize('[ACTION:TRANSFER_ACCEPT]')).toBe('[[ACTION:TRANSFER_ACCEPT]]');
        expect(normalize('我剛給你轉了 520，記得收')).toBe('我剛給你轉了 520，記得收');
    });

    it('修復 LIFE 單括號和生活記錄展示摘要', () => {
        expect(normalize('[LIFE:MED|布洛芬]')).toBe('[[LIFE:MED|布洛芬]]');
        expect(normalize('[生活記錄：支出 13（西瓜汁）]'))
            .toBe('[[LIFE:EXPENSE|13|西瓜汁]]');
        expect(normalize('[生活記錄：吃藥 · 布洛芬]')).toBe('[[LIFE:MED|布洛芬]]');
        expect(normalize('[生活記錄：鍛鍊 · 跑步 30分鐘]'))
            .toBe('[[LIFE:EXERCISE|跑步|30分鐘]]');
        expect(normalize('[生活記錄：生理期開始]')).toBe('[[LIFE:PERIOD_START]]');
    });

    it('不把帶歷史狀態的卡片或普通方括號文字變成副作用', () => {
        expect(normalize('[生活記錄：支出 13（西瓜汁）（已有記錄，未重複添加）]'))
            .toBe('[生活記錄：支出 13（西瓜汁）（已有記錄，未重複添加）]');
        expect(normalize('她發了一個開心表情')).toBe('她發了一個開心表情');
        expect(normalize('我看了[那本書]')).toBe('我看了[那本書]');
    });
});

describe('sticker history syntax recovery', () => {
    it.each(['[[你 發送了表情包: 咬你]]', '[[你發送了表情包：咬你]]', '[[發送了表情包: 咬你]]', '【你發送了表情包：咬你】', '［［SEND_EMOJI：咬你］］', '[[表情包：咬你]]', '[Noir 發送了表情包: 咬你]'])('repairs %s without nesting brackets', raw => {
        expect(normalize(raw)).toBe('[[SEND_EMOJI: 咬你]]');
        expect(normalize(normalize(raw))).toBe('[[SEND_EMOJI: 咬你]]');
    });
    it.each(['`[[你發送了表情包: 咬你]]`', '```text\n[[你發送了表情包: 咬你]]\n```', '[[你_發_送_了_表_情_包: 咬你]]', '[[S_E_N_D _ E_M_O_J_I: 咬你]]', '我剛才發送了表情包：咬你', '[你發送了表情包: 咬你]]'])('does not turn an explanation or incomplete token into a sticker: %s', raw => {
        expect(normalize(raw)).toBe(raw);
    });
    it('preserves multiple stickers, names with punctuation and neighboring text', () => {
        expect(normalize('先說一句[[你發送了表情包: 貓: 抱 抱!]]\n[[發送了表情包: 貓: 抱 抱!]]再說一句'))
            .toBe('先說一句[[SEND_EMOJI: 貓: 抱 抱!]]\n[[SEND_EMOJI: 貓: 抱 抱!]]再說一句');
    });
});

it('repairs adjacent stickers without skipping the second token', () => {
 expect(normalize('[[你發送了表情包: 甲]][[你發送了表情包: 乙]]')).toBe('[[SEND_EMOJI: 甲]][[SEND_EMOJI: 乙]]');
});

it.each(['[', '【', '［'])('preserves extra opening bracket %s and still repairs the next sticker', prefix => {
    const malformed = `${prefix}[[你發送了表情包: 甲]]`;
    expect(normalize(`${malformed}[[你發送了表情包: 乙]]`))
        .toBe(`${malformed}[[SEND_EMOJI: 乙]]`);
});

it('repairs adjacent mixed-width brackets at the start and after ordinary text', () => {
    const raw = '[表情: 甲]【表情：乙】［［SEND_EMOJI：丙］］';
    const expected = '[[SEND_EMOJI: 甲]][[SEND_EMOJI: 乙]][[SEND_EMOJI: 丙]]';
    expect(normalize(raw)).toBe(expected);
    expect(normalize(`正文${raw}`)).toBe(`正文${expected}`);
});
