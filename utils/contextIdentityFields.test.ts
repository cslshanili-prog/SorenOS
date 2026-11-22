import { describe, expect, it } from 'vitest';
import { ContextBuilder } from './context';

// 私聊身份段裡名字底下那幾行（plans/character-identity-fields.md 3.4）。
// 以前是固定一行「用戶備註/愛稱 (User Note/Nickname): …」，同一格在群聊又被當角色簡介讀。

const user = { name: '測試用戶', bio: '' } as any;
const char = (extra: Record<string, unknown> = {}) => ({ id: 'c1', name: '陸薇寧', systemPrompt: '你是陸薇寧。', description: '', ...extra }) as any;
const identityOf = (c: any) => {
    const core = ContextBuilder.buildCoreContext(c, user, true);
    const start = core.indexOf('### 你的身份 (Character)');
    return core.slice(start, core.indexOf('- 核心性格/指令:', start));
};

describe('私聊身份段：別名、身份、簡介', () => {
    it('三格都沒填：只有名字，不再出「用戶備註/愛稱: 無」', () => {
        expect(identityOf(char())).toBe('### 你的身份 (Character)\n- 名字: 陸薇寧\n');
    });

    it('只有簡介（舊資料都長這樣）：標成簡介，帶一句「跟核心設定衝突以核心設定為準」', () => {
        const text = identityOf(char({ description: '快樂小狗' }));
        expect(text).toContain('- 名字: 陸薇寧\n- 簡介: 快樂小狗\n');
        expect(text).toContain('以核心設定為準');
        expect(text).not.toContain('用戶備註');
        expect(text).not.toContain('User Note');
    });

    it('三格都填：名字、別名、身份、簡介依序', () => {
        const text = identityOf(char({ aliases: ['Vivian', '陸姐'], roleTitle: 'Cos 圈的前輩', description: '嘴甜心硬' }));
        expect(text).toContain('- 名字: 陸薇寧\n- 別名: Vivian、陸姐\n- 身份: Cos 圈的前輩\n- 簡介: 嘴甜心硬\n');
    });

    it('人設還在後面', () => {
        expect(ContextBuilder.buildCoreContext(char({ roleTitle: '攝影師' }), user, true)).toContain('- 身份: 攝影師\n- 核心性格/指令:\n你是陸薇寧。');
    });
});
