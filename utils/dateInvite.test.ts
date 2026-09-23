import { describe, expect, it } from 'vitest';
import { buildDateInviteResponseNote, describeDateInvite, extractDateInvite, formatDateInviteRecord } from './dateInvite';

describe('extractDateInvite', () => {
    it('剝掉標籤、取地點和事由', () => {
        const r = extractDateInvite('週末要不要出來走走？\n[[ACTION:DATE_INVITE|河堤公園|傍晚散步]]');
        expect(r.cleanedText).toBe('週末要不要出來走走？');
        expect(r.invite).toEqual({ place: '河堤公園', plan: '傍晚散步' });
    });

    it('認中文別名、全形標點、引號，事由可省', () => {
        expect(extractDateInvite('[[ACTION：約見面｜「老地方」]]').invite).toEqual({ place: '老地方', plan: '' });
    });

    it('多個標籤只取第一個，全部剝掉', () => {
        const r = extractDateInvite('a[[ACTION:DATE_INVITE|咖啡店|聊天]]b[[ACTION:DATE_INVITE|海邊|看夕陽]]');
        expect(r.cleanedText).toBe('ab');
        expect(r.invite?.place).toBe('咖啡店');
    });

    it('空標籤剝掉但不算邀請；沒有標籤原樣返回', () => {
        expect(extractDateInvite('嗯[[ACTION:DATE_INVITE]]')).toEqual({ cleanedText: '嗯', invite: null });
        expect(extractDateInvite('普通訊息')).toEqual({ cleanedText: '普通訊息', invite: null });
    });

    it('不認歷史記錄形態（照抄記錄不會再落一張卡）', () => {
        expect(extractDateInvite('[[記錄:DATE_INVITE|from=char|place=海邊|status=等對方回應]]').invite).toBeNull();
    });
});

describe('邀請卡的文字', () => {
    it('歷史記錄帶狀態', () => {
        expect(formatDateInviteRecord({ place: '海邊', plan: '看夕陽', status: 'accepted' }))
            .toBe('[[記錄:DATE_INVITE|from=char|place=海邊|plan=看夕陽|status=對方已赴約]]');
        expect(formatDateInviteRecord(undefined)).toBe('[[記錄:DATE_INVITE|from=char|status=等對方回應]]');
    });

    it('摘要與旁白', () => {
        expect(describeDateInvite({ place: '海邊', plan: '看夕陽' })).toBe('[見面邀約] 海邊・看夕陽');
        expect(describeDateInvite({})).toBe('[見面邀約]');
        expect(buildDateInviteResponseNote(false, '小雨', '阿澈')).toBe('[系統: 小雨婉拒了阿澈這次的見面邀約]');
    });
});
