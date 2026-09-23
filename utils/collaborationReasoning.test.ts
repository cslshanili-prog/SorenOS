import { describe, expect, it } from 'vitest';
import { parseCollaborationReply, visibleCollaborationStreamText } from '../features/collaboration/reasoning';

describe('collaboration reasoning output', () => {
  it('keeps a native reasoning channel separate from the delivered content', () => {
    expect(parseCollaborationReply({
      choices: [{ message: { content: '這是交付正文。', reasoning_content: '先核對需求，再生成文件。' } }],
    })).toEqual({
      content: '這是交付正文。',
      thinkingChain: '先核對需求，再生成文件。',
    });
  });

  it('extracts inline think blocks without leaking tags into the deliverable', () => {
    expect(parseCollaborationReply({
      choices: [{ message: { content: '<think>先檢查格式。</think>\n文件已經整理好了。' } }],
    })).toEqual({
      content: '文件已經整理好了。',
      thinkingChain: '先檢查格式。',
    });
  });

  it('understands typed content arrays used by Anthropic-compatible responses', () => {
    expect(parseCollaborationReply({
      choices: [{ message: { content: [
        { type: 'thinking', thinking: '得先把標題層級校準。' },
        { type: 'text', text: '標題層級已經校準。' },
      ] } }],
    })).toEqual({
      content: '標題層級已經校準。',
      thinkingChain: '得先把標題層級校準。',
    });
  });

  it('uses reasoning as the answer when a broken proxy leaves content empty', () => {
    expect(parseCollaborationReply({
      choices: [{ message: { content: '', reasoning: '代理把最終答案放錯字段了。' } }],
    })).toEqual({ content: '代理把最終答案放錯字段了。' });
  });

  it('hides an unfinished inline thinking block from the streaming draft', () => {
    expect(visibleCollaborationStreamText('<think>還在核對第三')).toBe('');
    expect(visibleCollaborationStreamText('<think>核對完成。</think>現在開始交付')).toBe('現在開始交付');
  });
});
