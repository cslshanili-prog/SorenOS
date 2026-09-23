/**
 * 「家園 · 模擬時間」章節總結 —— 每 20 天結一卷。
 *
 * sim（模擬時間）模式不進記憶，演繹一直留在家園裡慢慢攢。攢滿 20 天（= 80 輪，
 * 一天四段：早/中/晚/凌晨）就結一卷：
 *   1. 用一次 LLM 調用把這 20 天的原文揉成一份**小說體梗概**（給屏幕外的用戶看，圖一樂），
 *      連帶人物關係動態走向與評價、本卷沉澱的氛圍基調；
 *   2. 同一次調用順帶產出**每個角色單方面視角**的回顧——往後單獨喂回各自，避免角色開上帝視角；
 *   3. 歸檔這 20 天原文（標記 simSummarizedClock），往後只把「該角色的單視角總結 + ta 最後一天
 *      的 beat + 氛圍基調」作為上文喂回——原文不再逐輪喂。
 *
 * 成本：一卷 = 1 次額外 LLM 調用（不是 N 次），用最便宜的方式拿到全員視角。
 */

import type { APIConfig, CharacterProfile, WorldProfile, WorldEpisode, WorldChapter, WorldCharBeat } from '../../types';
import { safeFetchJson } from '../safeApi';
import { extractJson, SEGMENTS_PER_DAY } from './prompts';

/** 一天四段（早/中/晚/凌晨，見 prompts.SEGMENTS_PER_DAY），20 天結一卷。 */
export { SEGMENTS_PER_DAY };
export const SIM_CHAPTER_DAYS = 20;
export const SIM_CHAPTER_CLOCKS = SIM_CHAPTER_DAYS * SEGMENTS_PER_DAY; // 80

const genId = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

/**
 * sim 模式下，本輪推進後是否正好結滿一卷。
 * round（= 推進後的 storyClock）落在 SIM_CHAPTER_CLOCKS（80）的整數倍上即結卷。
 */
export function shouldCloseChapter(world: WorldProfile, newClock: number): boolean {
    if (world.timeMode !== 'sim') return false;
    if (newClock <= (world.simSummarizedClock || 0)) return false;
    return newClock % SIM_CHAPTER_CLOCKS === 0;
}

/** 一個角色一輪的濃縮文摘（餵給總結器，控制體量）。只用本人產出，公私都給（總結器是全知的）。 */
function digestBeat(b: WorldCharBeat): string {
    const parts = [`${b.charName}（${b.location}・${b.mood}）`];
    if (b.timeline?.length) parts.push(b.timeline.map(tl => `${tl.time}${tl.place}：${tl.event}${tl.shared ? '' : '〔瞞〕'}`).join('；'));
    if (b.narrative) parts.push(`內心：${b.narrative.slice(0, 220)}`);
    if (b.dialogues?.length) parts.push(b.dialogues.map(d => `對${d.with}說「${d.lines.join('/')}」`).join('；'));
    if (b.relationshipDeltas?.length) parts.push(b.relationshipDeltas.map(r => `對${r.withName} ${r.delta > 0 ? '+' : ''}${r.delta}${r.reason ? `(${r.reason})` : ''}`).join('；'));
    return parts.join(' ｜ ');
}

/** 把窗口內的原文揉成餵給總結器的文摘（按時間正序）。 */
export function buildChapterDigest(episodes: WorldEpisode[]): string {
    return episodes
        .slice()
        .sort((a, b) => a.round - b.round)
        .map(ep => {
            const lines = [`【${ep.storyTime}】`];
            if (ep.npcScene) lines.push(`鎮上：${ep.npcScene.slice(0, 160)}`);
            for (const b of ep.beats) lines.push(`- ${digestBeat(b)}`);
            return lines.join('\n');
        })
        .join('\n\n')
        .slice(0, 12000);
}

