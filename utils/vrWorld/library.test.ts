import { describe, expect, it } from 'vitest';
import { editLibrary, novelReadingMode, readableNovels } from './library';
import { pickNovel, rollRoom } from './runSession';
import { withLatestVRParticipation } from './participation';
import type { CharacterProfile, VRWorldNovel } from '../../types';

const book = (id:string,categoryId?:string):VRWorldNovel => ({id,title:id,categoryId,segments:[{idx:0,text:'正文',chars:2}],totalChars:2,createdAt:1,updatedAt:1});
const char = (state:Record<string,unknown> = {}):CharacterProfile => ({vrState:{enabled:true,intervalMinutes:120,novelReadingMode:'categories',preferredNovelCategoryIds:['web'],...state}} as CharacterProfile);
const categories = [{id:'web',name:'網文'},{id:'lit',name:'嚴肅文學'}];

describe('分類閱讀邊界',()=>{
    it('舊檔自動輪換與逐本偏好保持原模式',()=>{
        expect(novelReadingMode({})).toBe('all');
        expect(novelReadingMode(char({novelReadingMode:undefined,preferredNovelIds:['a']}))).toBe('books');
    });
    it('只讀選中分類，忽略舊逐本偏好且避免連續同一本',()=>{
        const books=[book('a','web'),book('b','web'),book('c','lit'),book('d')];
        const c=char({preferredNovelIds:['c'],lastNovelId:'a'});
        expect(pickNovel(books,c,()=>0.99)?.id).toBe('b');
        expect(readableNovels(books,c).map(n=>n.id)).toEqual(['a','b']);
    });
    it('分類讀完後在本分類重讀，不去別的分類批註',()=>{
        expect(pickNovel([book('a','web'),book('b','lit')],char({novelBookmarks:{a:1}}),()=>0.99)?.id).toBe('a');
    });
    it('空分類和失效分類不回退全書庫，自動活動避開圖書館',()=>{
        const books=[book('b','lit')];
        for(const ids of [[],['gone'],['web']]){
            const c=char({preferredNovelCategoryIds:ids});
            expect(pickNovel(books,c)).toBeNull();
            expect(rollRoom(c,books,null,'library')).toBeNull();
            expect(rollRoom(c,books,null,undefined,()=>0.99)).not.toBe('library');
        }
    });
    it('新書歸入分類後自動進入候選池，多分類使用並集',()=>{
        const c=char({preferredNovelCategoryIds:['web','lit']});
        expect(readableNovels([book('new','web'),book('other','lit'),book('outside')],c).map(n=>n.id)).toEqual(['new','other']);
    });
    it('活動保存保留生成期間剛修改的閱讀範圍',()=>{
        const latest=char({preferredNovelCategoryIds:['lit']});
        const merged=withLatestVRParticipation(latest,{vrState:{...char().vrState!,lastNovelId:'a'}});
        expect(merged.vrState?.preferredNovelCategoryIds).toEqual(['lit']);
        expect(merged.vrState?.lastNovelId).toBe('a');
    });
});

describe('整理書庫',()=>{
    it('分類重命名保持 ID；不會重寫正文與批註',()=>{
        const result=editLibrary(categories,[book('a','web')],{kind:'rename',id:'web',name:' 網絡小說 '});
        expect(result.categories[0]).toEqual({id:'web',name:'網絡小說'});
        expect(result.changed).toEqual([]);
    });
    it('批量移動只更新選中書的分類，並保留書籤使用的 ID',()=>{
        const a=book('a'),b=book('b');
        expect(editLibrary(categories,[a,b],{kind:'assign',novelIds:['a'],categoryId:'web'}).changed).toEqual([{...a,categoryId:'web'}]);
        expect(a.categoryId).toBeUndefined();
    });
    it('移除分類只把書移回未分類，原文與創建時間保留',()=>{
        const a=book('a','web');
        const result=editLibrary(categories,[a,book('b','lit')],{kind:'remove',id:'web'});
        expect(result.changed).toEqual([{...a,categoryId:undefined}]);
        expect(result.categories).toEqual([categories[1]]);
    });
    it('拒絕空名稱、重複名稱、過期分類操作',()=>{
        expect(()=>editLibrary(categories,[],{kind:'create',id:'new',name:' '})).toThrow();
        expect(()=>editLibrary(categories,[],{kind:'create',id:'new',name:' 網文 '})).toThrow();
        expect(()=>editLibrary(categories,[],{kind:'assign',novelIds:['a'],categoryId:'gone'})).toThrow();
        expect(()=>editLibrary(categories,[],{kind:'rename',id:'gone',name:'name'})).toThrow();
    });
});
