import { describe, expect, it } from 'vitest';
import { parsePersonaScriptApiResponse, parsePersonaScriptResponse } from './personaSimParser';

const beats = `[
  { "kind": "thought", "monologue": "其實有點在意。" },
  { "kind": "end", "time": "23:40" }
]`;

describe('personaSimParser', () => {
  it('兼容代碼塊、前後說明和尾逗號', () => {
    const result = parsePersonaScriptResponse(`先給你結果：\n\`\`\`json
      { "title": "週二", "summary": "夜深了。", "beats": ${beats}, }
      \`\`\`\n以上是完整演出。`);

    expect(result).toMatchObject({ title: '週二', summary: '夜深了。' });
    expect(result?.beats.map(beat => beat.kind)).toEqual(['thought', 'end']);
  });

  it('兼容 script/result/data 外層包裝', () => {
    const result = parsePersonaScriptResponse(JSON.stringify({
      result: { data: { script: { title: '包裝演出', summary: '', beats: JSON.parse(beats) } } },
    }));

    expect(result?.title).toBe('包裝演出');
    expect(result?.beats.at(-1)?.kind).toBe('end');
  });

  it('修復模型寫進 JSON 字符串裡的原始換行', () => {
    const result = parsePersonaScriptResponse(`{
      "title": "換行",
      "summary": "",
      "beats": [
        { "kind": "thought", "monologue": "第一句
第二句" },
        { "kind": "end" }
      ]
    }`);

    expect(result?.beats[0].monologue).toBe('第一句\n第二句');
  });

  it('從 reasoning_content 或分段 content 中提取正文', () => {
    const reasoningResult = parsePersonaScriptApiResponse({
      choices: [{ message: { content: '', reasoning_content: `{ "title": "思考模型", "summary": "", "beats": ${beats} }` } }],
    });
    const segmentedResult = parsePersonaScriptApiResponse({
      choices: [{ message: { content: [{ type: 'text', text: `{ "title": "分段正文", "summary": "", "beats": ${beats} }` }] } }],
    });

    expect(reasoningResult.script?.title).toBe('思考模型');
    expect(segmentedResult.script?.title).toBe('分段正文');
  });

  it('沒有有效 beats 時拒絕播放', () => {
    expect(parsePersonaScriptResponse('{ "title": "空", "beats": [] }')).toBeNull();
    expect(parsePersonaScriptResponse('模型拒絕生成這段內容')).toBeNull();
  });
});
