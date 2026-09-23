import type { Category, FaceLandmarker, FaceLandmarkerResult } from '@mediapipe/tasks-vision';

export type UserCameraEmotion = 'neutral' | 'happy' | 'surprised' | 'sad' | 'angry' | 'disgusted' | 'tired';

export interface UserCameraEmotionResult {
  emotion: UserCameraEmotion;
  label: string;
  confidence: number;
}

const EMOTION_LABELS: Record<UserCameraEmotion, string> = {
  neutral: '平靜',
  happy: '開心',
  surprised: '驚訝',
  sad: '低落',
  angry: '不悅',
  disgusted: '嫌棄',
  tired: '疲憊',
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const average = (...values: number[]): number => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
const median = (...values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : average(sorted[middle - 1], sorted[middle]);
};
const score = (shapes: ReadonlyMap<string, number>, name: string): number => clamp01(shapes.get(name) || 0);

export const blendshapeCategoriesToMap = (categories: readonly Pick<Category, 'categoryName' | 'score'>[]): Map<string, number> => {
  const values = new Map<string, number>();
  categories.forEach(category => {
    const name = String(category.categoryName || '').trim();
    if (!name) return;
    values.set(name, Math.max(values.get(name) || 0, clamp01(Number(category.score))));
  });
  return values;
};

/**
 * Blendshape coefficients have very different useful ranges. Requiring every
 * expression to cross one shared raw-score threshold made normal webcam
 * expressions collapse to neutral, especially surprise, sadness and anger.
 * Each candidate therefore has its own activation threshold and a small
 * feature gate that rejects common resting-face noise.
 */
export const classifyUserCameraBlendshapes = (shapes: ReadonlyMap<string, number>): UserCameraEmotionResult => {
  const smile = average(score(shapes, 'mouthSmileLeft'), score(shapes, 'mouthSmileRight'));
  const frown = average(score(shapes, 'mouthFrownLeft'), score(shapes, 'mouthFrownRight'));
  const browDown = average(score(shapes, 'browDownLeft'), score(shapes, 'browDownRight'));
  const eyeWide = average(score(shapes, 'eyeWideLeft'), score(shapes, 'eyeWideRight'));
  const eyeClosed = average(score(shapes, 'eyeBlinkLeft'), score(shapes, 'eyeBlinkRight'));
  const cheekSquint = average(score(shapes, 'cheekSquintLeft'), score(shapes, 'cheekSquintRight'));
  const noseSneer = average(score(shapes, 'noseSneerLeft'), score(shapes, 'noseSneerRight'));
  const mouthPress = average(score(shapes, 'mouthPressLeft'), score(shapes, 'mouthPressRight'));
  const mouthUpper = average(score(shapes, 'mouthUpperUpLeft'), score(shapes, 'mouthUpperUpRight'));
  const jawOpen = score(shapes, 'jawOpen');
  const browInnerUp = score(shapes, 'browInnerUp');

  const candidates: Array<{
    emotion: Exclude<UserCameraEmotion, 'neutral'>;
    value: number;
    threshold: number;
    eligible: boolean;
  }> = [
    {
      emotion: 'happy',
      value: smile * 0.76 + cheekSquint * 0.24,
      threshold: 0.28,
      eligible: smile >= 0.22,
    },
    {
      emotion: 'surprised',
      value: jawOpen * 0.44 + eyeWide * 0.34 + browInnerUp * 0.22 - smile * 0.16,
      threshold: 0.28,
      eligible: jawOpen >= 0.22 && (eyeWide >= 0.1 || browInnerUp >= 0.16),
    },
    {
      emotion: 'sad',
      value: frown * 0.56 + browInnerUp * 0.32 + mouthPress * 0.12,
      threshold: 0.24,
      eligible: frown >= 0.18 && browInnerUp >= 0.08,
    },
    {
      emotion: 'angry',
      value: browDown * 0.56 + mouthPress * 0.26 + noseSneer * 0.18,
      threshold: 0.24,
      eligible: browDown >= 0.18 && (mouthPress >= 0.08 || noseSneer >= 0.06 || frown >= 0.1),
    },
    {
      emotion: 'disgusted',
      value: noseSneer * 0.52 + mouthUpper * 0.30 + browDown * 0.18,
      threshold: 0.22,
      eligible: noseSneer >= 0.16 && (mouthUpper >= 0.1 || browDown >= 0.08),
    },
    {
      emotion: 'tired',
      value: eyeClosed * 0.8 + mouthPress * 0.2,
      threshold: 0.58,
      eligible: eyeClosed >= 0.58,
    },
  ].map(item => ({ ...item, value: item.eligible ? clamp01(item.value) : 0 }));
  candidates.sort((a, b) => (b.value / b.threshold) - (a.value / a.threshold));
  const winner = candidates[0];
  const runnerUp = candidates[1];
  const activation = winner.value / winner.threshold;
  const runnerUpActivation = runnerUp ? runnerUp.value / runnerUp.threshold : 0;
  const decisive = winner.eligible && activation >= 1;
  const emotion: UserCameraEmotion = decisive ? winner.emotion : 'neutral';
  const confidence = emotion === 'neutral'
    ? clamp01(0.54 + Math.max(0, 1 - activation) * 0.18)
    : clamp01(0.58 + Math.max(0, activation - 1) * 0.24 + Math.max(0, activation - runnerUpActivation) * 0.08);
  return { emotion, label: EMOTION_LABELS[emotion], confidence };
};

const resolvePublicAsset = (path: string): string => {
  const base = String(import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');
  return `${base}${path.replace(/^\//, '')}`;
};

let landmarkerPromise: Promise<FaceLandmarker> | null = null;
let activeLandmarker: FaceLandmarker | null = null;
let lastVideoTimestamp = 0;
let detectorGeneration = 0;

const createLandmarker = async (): Promise<FaceLandmarker> => {
  const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
  const fileset = await FilesetResolver.forVisionTasks(resolvePublicAsset('mediapipe/wasm'));
  const sharedOptions = {
    baseOptions: { modelAssetPath: resolvePublicAsset('mediapipe/models/face_landmarker.task') },
    runningMode: 'VIDEO' as const,
    numFaces: 1,
    minFaceDetectionConfidence: 0.55,
    minFacePresenceConfidence: 0.55,
    minTrackingConfidence: 0.5,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: false,
  };
  try {
    return await FaceLandmarker.createFromOptions(fileset, {
      ...sharedOptions,
      baseOptions: { ...sharedOptions.baseOptions, delegate: 'GPU' },
    });
  } catch (gpuError) {
    console.warn('[camera-emotion] GPU delegate unavailable; using CPU:', gpuError);
    return FaceLandmarker.createFromOptions(fileset, sharedOptions);
  }
};

export const preloadUserCameraEmotionDetector = async (): Promise<void> => {
  if (!landmarkerPromise) {
    const generation = detectorGeneration;
    landmarkerPromise = createLandmarker()
      .then(landmarker => {
        if (generation !== detectorGeneration) {
          try { landmarker.close(); } catch { /* released while loading */ }
          throw new Error('本地識別已取消');
        }
        activeLandmarker = landmarker;
        return landmarker;
      })
      .catch(error => {
        if (generation === detectorGeneration) {
          landmarkerPromise = null;
          activeLandmarker = null;
        }
        throw error;
      });
  }
  await landmarkerPromise;
};

const detectFrame = (landmarker: FaceLandmarker, video: HTMLVideoElement): FaceLandmarkerResult => {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  lastVideoTimestamp = Math.max(lastVideoTimestamp + 1, now);
  return landmarker.detectForVideo(video, lastVideoTimestamp);
};

const delay = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));

