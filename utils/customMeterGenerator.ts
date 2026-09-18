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
