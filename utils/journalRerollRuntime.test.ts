import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Journal character-page rewrite feedback', () => {
  it('silently saves the draft and reports the real rewrite operation globally', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/JournalApp.tsx'), 'utf8');
    const exchangeStart = source.indexOf('const handleExchange = async () =>');
    const archiveStart = source.indexOf('const handleArchiveDiary = async', exchangeStart);
    const exchangeSource = source.slice(exchangeStart, archiveStart);

    expect(source).toContain("const saveEntry = async (options: { silent?: boolean } = {})");
    expect(source).toContain("if (!options.silent) addToast('日記已保存', 'success')");
    expect(exchangeSource).toContain('await saveEntry({ silent: true })');
    expect(exchangeSource).not.toContain('saveEntry();');
    expect(exchangeSource).toContain('正在請 ${selectedChar.name} 重新寫這篇日記');
    expect(exchangeSource).toContain('角色日記已重新寫好 · 已同步到聊天');
    expect(exchangeSource).toContain("'重新寫日記' : '交換日記'");
    expect(source).toContain('data-testid="journal-rewrite-character-page"');
    expect(source).toContain('aria-label="重新寫角色日記"');
  });
});