/** 總結器提示詞。 */
export function buildChapterSummaryPrompt(args: {
    world: WorldProfile;
    members: CharacterProfile[];
    fromLabel: string;
    toLabel: string;
    digest: string;
    prevSynopsis?: string;
}): string {
    const { world, members, fromLabel, toLabel, digest, prevSynopsis } = args;
    const names = members.map(m => m.name);
    return `你是共同世界「${world.name}」的編年史官。下面是這個世界從「${fromLabel}」到「${toLabel}」這 ${SIM_CHAPTER_DAYS} 天裡，每個角色每半天的原始演繹記錄（含他們各自瞞下的事，用〔瞞〕標出）。

## 世界觀
${world.worldview || '（一個安靜的小世界）'}

## 角色名單
${names.join('、')}
${prevSynopsis ? `\n## 上一卷梗概（承接，不要重複）\n${prevSynopsis.slice(0, 800)}` : ''}

## 這 ${SIM_CHAPTER_DAYS} 天的原文
${digest}

請像寫連載小說的「本卷小結」一樣，結出這一卷。嚴格輸出一個 JSON 對象（建議 \`\`\`json 包裹，不要輸出 JSON 之外的正文）：
{
  "synopsis": "800~1500字的小說體梗概：這 ${SIM_CHAPTER_DAYS} 天的主線與重要轉折，誰經歷了什麼、暗流與高潮。可以全知視角（你看得到所有人瞞下的事），寫給屏幕外的觀眾看。分3~6段（用\\n\\n分段）。",
  "relationshipEval": "200~400字：這一卷里人物關係網的動態變化方向與評價——誰和誰更近/更遠了、新生的暗流或裂痕、幾條關係線的走向預判。",
  "atmosphere": "一兩句話：這一卷沉澱下來、會延續到下一卷的整體氛圍基調（例：表面平靜下暗藏幾段心照不宣的緊張）。",
  "perspectives": [
    { "name": "角色名", "text": "300~500字，**只從這個角色單方面的視角**回顧這 ${SIM_CHAPTER_DAYS} 天：ta 親歷了什麼、ta 知道/聽說了什麼、ta 對別人怎麼看、心裡留下了什麼。**絕對不能寫 ta 不可能知道的別人內心戲或別人瞞著 ta 的事**——這是要喂回 ta 自己的記憶的，寫漏了就等於讓 ta 開了上帝視角。" }
  ]
}
要求：perspectives 必須為每個角色（${names.join('、')}）各出一條，name 用上面的原名。`;
}

/** 解析總結器輸出 → 章節字段（缺字段時儘量兜底，不拋錯）。 */
export function parseChapterSummary(raw: string, members: CharacterProfile[]): {
    synopsis: string;
    relationshipEval?: string;
    atmosphere?: string;
    perspectives: { charId: string; charName: string; text: string }[];
} {
    const j = extractJson(raw);
    const fallback = (raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?|```/g, '').trim();
    const byName = new Map(members.map(m => [m.name, m]));
    const perspectives: { charId: string; charName: string; text: string }[] = [];
    if (j && Array.isArray(j.perspectives)) {
        for (const p of j.perspectives) {
            if (!p || typeof p.name !== 'string' || typeof p.text !== 'string' || !p.text.trim()) continue;
            const char = byName.get(p.name.trim());
            if (!char) continue;
            if (perspectives.some(x => x.charId === char.id)) continue;
            perspectives.push({ charId: char.id, charName: char.name, text: p.text.trim().slice(0, 1200) });
        }
    }
    return {
        synopsis: (j && typeof j.synopsis === 'string' && j.synopsis.trim() ? j.synopsis.trim() : fallback).slice(0, 4000),
        relationshipEval: j && typeof j.relationshipEval === 'string' && j.relationshipEval.trim() ? j.relationshipEval.trim().slice(0, 1200) : undefined,
        atmosphere: j && typeof j.atmosphere === 'string' && j.atmosphere.trim() ? j.atmosphere.trim().slice(0, 300) : undefined,
        perspectives,
    };
}

/**
 * 結一卷：調用總結器，產出 WorldChapter。
 * 失敗返回 null（結卷失敗不應該拖垮主演繹流程，下一卷照常累積）。
 */
export async function summarizeChapter(args: {
    world: WorldProfile;
    members: CharacterProfile[];
    episodes: WorldEpisode[];     // 本卷窗口內的原文（任意順序）
    api: { baseUrl: string; apiKey: string; model: string };
    fromClock: number;
    toClock: number;
    fromLabel: string;
    toLabel: string;
    index: number;
    prevSynopsis?: string;
}): Promise<WorldChapter | null> {
    const { world, members, episodes, api, fromClock, toClock, fromLabel, toLabel, index, prevSynopsis } = args;
    if (episodes.length === 0) return null;
    const baseUrl = api.baseUrl.replace(/\/+$/, '');
    const digest = buildChapterDigest(episodes);
    try {
        const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey || 'sk-none'}` },
            body: JSON.stringify({
                model: api.model,
                messages: [{ role: 'user', content: buildChapterSummaryPrompt({ world, members, fromLabel, toLabel, digest, prevSynopsis }) }],
                temperature: 0.8, stream: false,
            }),
        }, 2, 0, { appName: '家園', purpose: `結卷總結 · ${world.name} 第${index}卷` });
        const parsed = parseChapterSummary(data.choices?.[0]?.message?.content || '', members);
        // 每個角色這一卷「最後一天」的 beat：取窗口內 round 最大的那條 episode 裡各自的 beat
        const lastEp = episodes.slice().sort((a, b) => b.round - a.round)[0];
        const lastDayBeats = lastEp?.beats || [];
        return {
            id: genId('wc'),
            worldId: world.id,
            index,
            fromClock,
            toClock,
            fromLabel,
            toLabel,
            synopsis: parsed.synopsis,
            relationshipEval: parsed.relationshipEval,
            atmosphere: parsed.atmosphere,
            perspectives: parsed.perspectives,
            lastDayBeats,
            createdAt: Date.now(),
        };
    } catch (e) {
        console.warn('[WorldHome] chapter summary failed:', e);
        return null;
    }
}
