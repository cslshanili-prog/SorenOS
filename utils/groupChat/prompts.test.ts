import { describe, it, expect } from 'vitest';
import {
    buildDirectorInstruction,
    buildGroupHistoryBlock,
    buildRoundRobinInstruction,
    DEFAULT_MAX_ROUND_MESSAGES,
    GROUP_HISTORY_GAP_THRESHOLD_MS,
} from './prompts';
import type { Message, CharacterProfile } from '../../types';

const char = (id: string, name: string): CharacterProfile => ({ id, name } as CharacterProfile);

const msg = (id: number, role: Message['role'], content: string, timestamp: number, charId = ''): Message =>
    ({ id, role, type: 'text', content, timestamp, charId } as Message);

describe('buildGroupHistoryBlock 時間跳變分隔行', () => {
    const chars = [char('c1', '小夏')];
    const base = Date.UTC(2026, 6, 1, 12, 0, 0);

    it('相鄰消息隔得久時插一條"隔了約 N 天"的分隔行', () => {
        const msgs: Message[] = [
            msg(1, 'assistant', '在嗎', base, 'c1'),
            // 3 天后用戶回來發一句
            msg(2, 'user', '我回來了', base + 3 * 24 * 60 * 60 * 1000),
        ];
        const { text } = buildGroupHistoryBlock(msgs, chars, [], '用戶');
        expect(text).toContain('約 3 天');
        expect(text).toContain('中間群裡沒人說話');
        // 分隔行應夾在兩條消息之間
        expect(text.indexOf('小夏: 在嗎')).toBeLessThan(text.indexOf('約 3 天'));
        expect(text.indexOf('約 3 天')).toBeLessThan(text.indexOf('用戶: 我回來了'));
    });

    it('間隔在閾值以內不插分隔行', () => {
        const msgs: Message[] = [
            msg(1, 'assistant', '早', base, 'c1'),
            msg(2, 'user', '早呀', base + 60 * 1000),
        ];
        const { text } = buildGroupHistoryBlock(msgs, chars, [], '用戶');
        expect(text).not.toContain('中間群裡沒人說話');
        expect(text).toContain('小夏: 早');
        expect(text).toMatch(/\[(?:[刚剛][刚剛]|[约約] .+前)\] 小夏: 早/);
        expect(text).toContain('用戶: 早呀');
    });

    it('閾值常量為 3 小時', () => {
        expect(GROUP_HISTORY_GAP_THRESHOLD_MS).toBe(3 * 60 * 60 * 1000);
    });
});

describe('buildGroupHistoryBlock 識圖 API', () => {
    it('接入時使用文字描述，不再附帶 image_url 原圖', () => {
        const image = {
            ...msg(10, 'user', 'data:image/jpeg;base64,AAAA', Date.now()),
            type: 'image' as const,
            metadata: { visionDescription: '三個人在海邊舉著寫有生日快樂的橫幅。' },
        };
        const history = buildGroupHistoryBlock(
            [image],
            [char('c1', '小夏')],
            [],
            '用戶',
            3,
            { useVisionDescriptions: true },
        );

        expect(history.text).toContain('[圖片：三個人在海邊舉著寫有生日快樂的橫幅。]');
        expect(history.attachedImages).toEqual([]);
        expect(history.attachedImagesNote).toBe('');
        expect(history.text).not.toContain('data:image');
    });
});

describe('群聊中的 U 與關係連續性', () => {
    const history = { text: '用戶: 今天大家聊什麼？', attachedImages: [], attachedImagesNote: '' };

    it('導演模式堅持群像，但不會因切換場景重置角色與 U 的關係', () => {
        const prompt = buildDirectorInstruction(history, '無');

        expect(prompt).toContain('群像優先，不等於忽視用戶');
        expect(prompt).toContain('U 還是 U');
        expect(prompt).toContain('關係不能因場景切換而重置');
        expect(prompt).toContain('不要自動全員跟隊');
        expect(prompt).toContain('不要讓所有人重複同一種態度');
    });

    it('輪詢模式允許自然沉默，並要求成員從自己與 U 的關係出發', () => {
        const prompt = buildRoundRobinInstruction('小夏', history, '無');

        expect(prompt).toContain('只輸出 `[[SKIP]]` 保持沉默');
        expect(prompt).toContain('U 還是 U');
        expect(prompt).toContain('不能因進入群聊就重置關係');
        expect(prompt).toContain('按你自己和 U 的關係反應');
    });
});

describe('導演模式一輪最多幾條：maxRoundMessages 選項', () => {
    const history = { text: '小夏: 今天天氣不錯', attachedImages: [], attachedImagesNote: '' };

    it('不傳時用默認值（DEFAULT_MAX_ROUND_MESSAGES）', () => {
        const prompt = buildDirectorInstruction(history, '無');
        expect(prompt).toContain(`1 到 ${DEFAULT_MAX_ROUND_MESSAGES} 條`);
    });

    it('傳了 maxRoundMessages 時用群裡配置的那個數，不用默認值', () => {
        const prompt = buildDirectorInstruction(history, '無', { maxRoundMessages: 8 });
        expect(prompt).toContain('1 到 8 條');
        expect(prompt).not.toContain(`1 到 ${DEFAULT_MAX_ROUND_MESSAGES} 條`);
    });

    it('下限固定是 1，不受 maxRoundMessages 影響', () => {
        const prompt = buildDirectorInstruction(history, '無', { maxRoundMessages: 2 });
        expect(prompt).toContain('1 到 2 條');
    });
});