/** Samples three frames and takes their median so one blink/noisy frame cannot dominate. */
export const detectUserCameraEmotion = async (video: HTMLVideoElement): Promise<UserCameraEmotionResult | null> => {
  if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return null;
  await preloadUserCameraEmotionDetector();
  const landmarker = await landmarkerPromise;
  if (!landmarker) return null;
  const aggregate = new Map<string, number[]>();
  for (let index = 0; index < 3; index += 1) {
    if (index) await delay(70);
    const result = detectFrame(landmarker, video);
    const categories = result.faceBlendshapes?.[0]?.categories;
    if (!categories?.length) continue;
    const frame = blendshapeCategoriesToMap(categories);
    frame.forEach((value, name) => aggregate.set(name, [...(aggregate.get(name) || []), value]));
  }
  if (!aggregate.size) return null;
  return classifyUserCameraBlendshapes(new Map(
    [...aggregate].map(([name, values]) => [name, median(...values)]),
  ));
};

export const buildUserCameraEmotionPrompt = (result: UserCameraEmotionResult): string => `【當前輪次的本地攝像頭非語言信息】
用戶主動開啟了攝像頭。本地面部識別在用戶發送消息前檢測到：${result.label}（內部標籤 ${result.emotion}，置信度 ${Math.round(result.confidence * 100)}%）。
這只是可能有誤差的即時非語言線索，不是用戶明確陳述，也不是醫學或心理判斷。結合用戶文字自然回應；若文字語義與識別衝突，以文字為準。不要向用戶解釋識別系統、置信度或本段提示。`;

export const releaseUserCameraEmotionDetector = (): void => {
  detectorGeneration += 1;
  try { activeLandmarker?.close(); } catch { /* best-effort WASM cleanup */ }
  activeLandmarker = null;
  landmarkerPromise = null;
  lastVideoTimestamp = 0;
};
