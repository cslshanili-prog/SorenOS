import { describe, it, expect } from 'vitest';
import { DatePrompts, DATE_STYLE_PRESETS, DATE_VOICE_GUIDE } from './datePrompts';
import type { CharacterProfile, UserProfile, Message, MountedWorldbook } from '../types';

const makeChar = (overrides: Partial<CharacterProfile> = {}): CharacterProfile => ({
    id: 'char-1',
    name: '小白',
    avatar: '',
    description: '',
    systemPrompt: '你是小白，一個溫柔的角色。',
    memories: [],
    ...overrides,
} as CharacterProfile);

const user: UserProfile = { name: '阿明', bio: '' } as UserProfile;

let msgId = 1;
const makeMsg = (overrides: Partial<Message> = {}): Message => ({
    id: msgId++,
    charId: 'char-1',
    role: 'user',
    type: 'text',
    content: '你好',
    timestamp: Date.now(),
    ...overrides,
});

const sysOf = (messages: Array<{ role: string; content: any }>): string => {
    const sys = messages.find(m => m.role === 'system');
    return typeof sys?.content === 'string' ? sys.content : '';
};

describe('DatePrompts.buildSessionPayload', () => {
    const baseInput = (char: CharacterProfile) => ({
        char,
        userProfile: user,
        allMsgs: [makeMsg({ role: 'assistant', content: '[normal] 開場白' }), makeMsg({ content: '我來了' })],
        emojis: [],
        userText: '我來了',
        variant: 'send' as const,
    });

    it('默認注入電影感風格塊，不注入人稱塊', async () => {
        const { messages } = await DatePrompts.buildSessionPayload(baseInput(makeChar()));
        const sys = sysOf(messages);
        expect(sys).toContain('風格：電影感');
        expect(sys).toContain('散文敘事');
        expect(sys).not.toContain('敘事人稱');
    });

    it('按 dateStyleConfig.style 切換風格塊', async () => {
        for (const preset of DATE_STYLE_PRESETS) {
            const char = makeChar({ dateStyleConfig: { style: preset.id } });
            const { messages } = await DatePrompts.buildSessionPayload(baseInput(char));
            expect(sysOf(messages)).toContain(`風格：${preset.label}`);
        }
    });

    it('pov=third-name 注入雙名字人稱規則', async () => {
        const char = makeChar({ dateStyleConfig: { pov: 'third-name' } });
        const { messages } = await DatePrompts.buildSessionPayload(baseInput(char));
        const sys = sysOf(messages);
        expect(sys).toContain('敘事人稱');
        expect(sys).toContain('小白看向阿明');
    });

    it('pov=third-you / first-you 注入對應示例', async () => {
        const thirdYou = await DatePrompts.buildSessionPayload(baseInput(makeChar({ dateStyleConfig: { pov: 'third-you' } })));
        expect(sysOf(thirdYou.messages)).toContain('小白看向你');
        const firstYou = await DatePrompts.buildSessionPayload(baseInput(makeChar({ dateStyleConfig: { pov: 'first-you' } })));
        expect(sysOf(firstYou.messages)).toContain('我看向你');
    });

    it('extra 自定義補充原樣進入提示詞', async () => {
        const char = makeChar({ dateStyleConfig: { extra: '不要寫心理活動，多寫對話。' } });
        const { messages } = await DatePrompts.buildSessionPayload(baseInput(char));
        const sys = sysOf(messages);
        expect(sys).toContain('額外要求');
        expect(sys).toContain('不要寫心理活動，多寫對話。');
    });

    it('細節深挖默認開啟：方法塊進 system，聚焦線索進末尾 note；關閉後兩者都消失', async () => {
        const on = await DatePrompts.buildSessionPayload(baseInput(makeChar()));
        expect(sysOf(on.messages)).toContain('深挖，別填充');
        expect(on.messages[on.messages.length - 1].content).toContain('本輪線索');

        const off = await DatePrompts.buildSessionPayload(baseInput(makeChar({ dateStyleConfig: { digDeeper: false } })));
        expect(sysOf(off.messages)).not.toContain('深挖，別填充');
        expect(off.messages[off.messages.length - 1].content).not.toContain('本輪線索');
        // ContextBuilder 的全 App 通用精簡版（表達底線）不受 digDeeper 開關影響，常駐
        expect(sysOf(off.messages)).toContain('表達底線');
    });

    it('消息結構為 [system, ...history, user]，末尾帶 System Note；reroll 的 note 不同', async () => {
        const send = await DatePrompts.buildSessionPayload(baseInput(makeChar()));
        expect(send.messages[0].role).toBe('system');
        const lastSend = send.messages[send.messages.length - 1];
        expect(lastSend.role).toBe('user');
        expect(lastSend.content).toContain('我來了');
        expect(lastSend.content).toContain('System Note');
        expect(lastSend.content).not.toContain('Reroll');

        const reroll = await DatePrompts.buildSessionPayload({ ...baseInput(makeChar()), variant: 'reroll' });
        const lastReroll = reroll.messages[reroll.messages.length - 1];
        expect(lastReroll.content).toContain('Reroll');
    });

    it('沒有模塊狀態時，Date system prompt 不增加 SAR 文本或輸出容器', async () => {
        const { messages } = await DatePrompts.buildSessionPayload({
            ...baseInput(makeChar({ vrState: { enabled: true, intervalMinutes: 120 } })),
            userProfile: { ...user, vrState: { enabled: true } },
        });
        const sys = sysOf(messages);
        expect(sys).not.toContain('### SAR 臨時模塊');
        expect(sys).not.toContain('<SAR_MODULE_OUTPUT>');
    });
});

