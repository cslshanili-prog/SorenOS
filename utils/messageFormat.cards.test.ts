import { describe, it, expect } from 'vitest';
import { normalizeMessageContent } from './messageFormat';
import type { Message } from '../types';

const base: Omit<Message, 'type' | 'content' | 'metadata'> = {
  id: 1, charId: 'c1', role: 'user', timestamp: 0,
};
const mk = (type: string, content: string, metadata?: any): Message =>
  ({ ...base, type, content, metadata } as Message);

describe('normalizeMessageContent · xhs_card', () => {
  it('有 MCP 正文時把標題+正文+作者餵給角色', () => {
    const out = normalizeMessageContent(
      mk('xhs_card', '睡不夠', { xhsNote: { title: '睡不夠', desc: '今天畫了花崗岩版', author: '某人' } }),
      'Char', '我',
    );
    expect(out).toContain('《睡不夠》');
    expect(out).toContain('作者：某人');
    expect(out).toContain('今天畫了花崗岩版');
  });

  it('有評論時把評論區也餵給角色（user 分享的筆記也能看到評論）', () => {
    const out = normalizeMessageContent(
      mk('xhs_card', '睡不夠', { xhsNote: {
        title: '睡不夠', desc: '今天畫了花崗岩版', author: '某人',
        comments: [
          { author: '路人甲', content: '太好笑了', likes: 12 },
          { author: '路人乙', content: '同款', likes: 3 },
        ],
      } }),
      'Char', '我',
    );
    expect(out).toContain('評論區');
    expect(out).toContain('路人甲');
    expect(out).toContain('太好笑了');
    expect(out).toContain('路人乙');
  });

  it('只有文案標題(無 MCP/沒抓到正文)時給標題並明示別瞎編', () => {
    const out = normalizeMessageContent(
      mk('xhs_card', '睡不夠', { xhsNote: { title: '睡不夠', desc: '', author: '' } }),
      'Char', '我',
    );
    expect(out).toContain('《睡不夠》');
    expect(out).toContain('別假裝讀過');
    expect(out).not.toContain('筆記正文');
  });

  it('標題也沒有時不崩，給出"沒能獲取到"', () => {
    const out = normalizeMessageContent(mk('xhs_card', '', { xhsNote: {} }), 'Char', '我');
    expect(out).toContain('小紅書筆記');
    expect(out).toContain('沒能獲取到');
  });
});

describe('normalizeMessageContent · webpage_card', () => {
  it('有正文時注入網頁正文', () => {
    const out = normalizeMessageContent(
      mk('webpage_card', '某文章', { webpage: { title: '某文章', siteName: 'blog.com', content: '正文內容若干', finalUrl: 'https://blog.com/a' } }),
      'Char', '我',
    );
    expect(out).toContain('《某文章》');
    expect(out).toContain('網頁正文');
    expect(out).toContain('正文內容若干');
  });

  it('正文抓空時明示沒抓到，別假裝讀過', () => {
    const out = normalizeMessageContent(
      mk('webpage_card', 'MSN', { webpage: { title: 'MSN', siteName: 'msn.com', content: '', excerpt: '' } }),
      'Char', '我',
    );
    expect(out).toContain('《MSN》');
    expect(out).toContain('沒能抓取到');
    expect(out).not.toContain('網頁正文');
  });
});
