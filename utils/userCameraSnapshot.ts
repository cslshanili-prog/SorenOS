export interface UserCameraSnapshotSize {
  width: number;
  height: number;
}

export interface CameraChatMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

export const fitUserCameraSnapshot = (
  sourceWidth: number,
  sourceHeight: number,
  maxEdge = 640,
): UserCameraSnapshotSize | null => {
  const width = Math.floor(Number(sourceWidth));
  const height = Math.floor(Number(sourceHeight));
  const limit = Math.max(160, Math.min(1280, Math.floor(Number(maxEdge) || 640)));
  if (width <= 0 || height <= 0) return null;
  const scale = Math.min(1, limit / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
};

/**
 * Captures one mirrored frame, matching the user's on-screen selfie preview.
 * The data URL itself is transient. CallApp may convert the compressed frame
 * into a blobref for the local transcript, where retention is capped separately.
 */
export const captureUserCameraSnapshot = (
  video: HTMLVideoElement,
  maxEdge = 640,
  quality = 0.76,
): string | null => {
  if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
  const size = fitUserCameraSnapshot(video.videoWidth, video.videoHeight, maxEdge);
  if (!size) return null;
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) return null;
  // The preview is mirrored. Submit the exact composition the user saw.
  context.translate(size.width, 0);
  context.scale(-1, 1);
  context.drawImage(video, 0, 0, size.width, size.height);
  return canvas.toDataURL('image/jpeg', Math.max(0.55, Math.min(0.86, quality)));
};

export const attachSnapshotToLatestUserMessage = <T extends CameraChatMessage>(
  messages: readonly T[],
  snapshotDataUrl: string,
): T[] => {
  if (!snapshotDataUrl.startsWith('data:image/')) return [...messages];
  const targetIndex = [...messages].map(message => message.role).lastIndexOf('user');
  if (targetIndex < 0) return [...messages];
  return messages.map((message, index) => {
    if (index !== targetIndex) return message;
    const text = typeof message.content === 'string'
      ? message.content
      : '（本輪用戶消息隨附一張發送瞬間的攝像頭快照）';
    return {
      ...message,
      content: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: snapshotDataUrl } },
      ],
    } as T;
  });
};

/** Only retry without the image when the provider explicitly rejects vision input. */
export const isVisionInputUnsupportedError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error || '');
  return /image_url|image input|vision|multimodal|multi-modal|unsupported[^\n]*image|does not support[^\n]*image|unknown variant[^\n]*image|content[^\n]*array/i.test(message);
};

export const USER_CAMERA_SNAPSHOT_SYSTEM_NOTE = `【本輪用戶攝像頭快照】
用戶主動選擇了“每輪快照”模式；最後一條用戶消息附帶的是點擊發送瞬間的一幀，僅作為當前對話的即時非語言線索。自然結合畫面與文字回應；文字語義優先。不要進行身份、醫學或心理診斷，也不要解釋系統如何獲得圖片。`;
