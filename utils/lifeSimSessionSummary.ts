import { SimAction, UserProfile } from '../types';

export function buildLifeSimSessionSummaryPrompt(
    user: UserProfile,
    participantNames: string[],
    actionLog: SimAction[]
): string {
    const mainPlots = actionLog.filter(action => action.storyKind === 'main_plot');
    const recentBeats = mainPlots.slice(-8).map((action, index) => {
        const title = action.headline || `節點 ${index + 1}`;
        const result = action.immediateResult || action.description;
        return `- ${title}: ${result}`;
    }).join('\n');

    return `
你是《都市人生》結束結算器。
任務：把這一整局的世界線濃縮成 300 字以內的中文總結。

規則：
- 輸出 JSON：{ "summary": "..." }
- 直接寫可讀總結，不要解釋格式。
- 重點是“這群人一起玩出了什麼主線”，不是技術細節。
- 語氣像漂亮的小卡片文案，要簡潔、有畫面感、能讓角色讀懂。
- 需要點到玩家名字 ${user.name}，以及參與角色：${participantNames.join('、') || '無人參與'}。
- 如果有多個主線節點，合成一段順暢的總敘述。

主線節點：
${recentBeats || '- 這一局幾乎沒抽到完整主線，更多是零散吃瓜。'}
    `.trim();
}

export function buildFallbackLifeSimSessionSummary(
    userName: string,
    participantNames: string[],
    actionLog: SimAction[]
): string {
    const mainPlots = actionLog.filter(action => action.storyKind === 'main_plot');
    const beats = mainPlots.slice(-3).map(action => action.headline || action.description).filter(Boolean);
    const cast = participantNames.length > 0 ? `${participantNames.join('、')} 和 ${userName}` : userName;

    if (beats.length === 0) {
        return `${cast} 一起圍觀了這座城的日常雞飛狗跳，雖然沒有拉出完整主線，但幾段曖昧、站隊和小型風波已經把氣氛炒熱。`;
    }

    return `${cast} 一起把這局《都市人生》推成了 ${beats.join('、')} 這條世界線，整座城從吃瓜圍觀一路滾到站隊升級，最後所有人都被捲進同一場 drama 裡。`.slice(0, 300);
}
