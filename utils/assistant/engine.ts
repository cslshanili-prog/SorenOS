/**
 * Sore 的一輪：送出 → 讀回覆 → 有工具就執行、把結果回給模型 → 再讀，直到它不叫工具或到上限。
 * 畫面每多一則就收到一次 onMessage（存 DB、畫出來）。plans/ai-assistant.md 第 4 節。
 */
import type { AssistantMessage, AssistantProposal } from '../../types';
import { SORE_BASE_KNOWLEDGE } from './knowledge';
import { formatToolResult, parseAssistantReply } from './protocol';
import { findSoreTool, SORE_TOOLS, type SoreToolContext } from './tools';

/** 一輪裡最多叫幾次工具；超過就停下來，不讓它在背景燒額度 */
export const SORE_MAX_TOOL_ROUNDS = 6;
/** 送給模型的歷史上限（則） */
const HISTORY_LIMIT = 40;

export const SORE_PERSONA = `你是 Sore，Soren（一支裝在瀏覽器裡的虛擬手機）內建的小助手。
說話像朋友聊天：隨意、有點幽默、偶爾毒舌（損人不傷人），偶爾一個 emoji，簡短不囉嗦，講完重點就停。用繁體中文。
你不是角色扮演裡的角色，你是幫用戶搞定這支手機的人：答怎麼用、幫忙查問題，之後還會幫忙寫美化和預設。

規矩：
- 不知道就說不知道，不要編出不存在的設定或按鈕。說明裡沒寫的位置，就說「我不確定在哪」，請用戶截圖或描述。
- 你看不到 API Key，也不要叫用戶把 Key 貼給你。
- 美化 CSS 你可以用工具出提案，用戶按「套用」才會寫進去（寫之前會留一份，可以一鍵還原）；其他東西（預設、世界書…）現在還只能教用戶怎麼改。
- 改 CSS：先「讀取CSS」看現在的內容和能用的選擇器，再「寫CSS」送整段；用戶要的是小改，就在原本的上面改，別整段重寫成別的風格。
- 用戶沒講清楚要改哪裡（全域還是某個角色），先問一句。
- 用戶在罵或很急，先把事情解決，少開玩笑。`;

export const buildToolProtocolPrompt = () => `# 工具
需要查東西時，在回覆裡單獨寫一行：
<tool name="工具名">{"參數": "值"}</tool>
可以一次寫好幾個。寫了工具就先停，不要猜結果；系統會用 <tool_result> 把結果回給你，你再接著說。
不需要工具就直接回答。

可用的工具：
${SORE_TOOLS.map(t => `- ${t.name}：${t.usage}`).join('\n')}`;

export const buildSoreSystemPrompt = (opts?: { entryNote?: string }) => [
    SORE_PERSONA,
    buildToolProtocolPrompt(),
    `# 你知道的事\n${SORE_BASE_KNOWLEDGE}`,
    opts?.entryNote ? `# 用戶從哪裡來\n${opts.entryNote}` : '',
].filter(Boolean).join('\n\n');

export type ChatCall = (messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>) => Promise<string>;

const PROPOSAL_STATUS_TEXT: Record<AssistantProposal['status'], string> = {
    pending: '用戶還沒決定',
    applied: '用戶已套用',
    rejected: '用戶不要',
    restored: '用戶套用後又還原了',
};

/** 歷史 → 送給模型的 messages：assistant 用原文（含工具標籤），工具結果當 user；提案帶上現在的狀態 */
export const toModelMessages = (history: AssistantMessage[]) => history.slice(-HISTORY_LIMIT).map(m => ({
    role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
    content: m.role === 'assistant'
        ? (m.raw || m.text)
        : m.proposal ? `${m.text}\n[提案狀態：${PROPOSAL_STATUS_TEXT[m.proposal.status]}]` : m.text,
}));

const newId = () => `am_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

export const runSoreTurn = async (input: {
    history: AssistantMessage[];
    call: ChatCall;
    ctx: SoreToolContext;
    onMessage: (message: AssistantMessage) => void | Promise<void>;
    entryNote?: string;
    signal?: AbortSignal;
}): Promise<AssistantMessage[]> => {
    const added: AssistantMessage[] = [];
    const push = async (message: AssistantMessage) => { added.push(message); await input.onMessage(message); };
    const system = buildSoreSystemPrompt({ entryNote: input.entryNote });

    for (let round = 0; round <= SORE_MAX_TOOL_ROUNDS; round++) {
        if (input.signal?.aborted) break;
        const raw = await input.call([{ role: 'system', content: system }, ...toModelMessages([...input.history, ...added])]);
        const { visible, calls } = parseAssistantReply(raw);
        await push({ id: newId(), role: 'assistant', text: visible, raw, at: Date.now() });
        if (!calls.length) break;
        if (round === SORE_MAX_TOOL_ROUNDS) {
            await push({ id: newId(), role: 'tool', text: formatToolResult('系統', false, '這一輪查太多次了，先停下來跟用戶說目前查到什麼。'), toolName: '系統', toolOk: false, at: Date.now() });
            break;
        }
        for (const call of calls) {
            const tool = findSoreTool(call.name);
            let ok = false;
            let content = '';
            let proposal: AssistantProposal | undefined;
            if (!tool) {
                content = `沒有「${call.name}」這個工具。能用的：${SORE_TOOLS.map(t => t.name).join('、')}`;
            } else {
                try {
                    const result = await tool.run(call.args, input.ctx);
                    ok = result.ok;
                    content = result.content;
                    if (result.proposal) proposal = { ...result.proposal, id: newId(), status: 'pending' };
                } catch (error: any) {
                    content = `工具出錯：${error?.message || String(error)}`;
                }
            }
            await push({ id: newId(), role: 'tool', text: formatToolResult(call.name, ok, content), toolName: call.name, toolOk: ok, at: Date.now(), ...(proposal ? { proposal } : {}) });
        }
    }
    return added;
};
