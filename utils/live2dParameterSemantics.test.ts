import { describe, expect, it } from 'vitest';
import {
  describeLive2DParameter,
  groupLive2DParameters,
  live2DParameterPosition,
} from './live2dParameterSemantics';

describe('Live2D 參數語義', () => {
  it('把常見 Cubism 參數翻譯成作用部位和可理解方向', () => {
    expect(describeLive2DParameter('ParamEyeLOpen')).toMatchObject({
      area: 'eyes',
      label: '左眼開合',
      negativeLabel: '閉合',
      positiveLabel: '睜開',
    });
    expect(describeLive2DParameter('ParamMouthForm')).toMatchObject({
      area: 'mouth',
      negativeLabel: '嘟嘴',
      positiveLabel: '微笑',
    });
    expect(describeLive2DParameter('ParamAngleY')).toMatchObject({
      area: 'head',
      negativeLabel: '低頭',
      positiveLabel: '抬頭',
    });
  });

  it('對模型自定義參數明確保留原始 ID 與未知語義', () => {
    expect(describeLive2DParameter('ParamSpecialStarEye')).toMatchObject({
      area: 'other',
      label: 'ParamSpecialStarEye',
      negativeLabel: '最小值',
      positiveLabel: '最大值',
    });
  });

  it('按語義部位分組並計算默認點在軌道上的位置', () => {
    const groups = groupLive2DParameters([
      { id: 'ParamMouthOpenY' },
      { id: 'ParamEyeROpen' },
      { id: 'ParamMouthForm' },
    ]);
    expect(groups.map(group => [group.area, group.parameters.length])).toEqual([
      ['mouth', 2],
      ['eyes', 1],
    ]);
    expect(live2DParameterPosition(0, -1, 1)).toBe(50);
    expect(live2DParameterPosition(4, 0, 2)).toBe(100);
  });
});