describe('角色可以退群：allowMemberLeave 選項', () => {
    const history = { text: '小夏: 今天天氣不錯', attachedImages: [], attachedImagesNote: '' };

    it('不傳時不教 [[ACTION:LEAVE_GROUP]] 語法（默認關閉）', () => {
        expect(buildDirectorInstruction(history, '無')).not.toContain('LEAVE_GROUP');
        expect(buildRoundRobinInstruction('小夏', history, '無')).not.toContain('LEAVE_GROUP');
    });

    it('allowMemberLeave: true 時導演/輪詢模式都教退群語法', () => {
        const directorPrompt = buildDirectorInstruction(history, '無', { allowMemberLeave: true });
        expect(directorPrompt).toContain('[[ACTION:LEAVE_GROUP]]');
        expect(directorPrompt).toContain('極其罕見');

        const roundRobinPrompt = buildRoundRobinInstruction('小夏', history, '無', { allowMemberLeave: true });
        expect(roundRobinPrompt).toContain('[[ACTION:LEAVE_GROUP]]');
    });

    it('allowMemberLeave: false 等價於不傳', () => {
        expect(buildDirectorInstruction(history, '無', { allowMemberLeave: false })).not.toContain('LEAVE_GROUP');
    });
});

describe('隱身圍觀模式：userLurking 選項', () => {
    const history = { text: '小夏: 今天天氣不錯', attachedImages: [], attachedImagesNote: '' };

    it('不傳 userLurking 時不注入圍觀說明（默認行為不變）', () => {
        expect(buildDirectorInstruction(history, '無')).not.toContain('隱身圍觀模式');
        expect(buildRoundRobinInstruction('小夏', history, '無')).not.toContain('隱身圍觀模式');
    });

    it('userLurking: true 時導演/輪詢模式都注入"用戶不在場"說明，且禁用 PRIVATE', () => {
        const directorPrompt = buildDirectorInstruction(history, '無', { userLurking: true });
        expect(directorPrompt).toContain('隱身圍觀模式');
        expect(directorPrompt).toContain('用戶沒有出現在上面的聊天記錄裡');
        expect(directorPrompt).toContain('本輪禁止使用 PRIVATE 私聊語法');

        const roundRobinPrompt = buildRoundRobinInstruction('小夏', history, '無', { userLurking: true });
        expect(roundRobinPrompt).toContain('隱身圍觀模式');
        expect(roundRobinPrompt).toContain('本輪禁止使用 PRIVATE 私聊語法');
    });

    it('userLurking: false 等價於不傳', () => {
        expect(buildDirectorInstruction(history, '無', { userLurking: false })).not.toContain('隱身圍觀模式');
    });
});

describe('NPC 成員與旁觀劇情方向', () => {
    const history = { text: '小夏: 今天天氣不錯', attachedImages: [], attachedImagesNote: '' };

    it('導演模式：有 NPC 才加 NPC 說明', () => {
        expect(buildDirectorInstruction(history, '無')).not.toContain('#### NPC 成員');
        expect(buildDirectorInstruction(history, '無', { npcNames: ['房東'] })).toContain('房東 是群裡的 NPC 配角');
    });

    it('輪詢模式以 NPC 身份：不教 PRIVATE、不教退群、關係以檔案為準', () => {
        const prompt = buildRoundRobinInstruction('房東', history, '無', { asNpc: true, allowMemberLeave: true });
        expect(prompt).toContain('不要用 PRIVATE');
        expect(prompt).not.toContain('[[PRIVATE: 內容]]');
        expect(prompt).not.toContain('LEAVE_GROUP');
        expect(prompt).toContain('以你 NPC 成員檔案裡寫的為準');
        expect(prompt).not.toContain('私聊空窗期');
        // 角色照舊
        expect(buildRoundRobinInstruction('小夏', history, '無')).toContain('[[PRIVATE: 內容]]');
    });

    it('劇情方向：有才注入，兩種模式都帶，並提醒不要照抄', () => {
        expect(buildDirectorInstruction(history, '無')).not.toContain('劇情方向');
        const director = buildDirectorInstruction(history, '無', { plotDirection: '小雨說漏嘴' });
        expect(director).toContain('【劇情方向');
        expect(director).toContain('小雨說漏嘴');
        expect(buildRoundRobinInstruction('小夏', history, '無', { plotDirection: '  ' })).not.toContain('劇情方向');
        expect(buildRoundRobinInstruction('小夏', history, '無', { plotDirection: '下雨了' })).toContain('下雨了');
    });

    it('群歷史認得 NPC 的名字', () => {
        const block = buildGroupHistoryBlock([msg(1, 'assistant', '交房租', 0, 'n1')], [char('c1', '小夏'), { id: 'n1', name: '房東' }], []);
        expect(block.text).toContain('房東: 交房租');
    });
});
