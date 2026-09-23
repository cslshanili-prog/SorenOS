import { describe, expect, it } from 'vitest';
import { parseCollaborationRichOutput, resolveCollaborationEmoji, sanitizeCollaborationRichOutputSource } from '../features/collaboration/richOutput';

describe('collaboration rich output', () => {
  it('keeps renderable emoji and voice forms while separating visible text', () => {
    const parsed = parseCollaborationRichOutput('正文\n[[SEND_EMOJI: 貓貓開心]]\n<語音 emotion="happy">真的做好啦</語音><字幕>真的做好啦</字幕>');
    expect(parsed.text).toBe('正文');
    expect(parsed.emojiNames).toEqual(['貓貓開心']);
    expect(parsed.voice?.speech).toBe('真的做好啦');
    expect(parsed.voice?.subtitle).toBe('真的做好啦');
  });

  it('normalizes single-bracket emoji syntax and strips unsupported ChatApp actions', () => {
    const source = sanitizeCollaborationRichOutputSource('[SEND_EMOJI: 揮手]\n[[ACTION:POKE]]\n[[RECALL: 2026-08]]\n繼續做文件');
    expect(source).toContain('[[SEND_EMOJI: 揮手]]');
    expect(source).toContain('繼續做文件');
    expect(source).not.toContain('ACTION:POKE');
    expect(source).not.toContain('RECALL:');
  });

  it('resolves category-qualified emoji names without guessing ambiguous matches', () => {
    const emojis = [
      { name: '揮手', url: 'one', categoryId: 'cat' },
      { name: '揮手', url: 'two', categoryId: 'other' },
    ];
    const categories = [{ id: 'cat', name: '貓貓' }, { id: 'other', name: '狗狗' }];
    expect(resolveCollaborationEmoji('貓貓: 揮手', emojis, categories)?.url).toBe('one');
    expect(resolveCollaborationEmoji('揮手', emojis, categories)?.url).toBe('one');
  });
});
