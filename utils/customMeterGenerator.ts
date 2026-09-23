/**
 * 「日程/情緒」面板裡用戶自定義的心聲 / 好感度條目——按用戶自己填的標題 + 提示詞，
 * 調用角色當前生效的 API 生成一段心聲短文，或刷新一個 0-100 的好感度數值。
 *
 * 複用日程生成同一套"人設上下文 + 最近聊天記錄"拼 prompt 的方式（utils/scheduleGenerator.ts），
 * 只是任務更單一，不走完整的記憶宮殿注入。
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
      __sullyMeta: { appName: '日程/情緒', charId: char.id, charName: char.name, purpose },
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

/** 生成一段心聲正文（第一人稱內心獨白，用戶自定義標題 + 提示詞驅動）。 */
export async function generateInnerVoiceContent(
  char: CharacterProfile,
  user: UserProfile,
  apiConfig: ApiConfig,
  entry: Pick<CharacterCustomMeter, 'title' | 'prompt'>,
): Promise<string | null> {
  const contextBlock = await buildPersonaAndHistoryBlock(char, user);
  const prompt = `${contextBlock}
## Task: 生成一段心聲——「${entry.title}」

以${char.name}第一人稱寫一段內心獨白短文（3-6 句話，不要分點、不要加標題、不要用引號包起來），主題和角度按下面這條用戶給的提示詞來：

${entry.prompt}

只輸出獨白正文本身，不要任何前後綴說明。`;
  const content = await callCustomMeterApi(apiConfig, char, prompt, `生成心聲：${entry.title}`);
  return content ? content.trim() : null;
}

/** 生成/刷新一個 0-100 的好感度數值 + 一句第一人稱狀態心聲（用戶自定義標題 + 提示詞驅動）。 */
export async function generateAffinityValue(
  char: CharacterProfile,
  user: UserProfile,
  apiConfig: ApiConfig,
  entry: Pick<CharacterCustomMeter, 'title' | 'prompt'>,
): Promise<{ value: number; note: string } | null> {
  const contextBlock = await buildPersonaAndHistoryBlock(char, user);
  const prompt = `${contextBlock}
## Task: 評估一個好感度數值——「${entry.title}」

按下面這條用戶給的提示詞，結合以上人設與最近對話，給出一個 0-100 的整數分數，分數含義、評分角度按提示詞來：

${entry.prompt}

同時以${char.name}的第一人稱語氣，寫一句此刻的心聲——像一句貼合這個分數當下心理狀態的內心獨白，不要出現"分數""好感度"這幾個字本身，不要用引號包起來。

只按下面這個格式輸出，不要任何多餘文字或標題：
第一行：分數（0-100 的整數，不要百分號不要標點）
第二行：那句心聲（一句話，20 字以內）`;
  const content = await callCustomMeterApi(apiConfig, char, prompt, `評估好感度：${entry.title}`);
  if (!content) return null;
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  const match = (lines[0] || '').match(/-?\d+(\.\d+)?/) || content.match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const num = Math.round(parseFloat(match[0]));
  if (Number.isNaN(num)) return null;
  const value = Math.max(0, Math.min(100, num));
  const note = (lines[1] || '').replace(/^[“"'「]|[”"'」]$/g, '').trim();
  return { value, note };
}

/**
 * 單條 entry 按 kind 實際調一次生成，成功則帶上新內容 + updatedAt 返回；失敗原樣返回
 * （不動 content/value，也不刷新 updatedAt——下次到期檢查會再試一次，不會因為一次失敗
 * 就卡住不再觸發）。
 */
async function refreshCustomMeterEntry(
  kind: 'text' | 'number',
  char: CharacterProfile,
  user: UserProfile,
  apiConfig: ApiConfig,
  entry: CharacterCustomMeter,
): Promise<CharacterCustomMeter> {
  if (kind === 'text') {
    const content = await generateInnerVoiceContent(char, user, apiConfig, entry);
    if (content === null) return entry;
    return { ...entry, content, updatedAt: Date.now() };
  }
  const result = await generateAffinityValue(char, user, apiConfig, entry);
  if (result === null) return entry;
  return { ...entry, value: result.value, statusNote: result.note, updatedAt: Date.now() };
}

/**
 * 自動更新一輪檢查——同時處理「hours」和「turns」兩種節奏：
 * - tickTurns=true 時先按 turns 節奏推進一格（本地聊天每發一次請求算一輪；不到期只加計數、不生成）；
 * - 不管 tickTurns 是否傳，都會順帶檢查 hours 節奏是否到期——這樣同一個聊天窗口裡連續聊很久
 *   不切換角色，到點了也能在下一輪順手觸發，不用非得重新進一次聊天頁才檢查。
 * 到期的條目在這裡同步調完 API 才返回（調用方自己決定 fire-and-forget，別 await 卡住主流程）。
 * 返回 null＝這組 entries 完全沒變化（沒有到期的，turns 計數也沒變），調用方可以跳過落庫。
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