describe('散文格式與語氣標籤', () => {
    const baseInput = (char: CharacterProfile) => ({
        char,
        userProfile: user,
        allMsgs: [makeMsg({ content: '我來了', metadata: { source: 'date' } })],
        emojis: [],
        userText: '我來了',
        variant: 'send' as const,
    });

    it('不再要求立繪表情標籤，也沒有觀測協議', async () => {
        const { messages } = await DatePrompts.buildSessionPayload(baseInput(makeChar()));
        const sys = sysOf(messages);
        expect(sys).toContain('散文敘事');
        expect(sys).not.toContain('[emotion]');
        expect(sys).not.toContain('OBSERVE');
        for (const preset of DATE_STYLE_PRESETS) expect(preset.block).not.toMatch(/^\[(normal|happy|shy|angry|sad)\]/m);
        const note = messages[messages.length - 1].content as string;
        expect(note).not.toContain('[emotion]');
        expect(note).not.toContain('語氣標籤');
    });

    it('開了見面語音才教台詞開頭的英文語氣標籤', async () => {
        const off = await DatePrompts.buildSessionPayload(baseInput(makeChar()));
        expect(sysOf(off.messages)).not.toContain(DATE_VOICE_GUIDE);
        const on = await DatePrompts.buildSessionPayload(baseInput(makeChar({ dateVoiceEnabled: true })));
        expect(sysOf(on.messages)).toContain(DATE_VOICE_GUIDE);
        expect(on.messages[on.messages.length - 1].content).toContain('語氣標籤');
    });
});

