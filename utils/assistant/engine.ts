/**
 * Sore 的一輪：送出 → 讀回覆 → 有工具就執行、把結果回給模型 → 再讀，直到它不叫工具或到上限。
 * 畫面每多一則就收到一次 onMessage（存 DB、畫出來）。plans/ai-assistant.md 第 4 節。
 */
import { describeOldFiles, formatFilesForModel, SORE_FILE_MESSAGES_SENT } from './attachments';
import { formatImageNotes, imagesHandled } from './vision';
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
- 美化 CSS、聊天裝扮（模板、換模板、佈局、氣泡、提示音）、預設（條目、正則、生成參數、誰用哪份）、世界書（加、改、停用、改組名、全局、掛給角色）、桌面自訂小組件（HTML／CSS，可以帶 script）你可以用工具出提案，用戶按「套用」才會寫進去（寫之前會留一份，可以一鍵還原）；其他東西只能教用戶怎麼改。
- 世界書不能刪條目，不要的就停用；真的要刪請用戶自己去世界書 App。幫某個角色寫世界書前先「讀取角色」，寫出來才合得上他的人設。
- 改預設：先「列出預設」「讀取預設」，要改的條目先「讀取條目」看全文，再「改預設」。用戶要小改就在原文上改，別整段換成你的風格。正則現在只在見面會跑，寫正則時要跟用戶說。
- 改 CSS：先「讀取CSS」看現在的內容和能用的選擇器，再「寫CSS」送整段；用戶要的是小改，就在原本的上面改，別整段重寫成別的風格。
- 用戶沒講清楚要改哪裡（全域還是某個角色），先問一句。
- 小組件要好看又放得下：先想好尺寸（4x2 最常見），最外層自己畫底和圓角、字別太小；你給不了圖片，要圖請用戶放上桌面後自己加。
- 用戶會傳截圖：可能是想要的樣子（照著做），也可能是自己畫面哪裡壞了（找原因）。看不清楚就直說。
- 訊息裡寫著「這則附了 N 張圖」你卻沒看到圖：是你這組模型看不了圖（或中轉把圖丟了），不是用戶沒傳，別怪系統。直說你這組看不了圖，請用戶二選一：點右上角齒輪換一組能看圖的 API，或到「設置 → API 配置 → 識圖」接一組識圖模型（接好之後圖會先轉成文字給你）。
- 帶【附圖 N】的是識圖模型替你看的轉述：照著做，但顏色、位置是估的，細節拿不準就說，或請用戶補一句。
- 【附圖 N】寫著「識圖沒成功」：那張你沒看到，別裝作看到。照文字能答的先答，再跟用戶說那張圖沒看到（把原因講一下），可以按圖下面的「重試」，或直接用文字描述。
- 用戶會附檔（.css／.txt／.json，在【附件：檔名】裡）：多半是想照著改、或要你看哪裡有問題。附的是別處的美化，要套到這裡先「讀取CSS」看這裡能用哪些選擇器，對不上的要改寫，別原樣塞。
- 聊天裝扮（佈局、氣泡、背景底紋、提示音、白框 CSS）：先「讀取聊天裝扮」「讀取裝扮模板」看現況，再用「改裝扮」出提案。用戶的聊天多半綁著模板：說「把阿澈的聊天改成…」時，要問清楚是改那份模板（用它的聊天全都會變）還是只改阿澈（會變成自訂，脫離模板）；想要兩個聊天只差一點點，就建議「新建模板」從現在的樣子複製一份再改。背景圖你給不了，請用戶到裝扮 App 自己上傳。
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

export type SoreContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export type SoreModelMessage = { role: 'system' | 'user' | 'assistant'; content: string | SoreContentPart[] };
export type ChatCall = (messages: SoreModelMessage[]) => Promise<string>;

/** 圖很貴：只有最近這麼多則帶圖的訊息會真的送圖，更早的換成一句「附了幾張圖」 */
export const SORE_IMAGE_MESSAGES_SENT = 2;

const PROPOSAL_STATUS_TEXT: Record<AssistantProposal['status'], string> = {
    pending: '用戶還沒決定',
    applied: '用戶已套用',
    rejected: '用戶不要',
    restored: '用戶套用後又還原了',
};

/** 歷史 → 送給模型的 messages：assistant 用原文（含工具標籤），工具結果當 user；提案帶上現在的狀態；最近的圖照送 */
export const toModelMessages = (history: AssistantMessage[]): SoreModelMessage[] => {
    const recent = history.slice(-HISTORY_LIMIT);
    const withImages = recent.filter(m => m.role === 'user' && m.images?.length).slice(-SORE_IMAGE_MESSAGES_SENT).map(m => m.id);
    const withFiles = recent.filter(m => m.role === 'user' && m.files?.length).slice(-SORE_FILE_MESSAGES_SENT).map(m => m.id);
    return recent.map(m => {
        if (m.role === 'assistant') return { role: 'assistant', content: m.raw || m.text };
        let text = m.proposal ? `${m.text}\n[提案狀態：${PROPOSAL_STATUS_TEXT[m.proposal.status]}]` : m.text;
        if (m.files?.length) text = `${text}\n\n${withFiles.includes(m.id) ? formatFilesForModel(m.files) : describeOldFiles(m.files)}`;
        if (!m.images?.length) return { role: 'user', content: text };
        // 過了識圖的：送文字、不送原圖（文字不貴，舊的也照帶）；沒成功的那幾張寫明沒看到，不擋住這一輪
        if (imagesHandled(m)) return { role: 'user', content: `${text}\n\n${formatImageNotes(m)}` };
        if (!withImages.includes(m.id)) return { role: 'user', content: `${text}\n（附了 ${m.images.length} 張圖，太舊了沒再送）` };
        // 寫明附了幾張：模型看不了圖時才知道是自己看不到，不是用戶沒傳
        return { role: 'user', content: [{ type: 'text', text: `${text}\n（這則附了 ${m.images.length} 張圖）` }, ...m.images.map(url => ({ type: 'image_url' as const, image_url: { url } }))] };
    });
};

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
                    if (result.proposal) proposal = { ...result.proposal, id: newId(), status: 'pending' } as AssistantProposal;
                } catch (error: any) {
                    content = `工具出錯：${error?.message || String(error)}`;
                }
            }
            await push({ id: newId(), role: 'tool', text: formatToolResult(call.name, ok, content), toolName: call.name, toolOk: ok, at: Date.now(), ...(proposal ? { proposal } : {}) });
        }
    }
    return added;
};
