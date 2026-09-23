import { describe, it, expect } from 'vitest';
import { ChatPrompts } from './chatPrompts';

// `[schedule_message]` 排的是瀏覽器裡的本地定時消息：存 IndexedDB，靠 OSContext 裡一個
// 5 秒輪詢的 React 定時器派發，App 關著就不存在。主動消息 2.0 到點生成走的是另一條路
// （worker 到點跑），它有自己的排程工具，說明由 worker 追加在 fire_pack 末尾。
//
// 兩套一起擺在角色面前，它會挑錯的那套：正文裡寫「我到點叫你」+ 一行 [schedule_message]，
// 然後那條排程永遠不會響。所以只在「這一輪 worker 不會教雲端排程工具」時才教本地標籤：
// fire_pack 打包（forFirePack）不教；即時對話（timelyByWorker）裡開著主動消息 2.0 的
// 角色也不教（worker 會給它注入排程工具）；2.0 關著的角色雲端沒有排程能力，本地標籤
// 是它唯一的定時手段，照教。

const char = { id: 'char-sched', name: '阿一' } as any;
// 開著主動消息 2.0 的角色。判據與 worker 側 fire_pack 的 selfScheduleEnabled 同源
// （isAmsg2EnabledForChar：activeMsg2Config.enabled === true 才算開）。
const charWithAmsg2 = { id: 'char-sched-amsg2', name: '阿一', activeMsg2Config: { enabled: true } } as any;
const userProfile = { name: '小明' } as any;

const buildStable = async (
    promptOptions?: { forFirePack?: boolean; timelyByWorker?: boolean },
    targetChar: any = char,
) => {
    const parts = await ChatPrompts.buildSystemPromptParts(
        targetChar, userProfile, [], [], [], [],
        undefined, undefined, undefined, undefined, undefined, undefined,
        promptOptions,
    );
    return parts.stable;
};

describe('行為規範 · [schedule_message] 的教學開關', () => {
    it('默認（前台聊天）照常教', async () => {
        const stable = await buildStable();
        expect(stable).toContain('[schedule_message | YYYY-MM-DD HH:MM:SS | fixed | 消息內容]');
        expect(stable).toContain('定時發送消息');
    });

    it('forFirePack（打包主動消息模板）時整條不出現', async () => {
        const stable = await buildStable({ forFirePack: true });
        expect(stable).not.toContain('schedule_message');
        expect(stable).not.toContain('定時發送消息');
        // 只拿掉這一條，同一段裡的其他動作說明得留著
        expect(stable).toContain('[[ACTION:POKE]]');
        expect(stable).toContain('[[ACTION:ADD_EVENT');
    });

    it('即時對話（timelyByWorker）且角色開著 2.0 時不教（worker 會注入雲端排程工具）', async () => {
        const stable = await buildStable({ timelyByWorker: true }, charWithAmsg2);
        expect(stable).not.toContain('[schedule_message');
        expect(stable).not.toContain('定時發送消息');
        // 只拿掉這一條，同一段裡的其他動作說明得留著
        expect(stable).toContain('[[ACTION:POKE]]');
        expect(stable).toContain('[[ACTION:ADD_EVENT');
    });

    it('即時對話但角色 2.0 關著時照教（雲端沒有排程工具，本地標籤是唯一的定時手段）', async () => {
        const stable = await buildStable({ timelyByWorker: true });
        expect(stable).toContain('[schedule_message | YYYY-MM-DD HH:MM:SS | fixed | 消息內容]');
        expect(stable).toContain('定時發送消息');
    });

    it('本地路徑（無 timelyByWorker）即便角色開著 2.0 也照教', async () => {
        const stable = await buildStable(undefined, charWithAmsg2);
        expect(stable).toContain('[schedule_message | YYYY-MM-DD HH:MM:SS | fixed | 消息內容]');
        expect(stable).toContain('定時發送消息');
    });
});
