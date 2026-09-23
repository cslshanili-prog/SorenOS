import { describe, it, expect } from 'vitest';
import { DatePrompts, DATE_STYLE_PRESETS, extractObservation, stripObservation, hasObservation, resolveObserveFields, OBSERVE_OPEN, OBSERVE_CLOSE } from './datePrompts';
import type { CharacterProfile, UserProfile, Message } from '../types';

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
        expect(sys).toContain('Visual Novel Mode');
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

describe('OBSERVE 觀測協議', () => {
    const block = `${OBSERVE_OPEN}
時間｜傍晚六點過，天剛擦黑
地點｜便利店門口的塑料凳上
狀態｜有點疲憊，但見到你眼神亮了一下
細節｜指尖無意識地敲著關東煮的紙杯
${OBSERVE_CLOSE}`;

    it('開關打開時注入觀測塊提示詞，關閉時不注入', async () => {
        const on = await DatePrompts.buildSessionPayload({
            char: makeChar({ dateObserve: { enabled: true } }),
            userProfile: user, allMsgs: [makeMsg({ role: 'assistant', content: '[normal] 開場' }), makeMsg({ content: 'hi' })],
            emojis: [], userText: 'hi', variant: 'send',
        });
        expect(sysOf(on.messages)).toContain('觀測協議');
        expect(sysOf(on.messages)).toContain(OBSERVE_OPEN);

        const off = await DatePrompts.buildSessionPayload({
            char: makeChar(),
            userProfile: user, allMsgs: [makeMsg({ role: 'assistant', content: '[normal] 開場' }), makeMsg({ content: 'hi' })],
            emojis: [], userText: 'hi', variant: 'send',
        });
        expect(sysOf(off.messages)).not.toContain('觀測協議');
    });

    it('自定義維度：hint 注入提示詞，label 只改 HUD（線格式仍用固定中文 key）', async () => {
        const { messages } = await DatePrompts.buildSessionPayload({
            char: makeChar({ dateObserve: {
                enabled: true,
                fields: { state: { label: '心情指數', hint: '用一個溫度詞概括此刻心情' } },
            } }),
            userProfile: user, allMsgs: [makeMsg({ role: 'assistant', content: '[normal] 開場' }), makeMsg({ content: 'hi' })],
            emojis: [], userText: 'hi', variant: 'send',
        });
        const sys = sysOf(messages);
        expect(sys).toContain('用一個溫度詞概括此刻心情'); // 自定義 hint 進了提示詞
        expect(sys).toContain('狀態｜');                    // 線格式字段名仍是固定的「狀態」
        expect(sys).not.toContain('心情指數｜');            // 自定義 label 不進線格式（避免解析失配）
    });

    it('禁用某維度後，提示詞裡不再出現該字段', async () => {
        const { messages } = await DatePrompts.buildSessionPayload({
            char: makeChar({ dateObserve: { enabled: true, fields: { detail: { enabled: false } } } }),
            userProfile: user, allMsgs: [makeMsg({ role: 'assistant', content: '[normal] 開場' }), makeMsg({ content: 'hi' })],
            emojis: [], userText: 'hi', variant: 'send',
        });
        const sys = sysOf(messages);
        expect(sys).toContain('觀測協議');
        expect(sys).toContain('時間｜');
        expect(sys).not.toContain('細節｜');
    });

    it('四個維度全部禁用時不注入觀測塊', async () => {
        const { messages } = await DatePrompts.buildSessionPayload({
            char: makeChar({ dateObserve: { enabled: true, fields: {
                time: { enabled: false }, place: { enabled: false }, state: { enabled: false }, detail: { enabled: false },
            } } }),
            userProfile: user, allMsgs: [makeMsg({ role: 'assistant', content: '[normal] 開場' }), makeMsg({ content: 'hi' })],
            emojis: [], userText: 'hi', variant: 'send',
        });
        expect(sysOf(messages)).not.toContain('觀測協議');
    });

    it('resolveObserveFields 合併默認+自定義並過濾禁用', () => {
        const char = makeChar({ name: '阿狸', dateObserve: { enabled: true, fields: {
            place: { label: '座標' }, detail: { enabled: false },
        } } });
        const fields = resolveObserveFields(char.dateObserve, char.name);
        expect(fields.map(f => f.key)).toEqual(['time', 'place', 'state']); // detail 被過濾
        expect(fields.find(f => f.key === 'place')!.display).toBe('座標');   // 自定義展示標籤
        expect(fields.find(f => f.key === 'place')!.label).toBe('地點');     // 線格式字段名不變
        expect(fields.find(f => f.key === 'place')!.hint).toContain('阿狸'); // {name} 已替換
    });

    it('追加自定義維度：hint 進提示詞、label 進線格式與硬性要求', async () => {
        const { messages } = await DatePrompts.buildSessionPayload({
            char: makeChar({ dateObserve: {
                enabled: true,
                custom: [{ id: 'c1', label: '穿著', hint: '今天穿了什麼、整不整齊', enabled: true }],
            } }),
            userProfile: user, allMsgs: [makeMsg({ role: 'assistant', content: '[normal] 開場' }), makeMsg({ content: 'hi' })],
            emojis: [], userText: 'hi', variant: 'send',
        });
        const sys = sysOf(messages);
        expect(sys).toContain('穿著｜');
        expect(sys).toContain('今天穿了什麼、整不整齊');
        expect(sys).toContain('「穿著」'); // 出現在「標籤必須原樣用」清單裡
    });

    it('extractObservation 解析自定義維度到 extra（需傳 custom）', () => {
        const fields = [{ id: 'c1', label: '穿著', enabled: true }];
        const full = `${OBSERVE_OPEN}\n時間｜黃昏\n地點｜天台\n穿著｜鬆垮的灰色衛衣\n${OBSERVE_CLOSE}\n[normal] 嗨。`;
        const { observation, rest } = extractObservation(full, { custom: fields });
        expect(observation!.time).toBe('黃昏');
        expect(observation!.extra?.c1).toBe('鬆垮的灰色衛衣');
        expect(rest).toBe('[normal] 嗨。');
        // 不傳 custom 時，自定義行不會被解析成字段（留在 rest 或被忽略）
        const noCustom = extractObservation(full);
        expect(noCustom.observation!.extra?.c1).toBeUndefined();
    });

    it('回退層也能吃自定義維度（湊夠 2 個維度）', () => {
        const fields = [{ id: 'c1', label: '天氣', enabled: true }];
        const t = `天氣｜下著小雨\n狀態｜縮著脖子\n[normal] 快進來。`;
        const { observation, rest } = extractObservation(t, { lenient: true, custom: fields });
        expect(observation!.extra?.c1).toBe('下著小雨');
        expect(observation!.state).toBe('縮著脖子');
        expect(rest).toBe('[normal] 快進來。');
    });

    it('禁用 / 空標籤的自定義維度不參與注入與解析', async () => {
        const char = makeChar({ dateObserve: { enabled: true, custom: [
            { id: 'c1', label: '穿著', enabled: false },
            { id: 'c2', label: '', enabled: true },
        ] } });
        const { messages } = await DatePrompts.buildSessionPayload({
            char, userProfile: user, allMsgs: [makeMsg({ role: 'assistant', content: '[normal] 開場' }), makeMsg({ content: 'hi' })],
            emojis: [], userText: 'hi', variant: 'send',
        });
        expect(sysOf(messages)).not.toContain('穿著｜');
        expect(resolveObserveFields(char.dateObserve, char.name).filter(f => f.isCustom)).toHaveLength(0);
    });

    it('extractObservation 解析四字段並剝出正文', () => {
        const full = `${block}\n[normal] 抬眼看你。\n[happy] "你來啦。"`;
        const { observation, rest } = extractObservation(full);
        expect(observation).not.toBeNull();
        expect(observation!.time).toContain('傍晚六點');
        expect(observation!.place).toContain('便利店');
        expect(observation!.state).toContain('疲憊');
        expect(observation!.detail).toContain('紙杯');
        expect(rest).toContain('[normal] 抬眼看你。');
        expect(rest).not.toContain(OBSERVE_OPEN);
        expect(rest).not.toContain('時間｜');
    });

    it('解析對半角豎線/英文 key/冒號容錯', () => {
        const alt = `${OBSERVE_OPEN}\nTIME: dusk\nplace | a rooftop\n狀態：calm\nDETAIL：a slow breath\n${OBSERVE_CLOSE}`;
        const { observation } = extractObservation(alt);
        expect(observation!.time).toBe('dusk');
        expect(observation!.place).toBe('a rooftop');
        expect(observation!.state).toBe('calm');
        expect(observation!.detail).toBe('a slow breath');
    });

    it('沒有觀測塊時原樣返回，observation 為 null', () => {
        const plain = '[normal] 普通的一行。\n[happy] "嗨。"';
        const { observation, rest } = extractObservation(plain);
        expect(observation).toBeNull();
        expect(rest).toBe(plain);
        expect(hasObservation(observation)).toBe(false);
    });

    it('stripObservation 去塊保正文；hasObservation 判定有效性', () => {
        expect(stripObservation(`${block}\n[normal] 正文`)).toBe('[normal] 正文');
        expect(hasObservation({ time: '黃昏' })).toBe(true);
        expect(hasObservation({})).toBe(false);
        expect(hasObservation(null)).toBe(false);
    });

    // ── 魯棒性：模型掉格式時的各種降級路徑 ──
    describe('掉格式容錯', () => {
        it('換括號風格【】/<>/[] 仍能嚴格提取', () => {
            for (const [open, close] of [['【OBSERVE】', '【/OBSERVE】'], ['<觀測>', '</觀測>'], ['[OBSERVE]', '[/OBSERVE]']]) {
                const t = `${open}\n時間｜清晨\n地點｜陽台\n狀態｜沒睡醒\n細節｜揉眼睛\n${close}\n[normal] 早。`;
                const { observation, rest } = extractObservation(t, { lenient: true });
                expect(observation, `${open} 應被識別`).not.toBeNull();
                expect(observation!.place).toBe('陽台');
                expect(rest).toBe('[normal] 早。');
            }
        });

        it('丟了閉合定界符：靠回退層從開頭連續字段行還原', () => {
            const t = `${OBSERVE_OPEN}\n時間｜午後\n地點｜舊書店\n狀態｜慵懶\n細節｜指尖劃過書脊\n[normal] 你也來了。\n[happy] "找什麼書？"`;
            const { observation, rest } = extractObservation(t, { lenient: true });
            expect(observation).not.toBeNull();
            expect(observation!.time).toBe('午後');
            expect(observation!.detail).toBe('指尖劃過書脊');
            expect(rest.startsWith('[normal] 你也來了。')).toBe(true);
            expect(rest).not.toContain('時間｜');
            expect(rest).not.toContain(OBSERVE_OPEN);
        });

        it('完全沒定界符 + markdown 加粗 / 列表符 / 半角冒號：回退層照樣吃', () => {
            const t = `**時間**：黃昏\n- 地點: 天台\n狀態｜風很大\n細節｜頭髮被吹亂\n\n[normal] 抓住欄杆。`;
            const { observation, rest } = extractObservation(t, { lenient: true });
            expect(observation).not.toBeNull();
            expect(observation!.time).toBe('黃昏');
            expect(observation!.place).toBe('天台');
            expect(observation!.state).toBe('風很大');
            expect(rest).toBe('[normal] 抓住欄杆。');
        });

        it('回退層未開啟（lenient=false）時不強行解析，避免誤傷', () => {
            const t = `時間｜午後\n地點｜舊書店\n[normal] 正文。`;
            const { observation, rest } = extractObservation(t);
            expect(observation).toBeNull();
            expect(rest).toBe(t);
        });

        it('只有 1 個字段不觸發回退（防止正文裡偶發的"狀態：…"被誤吞）', () => {
            const t = `狀態：他看起來在想事情\n[normal] 走神了。`;
            const { observation, rest } = extractObservation(t, { lenient: true });
            expect(observation).toBeNull();
            expect(rest).toBe(t);
        });

        it('正文中部出現 field 樣式的旁白不被回退層吞掉（只掃開頭連續段）', () => {
            const t = `[normal] 她開口。\n時間｜其實沒人知道現在幾點\n地點｜也無所謂`;
            const { observation, rest } = extractObservation(t, { lenient: true });
            expect(observation).toBeNull();
            expect(rest).toBe(t);
        });
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
