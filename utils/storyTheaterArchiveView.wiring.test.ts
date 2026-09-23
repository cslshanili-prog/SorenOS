import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
    fileURLToPath(new URL('../components/date/story/StoryTheaterSession.tsx', import.meta.url)),
    'utf8',
).replace(/\r\n?/g, '\n');

const archivedBlock = source.slice(
    source.indexOf('const archived = mirrorArchived(message, entry);'),
    source.indexOf("if (message.role === 'user') return <section", source.indexOf('const archived = mirrorArchived(message, entry);')),
);

describe('劇情正常記憶歸檔原文入口', () => {
    it('真實時間陪伴歸檔後仍使用可展開原文的 details，而不是不可點擊佔位', () => {
        expect(archivedBlock).toContain("entry.writesToCharacterMemory\n                                ? '已作為正常記憶歸檔'");
        expect(archivedBlock).toContain('展開查看原文');
        expect(archivedBlock).toContain('<details key={message.id}');
        expect(archivedBlock).toContain('open={isExpanded}');
        expect(archivedBlock).toContain('{isExpanded && <div');
        expect(archivedBlock).not.toContain('if (entry.writesToCharacterMemory) return <div');
    });

    it('分頁、批量展開和完整導出接線不會退化', () => {
        expect(source).toContain('const STORY_PAGE_SIZE = 10;');
        expect(source).toContain('messages.slice(messagePage * STORY_PAGE_SIZE');
        expect(source).toContain("allPageArchivesExpanded ? '全部收起' : '全部展開'");
        expect(source).toContain("title='導出全部劇情原文'");
        expect(source).toContain("<StoryPagination className='mt-8'");
    });
});
