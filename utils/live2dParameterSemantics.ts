export type Live2DParameterArea =
  | 'eyes'
  | 'brows'
  | 'mouth'
  | 'face'
  | 'head'
  | 'body'
  | 'arms'
  | 'hair'
  | 'effects'
  | 'tracking'
  | 'other';

export interface Live2DParameterSemantics {
  area: Live2DParameterArea;
  areaLabel: string;
  label: string;
  description: string;
  negativeLabel: string;
  positiveLabel: string;
}

const AREA_LABELS: Record<Live2DParameterArea, string> = {
  eyes: '眼睛',
  brows: '眉毛',
  mouth: '嘴部',
  face: '面部',
  head: '頭部',
  body: '身體',
  arms: '手臂',
  hair: '頭髮',
  effects: '效果',
  tracking: '追蹤輸入',
  other: '其他',
};

const sideLabel = (id: string): string => {
  if (/(?:^|Param)(?:Eye|Brow|Arm)L/i.test(id) || /Left/i.test(id)) return '左';
  if (/(?:^|Param)(?:Eye|Brow|Arm)R/i.test(id) || /Right/i.test(id)) return '右';
  return '';
};

const result = (
  area: Live2DParameterArea,
  label: string,
  description: string,
  negativeLabel: string,
  positiveLabel: string,
): Live2DParameterSemantics => ({
  area,
  areaLabel: AREA_LABELS[area],
  label,
  description,
  negativeLabel,
  positiveLabel,
});

/**
 * Converts common Cubism/VTube Studio parameter IDs into editing language.
 * Unknown model-specific IDs stay editable and are clearly marked as such.
 */
export const describeLive2DParameter = (parameterId: string): Live2DParameterSemantics => {
  const id = parameterId.trim();
  const side = sideLabel(id);

  if (/ParamEye[LR]Open/i.test(id)) {
    return result('eyes', `${side}眼開合`, `控制${side || '雙'}眼眼皮的張合程度。`, '閉合', '睜開');
  }
  if (/ParamEye[LR]Smile/i.test(id)) {
    return result('eyes', `${side}眼笑意`, `控制${side || '雙'}眼笑眼或眯眼的程度。`, '放鬆', '笑眼');
  }
  if (/ParamEyeBallX/i.test(id)) {
    return result('eyes', '視線左右', '控制眼球橫向注視方向。', '看左', '看右');
  }
  if (/ParamEyeBallY/i.test(id)) {
    return result('eyes', '視線上下', '控制眼球縱向注視方向。', '看下', '看上');
  }
  if (/ParamBrow[LR]Y/i.test(id)) {
    return result('brows', `${side}眉高度`, `控制${side || '雙'}側眉毛的高低。`, '壓低', '抬高');
  }
  if (/ParamBrow[LR]Angle/i.test(id)) {
    return result('brows', `${side}眉傾斜`, `控制${side || '雙'}側眉毛的傾斜方向。`, '向下傾', '向上傾');
  }
  if (/ParamBrow[LR]Form/i.test(id)) {
    return result('brows', `${side}眉形`, '模型作者定義的眉形變化；請直接觀察上方模型。', '形狀 −', '形狀 +');
  }
  if (/ParamMouthOpenY/i.test(id)) {
    return result('mouth', '嘴巴開合', '控制嘴巴從閉合到張開的程度。', '閉嘴', '張嘴');
  }
  if (/ParamMouthForm/i.test(id)) {
    return result('mouth', '嘴型', '控制嘴角與嘴型，標準模型通常由嘟嘴過渡到微笑。', '嘟嘴', '微笑');
  }
  if (/ParamCheek/i.test(id)) {
    return result('face', '臉頰效果', '通常控制臉紅、腮紅或臉頰膨脹，具體以模型預覽為準。', '關閉', '增強');
  }
  if (/ParamAngleX/i.test(id)) {
    return result('head', '頭部左右轉', '控制頭部橫向轉動。', '轉左', '轉右');
  }
  if (/ParamAngleY/i.test(id)) {
    return result('head', '頭部抬低', '控制頭部向下或向上轉動。', '低頭', '抬頭');
  }
  if (/ParamAngleZ/i.test(id)) {
    return result('head', '頭部傾斜', '控制頭部向兩側傾斜。', '左傾', '右傾');
  }
  if (/ParamBodyAngleX/i.test(id)) {
    return result('body', '身體左右轉', '控制上半身橫向轉動。', '轉左', '轉右');
  }
  if (/ParamBodyAngleY/i.test(id)) {
    return result('body', '身體前後傾', '控制上半身前傾或後仰；方向可能由模型作者反轉。', '方向 −', '方向 +');
  }
  if (/ParamBodyAngleZ/i.test(id)) {
    return result('body', '身體側傾', '控制上半身向兩側傾斜。', '左傾', '右傾');
  }
  if (/ParamArm/i.test(id)) {
    return result('arms', `${side}臂動作`, `控制${side || '對應'}手臂的模型專屬動作。`, '方向 −', '方向 +');
  }
  if (/ParamBreath/i.test(id)) {
    return result('body', '呼吸', '控制模型的呼吸循環幅度。', '呼出', '吸入');
  }
  if (/Hair|Ribbon|Accessory|Physics/i.test(id)) {
    return result('hair', '頭髮 / 配件', '模型專屬的頭髮、飄帶或物理輔助參數。', '方向 −', '方向 +');
  }
  if (/Opacity|Alpha|Display|Effect/i.test(id)) {
    return result('effects', '顯示效果', '控制模型專屬部件的透明度或視覺效果。', '減弱', '增強');
  }
  if (/^(?:x|y|z)inb?$/i.test(id)) {
    const axis = id[0]?.toUpperCase() || '';
    const body = /b$/i.test(id);
    return result(
      'tracking',
      `${body ? '身體' : '頭部'}追蹤 ${axis}`,
      'VTube Studio 風格的追蹤輸入，通常會通過模型物理聯動多個部位。',
      '輸入 −',
      '輸入 +',
    );
  }

  return result(
    'other',
    id || '未命名參數',
    '這是模型作者自定義的參數，含義無法從名稱可靠判斷；拖動時請直接觀察上方模型。',
    '最小值',
    '最大值',
  );
};

export const groupLive2DParameters = <T extends { id: string }>(
  parameters: T[],
): Array<{ area: Live2DParameterArea; label: string; parameters: T[] }> => {
  const groups = new Map<Live2DParameterArea, T[]>();
  parameters.forEach(parameter => {
    const area = describeLive2DParameter(parameter.id).area;
    groups.set(area, [...(groups.get(area) || []), parameter]);
  });
  return Array.from(groups.entries()).map(([area, items]) => ({
    area,
    label: AREA_LABELS[area],
    parameters: items,
  }));
};

export const live2DParameterPosition = (
  value: number,
  min: number,
  max: number,
): number => {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) return 50;
  return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
};
