/**
 * 「日程/情绪」面板里用户自定义的心声 / 好感度条目——按用户自己填的标题 + 提示词，
 * 调用角色当前生效的 API 生成一段心声短文，或刷新一个 0-100 的好感度数值。
 *
 * 复用日程生成同一套"人设上下文 + 最近聊天记录"拼 prompt 的方式（utils/scheduleGenerator.ts），
 * 只是任务更单一，不走完整的记忆宫殿注入。
 */
import { CharacterProfile, CharacterCustomMeter, UserProfile } from '../types';
import { ContextBuilder } from './context';
import { safeResponseJson, extractContent } from './safeApi';
import { loadCharacterContextRange } from './chatContextRange';
import { formatChatHistoryForSchedule } from './scheduleGenerator';
import { DB } from './db';
import { isCustomMeterHoursDue, tickCustomMeterTurns } from './customMeterAutoUpdate';

interface ApiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

async function buildPersonaAndHistoryBlock(char: CharacterProfile, user: UserProfile): Promise<string> {
  const historyMessages = await loadCharacterContextRange(char)
    .then(snapshot => snapshot.messages)
    .catch(() => []);
  const emojis = await DB.getEmojis().catch(() => []);
  const baseContext = ContextBuilder.buildCoreContext(
    char,
    user,
    true,
    undefined,
    undefined,
    { worldbookMessages: historyMessages },
  );
  const chatHistoryBlock = formatChatHistoryForSchedule(historyMessages, char, user, emojis);
  return `${baseContext}\n${chatHistoryBlock}`;
}

async function callCustomMeterApi(apiConfig: ApiConfig, char: CharacterProfile, prompt: string, purpose: string): Promise<string | null> {
  try {
    const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
      body: JSON.stringify({
        model: apiConfig.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.85,
        max_tokens: 800,
      }),
      __sullyMeta: { appName: '日程/情绪', charId: char.id, charName: char.name, purpose },
    } as RequestInit);
    if (!response.ok) {
      console.error('[CustomMeter] API error:', response.status);
      return null;
    }
    const data = await safeResponseJson(response);
    return extractContent(data);
  } catch (e) {
    console.error('[CustomMeter] Generation failed:', e);
    return null;
  }
}

/** 生成一段心声正文（第一人称内心独白，用户自定义标题 + 提示词驱动）。 */
export async function generateInnerVoiceContent(
  char: CharacterProfile,
  user: UserProfile,
  apiConfig: ApiConfig,
  entry: Pick<CharacterCustomMeter, 'title' | 'prompt'>,
): Promise<string | null> {
  const contextBlock = await buildPersonaAndHistoryBlock(char, user);
  const prompt = `${contextBlock}
## Task: 生成一段心声——「${entry.title}」

以${char.name}第一人称写一段内心独白短文（3-6 句话，不要分点、不要加标题、不要用引号包起来），主题和角度按下面这条用户给的提示词来：

${entry.prompt}

只输出独白正文本身，不要任何前后缀说明。`;
  const content = await callCustomMeterApi(apiConfig, char, prompt, `生成心声：${entry.title}`);
  return content ? content.trim() : null;
}

/** 生成/刷新一个 0-100 的好感度数值（用户自定义标题 + 提示词驱动）。 */
export async function generateAffinityValue(
  char: CharacterProfile,
  user: UserProfile,
  apiConfig: ApiConfig,
  entry: Pick<CharacterCustomMeter, 'title' | 'prompt'>,
): Promise<number | null> {
  const contextBlock = await buildPersonaAndHistoryBlock(char, user);
  const prompt = `${contextBlock}
## Task: 评估一个好感度数值——「${entry.title}」

按下面这条用户给的提示词，结合以上人设与最近对话，给出一个 0-100 的整数分数，分数含义、评分角度按提示词来：

${entry.prompt}

只输出一个 0-100 的整数，不要任何文字说明、不要百分号、不要标点。`;
  const content = await callCustomMeterApi(apiConfig, char, prompt, `评估好感度：${entry.title}`);
  if (!content) return null;
  const match = content.match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const num = Math.round(parseFloat(match[0]));
  if (Number.isNaN(num)) return null;
  return Math.max(0, Math.min(100, num));
}

/**
 * 单条 entry 按 kind 实际调一次生成，成功则带上新内容 + updatedAt 返回；失败原样返回
 * （不动 content/value，也不刷新 updatedAt——下次到期检查会再试一次，不会因为一次失败
 * 就卡住不再触发）。
 */
async function refreshCustomMeterEntry(
  kind: 'text' | 'number',
  char: CharacterProfile,
  user: UserProfile,
  apiConfig: ApiConfig,
  entry: CharacterCustomMeter,
): Promise<CharacterCustomMeter> {
  const result = kind === 'text'
    ? await generateInnerVoiceContent(char, user, apiConfig, entry)
    : await generateAffinityValue(char, user, apiConfig, entry);
  if (result === null) return entry;
  const patch = kind === 'text' ? { content: String(result) } : { value: Number(result) };
  return { ...entry, ...patch, updatedAt: Date.now() };
}

/**
 * 自动更新一轮检查——同时处理「hours」和「turns」两种节奏：
 * - tickTurns=true 时先按 turns 节奏推进一格（本地聊天每发一次请求算一轮；不到期只加计数、不生成）；
 * - 不管 tickTurns 是否传，都会顺带检查 hours 节奏是否到期——这样同一个聊天窗口里连续聊很久
 *   不切换角色，到点了也能在下一轮顺手触发，不用非得重新进一次聊天页才检查。
 * 到期的条目在这里同步调完 API 才返回（调用方自己决定 fire-and-forget，别 await 卡住主流程）。
 * 返回 null＝这组 entries 完全没变化（没有到期的，turns 计数也没变），调用方可以跳过落库。
 */
export async function checkCustomMeterAutoUpdate(
  kind: 'text' | 'number',
  char: CharacterProfile,
  user: UserProfile,
  apiConfig: ApiConfig,
  entries: CharacterCustomMeter[],
  options: { tickTurns?: boolean } = {},
): Promise<CharacterCustomMeter[] | null> {
  if (entries.length === 0) return null;
  const hasTurnsMode = !!options.tickTurns && entries.some(e => e.autoUpdate?.mode === 'turns');
  const { entries: ticked, due: dueByTurns } = hasTurnsMode
    ? tickCustomMeterTurns(entries)
    : { entries, due: [] as CharacterCustomMeter[] };
  const dueByHours = ticked.filter(e => !dueByTurns.some(d => d.id === e.id) && isCustomMeterHoursDue(e));
  const due = [...dueByTurns, ...dueByHours];
  if (due.length === 0) return hasTurnsMode ? ticked : null;
  const refreshed = await Promise.all(due.map(e => refreshCustomMeterEntry(kind, char, user, apiConfig, e)));
  const byId = new Map(refreshed.map(e => [e.id, e]));
  return ticked.map(e => byId.get(e.id) || e);
}
