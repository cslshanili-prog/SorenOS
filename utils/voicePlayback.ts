/**
 * 聊天語音條：什麼時候合成、合成完要不要立刻響。
 *
 * 一句話版本：角色開了「收到就自動播放」，AI 的語音消息才會自己合成並響；
 * 沒開就只留一條空語音條，用戶點了才合成，合成完直接播。
 */

/**
 * AI 消息到達後要不要順手把語音合成出來。
 *
 * 只認「收到就自動播放」這一個開關：沒開的話合出來也不會響，等於替用戶白花一次 TTS 調用
 * （還佔著額度和時間）。空語音條照常顯示，想聽點一下就合成——那條路走的是下面的手動分支，
 * 合完立刻播，體驗上只多等一次合成。
 */
export function shouldAutoGenerateVoice(opts: {
  /** 角色的「收到就自動播放」開關，未設置視作關 */
  autoPlayEnabled?: boolean;
}): boolean {
  return !!opts.autoPlayEnabled;
}

/**
 * 語音合成完要不要立刻響。兩條規則各有來由，別合併簡化：
 *  - AI 自動發來的語音，跟著「收到就自動播放」走（也只有開了這個開關才會自動合成）。
 *  - 用戶主動要的語音（長按「轉換語音」、點還沒合成的空語音條），無論開關怎麼設都播——
 *    他點這一下的意思就是「我現在要聽」，還要再點一次播放屬於白跑一趟。
 */
export function shouldAutoPlayGeneratedVoice(opts: {
  /** 這次合成是 AI 消息到達後自動觸發的（false = 用戶主動點的） */
  autoTriggered: boolean;
  /** 角色的「收到就自動播放」開關，未設置視作關 */
  autoPlayEnabled?: boolean;
}): boolean {
  if (!opts.autoTriggered) return true;
  return !!opts.autoPlayEnabled;
}

const SILENT_AUDIO = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAACAgICA';
const audioOperations = new WeakMap<HTMLAudioElement, { priming: boolean; source?: string }>();

export const isVoiceAudioPriming = (audio: HTMLAudioElement): boolean => {
  const operation = audioOperations.get(audio);
  return operation?.priming === true && audio.src === operation.source;
};

/** Must run inside the click handler, before waiting for synthesis/network. */
export function primeVoiceAudio(audio: HTMLAudioElement, silence = SILENT_AUDIO): void {
  if (!audio.paused && audio.src) return;
  const operation = { priming: true, source: silence };
  audioOperations.set(audio, operation);
  audio.src = silence;
  try {
    void Promise.resolve(audio.play()).then(() => {
      if (audioOperations.get(audio) !== operation || audio.src !== silence) return;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      operation.priming = false;
    }, () => { operation.priming = false; });
  } catch { operation.priming = false; }
}

export function stopVoiceAudio(audio: HTMLAudioElement): void {
  audioOperations.delete(audio);
  audio.onended = null;
  audio.onerror = null;
  audio.onpause = null;
  audio.pause();
}

export function voicePlaybackErrorMessage(error: unknown, replayLabel = '語音條'): string {
  if ((error as { name?: string })?.name === 'NotAllowedError') {
    return `瀏覽器未允許播放，請點“${replayLabel}”繼續；無需重新生成語音。`;
  }
  return `音頻加載或播放失敗，請點“${replayLabel}”重試播放；若是舊音頻鏈接，可能已過期。`;
}

/** Report playback only after play() succeeds; stale attempts cannot reset a newer voice. */
export async function playVoiceAudio(audio: HTMLAudioElement, url: string, callbacks: {
  onPlaying: () => void; onStopped: () => void; onError: (error: unknown) => void;
}): Promise<void> {
  const operation = { priming: false };
  audioOperations.set(audio, operation);
  let failed = false;
  const isCurrent = () => audioOperations.get(audio) === operation;
  const fail = (error: unknown) => {
    if (!isCurrent() || failed) return;
    failed = true;
    callbacks.onStopped();
    callbacks.onError(error);
  };
  audio.onended = () => { if (isCurrent()) callbacks.onStopped(); };
  audio.onpause = () => { if (isCurrent() && audio.paused) callbacks.onStopped(); };
  audio.onerror = () => fail(audio.error);
  try {
    audio.src = url;
    await audio.play();
    if (isCurrent() && !failed && !audio.paused) callbacks.onPlaying();
  } catch (error) { fail(error); }
}

/** Remote fallbacks must stay out of WebAudio: cross-origin media sources output silence. */
export function canAnalyzeVoiceSource(url: string, pageOrigin?: string): boolean {
  if (/^(blob:|data:audio\/)/i.test(url)) return true;
  try {
    const origin = pageOrigin ?? (typeof location !== 'undefined' ? location.origin : undefined);
    return !!origin && new URL(url, origin).origin === origin;
  } catch { return false; }
}
