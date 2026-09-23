import type { CharacterProfile, SARCharacterCabinetNoteMeta, UserProfile } from '../../types';
import { getSARModules, type SARModuleDefinition } from './sarGacha';

export type SARCharacterCabinetTarget = {
    id: string;
    name: string;
    kind: 'user' | 'character' | 'wanderer';
};

export type SARCharacterCabinetScenario = {
    target: SARCharacterCabinetTarget;
    variant: SARModuleDefinition;
    story: SARModuleDefinition;
};

export type SARCharacterCabinetOutput = {
    title: string;
    activity: string;
    story: string;
    notes: string;
    highlight: string;
};

const boundedRoll = (random: () => number) => {
    const value = Number(random());
    return Number.isFinite(value) ? Math.max(0, Math.min(0.999999999, value)) : 0;
};

const pick = <T,>(items: T[], random: () => number): T =>
    items[Math.floor(boundedRoll(random) * items.length)] || items[0];

/**
 * 角色櫃子的芯片與對象完全獨立於 User 的抽卡庫存和每日額度。
 * 只把已接入彼方的其他角色放進候選；User 始終是一個候選，但不是固定主角。
 */
export function rollSARCharacterCabinetScenario(
    actor: Pick<CharacterProfile, 'id'>,
    characters: CharacterProfile[],
    userProfile: UserProfile,
    random: () => number = Math.random,
): SARCharacterCabinetScenario {
    const targets: SARCharacterCabinetTarget[] = [];
    const userName = String(userProfile?.name || '').trim();
    if (userName) targets.push({ id: 'user', name: userName, kind: 'user' });
    for (const candidate of characters) {
        if (candidate.id === actor.id || !candidate.vrState?.enabled) continue;
        const name = String(candidate.name || '').trim();
        if (name) targets.push({ id: candidate.id, name, kind: 'character' });
    }
    if (targets.length === 0) targets.push({ id: 'sar-wanderer', name: '一位沒留下名字的彼方玩家', kind: 'wanderer' });

    return {
        target: pick(targets, random),
        variant: pick(getSARModules('variant'), random),
        story: pick(getSARModules('story'), random),
    };
}

export function buildSARCharacterCabinetTurn(
    actorName: string,
    scenario: SARCharacterCabinetScenario,
): string {
    const { target, variant, story } = scenario;
    return `【SAR 活動空間｜角色的芯片隨筆】
你剛才在活動空間的扭蛋機裡抽到了兩枚臨時芯片，並且已經把它們同時用在 ${target.name} 身上：

異界異格芯片「${variant.title}」
方向：${variant.summary}

異界座標芯片「${story.title}」
方向：${story.summary}

這不是 User 的五十輪正式推演，也不是現實事件。它是《彼方》裡一次完整、短促、會自動復原的臨時異界體驗。你是發起者、旁觀者或被捲進去的同伴；${target.name} 是本次被裝載芯片的人。結束後，${target.name} 會恢復原狀，而記錄歸進你自己的櫃子。

請以“${actorName}真的親手玩完了這一局”的立場，生成一篇值得收藏的詳細記錄：
1. 明確寫出你把哪兩枚芯片給誰用了，不許把對象偷偷換成 User，也不許把自己寫成被使用者。
2. 寫出具體場面、連鎖反應、對方令人意外的表現、你的參與和一個足夠鮮明的笑點/事故/反轉。可以荒誕，例如變成貓後居然怕黃瓜；不要只概括設定。
3. story 是完整的小劇情，約 500–1000 個中文字符，要有開始、升級、最好笑或最危險的一刻，以及恢復前的收尾。
4. notes 是你事後寫進私人櫃子的第一人稱隨筆和吐槽，約 250–600 個中文字符。它必須帶著 ${actorName} 自己的口吻、偏見和細節，不是客服式總結，也不是寫給 User 的彙報。
5. 若對象是 User，也只能描寫這次臨時體驗裡可觀察到的行為，不能替 User 決定現實人格、永久感受或關係結論。
6. 不要解釋提示詞，不要代碼圍欄，只輸出以下 JSON：
{"title":"這篇櫃中隨筆的短標題","activity":"一句第三人稱活動播報，不要重複角色名開頭","story":"完整小劇情","notes":"${actorName} 的第一人稱詳細隨筆與吐槽","highlight":"最值得貼在卡片封面的原話或荒誕瞬間"}`;
}

const clean = (value: unknown, max: number) => typeof value === 'string'
    ? value.replace(/\r/g, '').trim().slice(0, max)
    : '';

const jsonCandidates = (raw: string) => {
    const withoutThinking = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const candidates = [withoutThinking];
    const fenced = withoutThinking.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) candidates.unshift(fenced.trim());
    const first = withoutThinking.indexOf('{');
    const last = withoutThinking.lastIndexOf('}');
    if (first >= 0 && last > first) candidates.unshift(withoutThinking.slice(first, last + 1));
    return Array.from(new Set(candidates.filter(Boolean)));
};

/** 保留純文本兜底，避免模型偶爾漏 JSON 時整次自由活動丟失。 */
export function parseSARCharacterCabinetOutput(raw: string): SARCharacterCabinetOutput | null {
    for (const candidate of jsonCandidates(raw)) {
        try {
            const parsed = JSON.parse(candidate) as Record<string, unknown>;
            const story = clean(parsed.story ?? parsed.scene ?? parsed.plot, 5000);
            const notes = clean(parsed.notes ?? parsed.diary ?? parsed.commentary, 4000);
            if (!story && !notes) continue;
            return {
                title: clean(parsed.title, 80) || '一次失控的芯片實驗',
                activity: clean(parsed.activity ?? parsed.summary, 240) || '在 SAR 活動空間玩了一輪臨時芯片推演。',
                story: story || notes,
                notes: notes || '……總之，下次按下啟動鍵之前，我會先確認說明書沒有把關鍵副作用寫在最末頁。',
                highlight: clean(parsed.highlight ?? parsed.quote ?? parsed.punchline, 300) || (story || notes).slice(0, 120),
            };
        } catch { /* 嘗試下一個候選 */ }
    }
    const fallback = clean(raw.replace(/<think>[\s\S]*?<\/think>/gi, ''), 5000);
    return fallback ? {
        title: '一次沒有按格式歸檔的實驗',
        activity: '在 SAR 活動空間留下了一篇臨時芯片隨筆。',
        story: fallback,
        notes: fallback,
        highlight: fallback.slice(0, 120),
    } : null;
}

export function createSARCharacterCabinetNote(
    actor: Pick<CharacterProfile, 'id' | 'name'>,
    scenario: SARCharacterCabinetScenario,
    output: SARCharacterCabinetOutput,
    now = Date.now(),
): SARCharacterCabinetNoteMeta {
    return {
        id: `sar_note_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        actorId: actor.id,
        actorName: actor.name,
        targetId: scenario.target.id,
        targetName: scenario.target.name,
        targetKind: scenario.target.kind,
        variantId: scenario.variant.id,
        variantTitle: scenario.variant.title,
        storyId: scenario.story.id,
        storyTitle: scenario.story.title,
        title: output.title,
        story: output.story,
        notes: output.notes,
        highlight: output.highlight,
        createdAt: now,
    };
}