describe('見面裡的世界書', () => {
    const wb = (overrides: Partial<MountedWorldbook>): MountedWorldbook => ({
        id: 'wb', title: '條目', content: '條目正文', category: '測試', ...overrides,
    });
    const history = () => [
        makeMsg({ role: 'assistant', content: '[normal] 開場白' }),
        makeMsg({ content: '第二句' }),
        makeMsg({ role: 'assistant', content: '[happy] 第三句' }),
        makeMsg({ content: '我來了' }),
    ];
    const sessionInput = (char: CharacterProfile, userText = '我來了') => ({
        char, userProfile: user, allMsgs: history(), emojis: [], userText, variant: 'send' as const,
    });
    const contents = (messages: Array<{ content: any }>) => messages.map(m => String(m.content));

    it('會話：「聊天記錄指定深度」條目按深度插進對話，本輪 user 消息算最後一條', async () => {
        const char = makeChar({
            mountedWorldbooks: [
                wb({ id: 'tail', content: '深度零的文風', position: 4, depth: 0, role: 0 }),
                wb({ id: 'deep', content: '深度二的思考要求', position: 4, depth: 2, role: 0 }),
            ],
        });
        const { messages } = await DatePrompts.buildSessionPayload(sessionInput(char));
        const texts = contents(messages);

        // 深度 0：放在本輪 user 消息之後，整條請求的最後
        const tail = messages[messages.length - 1];
        expect(tail).toEqual({ role: 'system', content: '深度零的文風' });
        expect(messages[messages.length - 2].content).toContain('System Note');

        // 深度 2：插在倒數第 2 條對話之前（[開場白, 第二句, 第三句, 本輪] → 第三句前）
        const deepIndex = texts.indexOf('深度二的思考要求');
        expect(messages[deepIndex].role).toBe('system');
        expect(texts[deepIndex + 1]).toContain('第三句');

        // 不會混進 system prompt 裡重複一份
        expect(sysOf(messages)).not.toContain('深度零的文風');
        expect(sysOf(messages)).not.toContain('深度二的思考要求');
    });

    it('會話：關鍵詞條目能被歷史或本輪輸入觸發，沒提到就不注入', async () => {
        const char = makeChar({
            mountedWorldbooks: [
                wb({ id: 'from-history', content: '鐘樓的設定', constant: false, key: ['第三句'], scanDepth: 4 }),
                wb({ id: 'from-input', content: '月亮的設定', constant: false, key: ['月亮'], scanDepth: 4 }),
                wb({ id: 'depth-kw', content: '雨天的狀態', constant: false, key: ['下雨'], position: 4, depth: 0 }),
                wb({ id: 'miss', content: '海邊的設定', constant: false, key: ['海邊'], scanDepth: 4 }),
            ],
        });
        const { messages } = await DatePrompts.buildSessionPayload(sessionInput(char, '今晚月亮好圓，還下雨了'));
        const sys = sysOf(messages);
        expect(sys).toContain('鐘樓的設定');
        expect(sys).toContain('月亮的設定');
        expect(sys).not.toContain('海邊的設定');
        expect(contents(messages)).toContain('雨天的狀態');
        expect(contents(messages).join('\n')).not.toContain('海邊的設定');
    });

    it('開場感知：深度條目和關鍵詞條目同樣生效', () => {
        const char = makeChar({
            mountedWorldbooks: [
                wb({ id: 'tail', content: '深度零的文風', position: 4, depth: 0 }),
                wb({ id: 'deep', content: '深度四的提醒', position: 4, depth: 4, role: 1 }),
                wb({ id: 'kw', content: '鐘樓的設定', constant: false, key: ['第三句'], scanDepth: 4 }),
            ],
        });
        const { messages } = DatePrompts.buildPeekPayload({ char, userProfile: user, allMsgs: history(), emojis: [] });
        expect(messages.map(m => m.role)).toEqual(['system', 'user', 'user', 'system']);
        expect(messages[1].content).toBe('深度四的提醒');
        expect(messages[2].content).toContain('Start sensing');
        expect(messages[3].content).toBe('深度零的文風');
        expect(sysOf(messages)).toContain('鐘樓的設定');
    });
});

describe('DatePrompts.buildPeekPayload', () => {
    it('描寫風格短語跟隨風格預設；extra 追加進指令', () => {
        const char = makeChar({ dateStyleConfig: { style: 'plain', extra: '環境描寫多一點。' } });
        const { messages } = DatePrompts.buildPeekPayload({
            char, userProfile: user, allMsgs: [makeMsg()], emojis: [],
        });
        const userMsg = messages[messages.length - 1].content as string;
        expect(userMsg).toContain('簡潔白描');
        expect(userMsg).toContain('環境描寫多一點。');
        // peek 刻意保持第三人稱旁觀，不注入 pov 人稱塊
        expect(userMsg).toContain('第三人稱');
    });

    it('歷史裡的卡片消息被壓成摘要，原始 HTML/JSON 不進 prompt', () => {
        const rawHtml = '<div style="color:red">巨大的原始HTML</div>';
        const msgs = [
            makeMsg({ type: 'html_card' as any, role: 'assistant', content: `[HTML卡片] ${rawHtml}`, metadata: { htmlTextPreview: '一張卡片' } }),
            makeMsg({ content: '看到了' }),
        ];
        const { messages } = DatePrompts.buildPeekPayload({
            char: makeChar(), userProfile: user, allMsgs: msgs, emojis: [],
        });
        const userMsg = messages[messages.length - 1].content as string;
        expect(userMsg).not.toContain(rawHtml);
        expect(userMsg).toContain('一張卡片');
    });
});
