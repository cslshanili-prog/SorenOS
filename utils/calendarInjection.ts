/**
 * 行事曆給聊天提示詞的那幾段（plans/calendar.md 第 5 節）——純函數，好測。
 * 角色自己沒做完的待辦＋標籤教學：有日程功能的角色才給（chatPrompts 那邊判），fire_pack 不烤。
 */

export interface TodoLine {
    title: string;
    /** 截止日 'YYYY-MM-DD' */
    deadline?: string;
    /** 是角色自己在聊天裡記的（不是你替他加的） */
    fromChat?: boolean;
}

const dayDiff = (a: string, b: string): number => Math.round((Date.UTC(Number(a.slice(0, 4)), Number(a.slice(5, 7)) - 1, Number(a.slice(8, 10))) - Date.UTC(Number(b.slice(0, 4)), Number(b.slice(5, 7)) - 1, Number(b.slice(8, 10)))) / 86_400_000);

const whenLabel = (deadline: string | undefined, today: string): string => {
    if (!deadline) return '';
    const d = dayDiff(deadline, today);
    if (d < 0) return `（${-d} 天前就該做了）`;
    if (d === 0) return '（今天）';
    if (d === 1) return '（明天）';
    return `（${deadline}）`;
};

export const TODO_TAG_GUIDE = '要給自己記一件事就單獨起一行寫 `[[TODO|事情|YYYY-MM-DD]]`（日期可省）；做完了就單獨起一行寫 `[[TODO_DONE|事情]]`，系統會幫你勾掉。別把標籤混在台詞裡，也別為了記而記——真的要做的事才記。';

/** 角色沒做完的待辦那段；一條都沒有就只給標籤教學（讓他知道可以記） */
export const buildCharTodoInjection = (todos: TodoLine[], today: string, limit = 8): string => {
    const lines = todos.slice(0, limit).map(t => `- ${t.title}${whenLabel(t.deadline, today)}${t.fromChat ? '' : '（對方幫你記的）'}`);
    const more = todos.length > limit ? `\n（還有 ${todos.length - limit} 條沒列）` : '';
    const list = lines.length ? `${lines.join('\n')}${more}\n（這些是你自己要做的事，放在心上、找時間做；聊到相關的話題可以自然提起。）` : '（目前沒有沒做完的待辦。）';
    return `### 📝【你的待辦】\n${list}\n${TODO_TAG_GUIDE}`;
};
