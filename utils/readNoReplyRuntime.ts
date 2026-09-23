import type { CharacterProfile, Message } from '../types';
import { DB } from './db';
import { getDailyScheduleForChar } from './dailySchedule';
import { getScheduleWallClock } from './scheduleTime';
import { getCurrentSlot } from './charMusicSchedule';
import { extractContent, safeResponseJson } from './safeApi';
import {
    buildAutoReplyGenPrompt, buildNoReplyNarration, cleanGeneratedAutoReply, pickAutoReplyText,
    resolveReadNoReply, type ReadNoReplyDecision,
} from './readNoReply';

interface ApiConfig { baseUrl: string; apiKey: string; model: string }

/** 這一刻角色的已讀不回判斷（讀當天日程、按角色時區）。沒開或讀不到日程時照常回。 */
export async function getReadNoReplyDecision(char: CharacterProfile, at: Date = new Date()): Promise<ReadNoReplyDecision | null> {
    if (!char.readNoReply?.enabled) return null;
    const wall = getScheduleWallClock(char, at);
    const schedule = await getDailyScheduleForChar(char, at).catch(() => null);
    return resolveReadNoReply(char.readNoReply, getCurrentSlot(schedule, wall), wall);
}

const lineOf = (m: Message, charName: string) => {
    if (m.type && m.type !== 'text') return null;
    const who = m.role === 'user' ? '對方' : m.role === 'assistant' ? charName : null;
    return who && typeof m.content === 'string' ? `${who}：${m.content.slice(0, 120)}` : null;
};

async function generateAutoReply(char: CharacterProfile, api: ApiConfig, decision: ReadNoReplyDecision, recent: Message[]): Promise<string | null> {
    if (!api.baseUrl) return null;
    try {
        const schedule = await getDailyScheduleForChar(char).catch(() => null);
        const slot = getCurrentSlot(schedule, getScheduleWallClock(char));
        const prompt = buildAutoReplyGenPrompt({
            charName: char.name,
            persona: char.description || '',
            decision,
            location: slot?.location,
            recentLines: recent.slice(-6).map(m => lineOf(m, char.name)).filter((l): l is string => !!l),
        });
        const response = await fetch(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey || 'sk-none'}` },
            body: JSON.stringify({ model: api.model, messages: [{ role: 'user', content: prompt }], temperature: 0.9, max_tokens: 60 }),
            __sullyMeta: { appName: '聊天', charId: char.id, charName: char.name, purpose: '已讀不回 · 自動回覆' },
        } as RequestInit);
        if (!response.ok) return null;
        return cleanGeneratedAutoReply(extractContent(await safeResponseJson(response)));
    } catch {
        return null;
    }
}

/**
 * 強制已讀不回：這一輪不發主回覆請求，改落一則自動回覆＋一行旁白。
 *
 * 回傳 'sent'（落了新的自動回覆）、'repeat'（上一則已經是同一段忙碌的自動回覆，這次只算已讀、
 * 什麼都不落，免得連按回覆鍵刷出一排自動回覆），或 null（這一刻不需要已讀不回，照常回）。
 * 「由角色決定」的情況也回 null——那是讓角色自己選，交給提示詞和後處理。
 *
 * api 是「AI 生成自動回覆」用的，走情緒/意識流 API（便宜的那支），失敗就退回固定文字。
 */
export async function applyForcedReadNoReply(
    char: CharacterProfile,
    api: ApiConfig,
    recentMessages: Message[],
): Promise<'sent' | 'repeat' | null> {
    const decision = await getReadNoReplyDecision(char);
    if (!decision || decision.mode !== 'force') return null;

    const lastAssistant = [...recentMessages].reverse().find(m => m.role === 'assistant');
    const lastInfo = (lastAssistant?.metadata as { readNoReply?: { state?: string; reason?: string } } | undefined)?.readNoReply;
    // 同一段忙碌（半天內、同狀態同原因）只發一次自動回覆；隔天同一個「睡覺」是新的一段
    const recent = Date.now() - (lastAssistant?.timestamp ?? 0) < 12 * 60 * 60 * 1000;
    if (lastInfo && recent && lastInfo.state === decision.state && (lastInfo.reason || '') === decision.reason) {
        return 'repeat';
    }

    const text = (char.readNoReply?.aiGenerated ? await generateAutoReply(char, api, decision, recentMessages) : null)
        ?? pickAutoReplyText(char.readNoReply, decision.state);
    await DB.saveMessage({
        charId: char.id, role: 'assistant', type: 'text', content: text,
        metadata: { readNoReply: { state: decision.state, reason: decision.reason } },
    } as Parameters<typeof DB.saveMessage>[0]);
    await DB.saveMessage({ charId: char.id, role: 'system', type: 'text', content: buildNoReplyNarration(char.chatNickname?.trim() || char.name, decision) });
    return 'sent';
}
