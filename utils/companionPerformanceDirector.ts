import type { APIConfig, CharacterProfile } from '../types';
import type { AvatarTouchModelAction } from './avatarTouch';
import {
  AVATAR_PERFORMANCE_REHEARSAL_MAX_TOKENS,
  alignAvatarPerformanceCuesToSentences,
  buildAvatarPerformanceRehearsalPrompt,
  isCompleteAvatarPerformanceCuePack,
  parseAvatarPerformanceRehearsal,
  splitAvatarPerformanceSentences,
  type AvatarPerformanceSentence,
} from './avatarPerformanceRehearsal';
import type { AvatarPerformanceCue } from './avatarPerformance';
import { extractContent, safeFetchJson } from './safeApi';

export type CompanionPerformanceSentence = AvatarPerformanceSentence;

/** The spoken text owns the timeline: one deterministic beat per sentence. */
export const splitCompanionPerformanceSentences = splitAvatarPerformanceSentences;

export const alignCompanionPerformanceCuesToSentences = (
  cues: AvatarPerformanceCue[],
  spokenText: string,
): AvatarPerformanceCue[] => alignAvatarPerformanceCuesToSentences(cues, spokenText);

export interface CompanionPerformanceDirectorInput {
  character: CharacterProfile;
  apiConfig: APIConfig;
  line: string;
  translation?: string;
  modelActions?: AvatarTouchModelAction[];
}

const buildLocalPersona = (character: CharacterProfile): string => {
  const source = character.videoCallPerformancePersona || [
    character.personalityStyle,
    character.description,
    character.systemPrompt,
  ].filter(Boolean).join(' ');
  return Array.from(source.replace(/\s+/g, ' ').trim()).slice(0, 200).join('');
};

/**
 * One isolated director request. There is deliberately no retry, repair request,
 * or locally invented cue pack: an unusable response is surfaced to the user.
 */
export const requestCompanionPerformanceCues = async ({
  character,
  apiConfig,
  line,
  translation = '',
  modelActions = [],
}: CompanionPerformanceDirectorInput): Promise<AvatarPerformanceCue[]> => {
  const directorApi = character.emotionConfig?.api?.baseUrl
    ? character.emotionConfig.api
    : apiConfig;
  const baseUrl = directorApi.baseUrl?.replace(/\/+$/, '');
  if (!baseUrl) throw new Error('請先配置聊天 API URL');
  const reply = translation.trim()
    ? `${line.trim()}\n<語音>${translation.trim()}</語音>`
    : line.trim();
  if (!reply) throw new Error('請先填寫開機台詞');

  const spokenText = translation.trim() || line.trim();
  const sentences = splitCompanionPerformanceSentences(spokenText);
  if (!sentences.length) throw new Error('開機台詞沒有可編排的句子');

  const basePrompt = buildAvatarPerformanceRehearsalPrompt({
    characterName: character.name,
    personality: buildLocalPersona(character),
    reply,
    modelActions,
  });
  const sentencePlan = sentences
    .map((sentence, index) => `${index + 1}. at=${sentence.at.toFixed(4)}：${sentence.text}`)
    .join('\n');
  const prompt = `${basePrompt}

## 桌面逐句編排補充
- 嚴格返回 ${sentences.length} 個 cues，每句話一個 cue；每個 cue 必須同時給出 start、hold_ms、end。
- start 是句子開頭動作，end 是句末動作，hold_ms 是兩者之間的保持時長（120-5000ms）。
- 每句收尾要有語義：落住表情、視線或身體，而不是所有句子統一歸零。

## 陪伴桌面開機演出覆蓋規則
- 禁止任何隨機左右轉頭。默認頭部正中；只有台詞語義明確需要時，才可在對應句 cue 中有意指定一次 nod / shake / tilt、左右視線、precision 頭部角度或帶頭部曲線的白名單 model_actions。
- 必須嚴格按下面的句子表返回 ${sentences.length} 個 cues：每句話一個主動作，不可合併、不可拆分、不可增加過場拍。
- 每句可組合 emotion、一個 gesture、最多四個 face、鏡頭和白名單 model_actions；優先讓表情、手臂、身體前後傾和模型專屬動作承擔變化，頭部動作必須少而明確。
- faces 只是疊加層，不能作為整句的唯一變化；每個 start 和 end 至少有一個可讀的 gesture、身體輪廓變化或 [motion] 模型動作。
- 白名單條目帶有動作種類和語義標籤。存在匹配的 [motion] 時優先採用，不能用 [expression] 冒充身體動作。
- 除非角色在這一句刻意克制，intensity 使用 0.65-0.95；充分調動頭部 XYZ、身體 XYZ 和手臂，不要把精細模型壓成只換表情的立繪。
- at 必須照抄句子表。不要讓相鄰兩句使用完全相同的 gesture + face + camera 組合。

## 逐句動作表
${sentencePlan}`;
  const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${directorApi.apiKey || 'sk-none'}`,
    },
    body: JSON.stringify({
      model: directorApi.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.45,
      max_tokens: AVATAR_PERFORMANCE_REHEARSAL_MAX_TOKENS,
      stream: false,
    }),
  }, 0, 30_000, {
    appName: '陪伴桌面',
    charId: character.id,
    charName: character.name,
    purpose: '一次性編排開機台詞動作（不重試）',
  });
  const cues = parseAvatarPerformanceRehearsal(
    extractContent(data),
    modelActions.map(action => action.id),
    sentences.length,
  );
  if (!cues?.length) throw new Error('動作導演這次沒有返回可用動作；未保存，也不會重試');
  if (!isCompleteAvatarPerformanceCuePack(cues, sentences.length)) {
    throw new Error('動作導演必須為每句話返回起始動作、中段保持時長和收尾動作；這次結果未保存，也不會重試');
  }
  return alignCompanionPerformanceCuesToSentences(cues, spokenText);
};
