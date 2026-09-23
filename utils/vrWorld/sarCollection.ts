import { FISH_CATALOG, STORY_CATCH_CATALOG, migrateFishingCollection, WEATHER_LABELS, type FishingMarketState } from './fishingMarket';
import { SAR_ALL_MODULES } from './sarGacha';
import { SAR_MODULE_CATALOG } from './sarModuleShop';
import { rememberSARCollections } from './sarCollectionJournal';

export type SARCollectionCategory = 'fish' | 'dinosaur' | 'chip' | 'module';
export type SARCollectionEntry = {
    id: string; category: SARCollectionCategory; title: string; description: string; tag: string;
    collected: boolean; owned: number; source: string; speciesId?: string;
};
export const SAR_COLLECTION_CATEGORIES = [
    { id: 'fish', title: '魚類', description: '水面之下的相遇' },
    { id: 'dinosaur', title: '恐龍', description: '橡皮泥模型與驚喜蛋' },
    { id: 'chip', title: '芯片', description: '變體與故事的可能性' },
    { id: 'module', title: '模塊', description: '收集不同的表達方式' },
] as const;

/** Distinct historical collection and current quantity deliberately remain separate. */
export const sarCollectionEntries = (input: FishingMarketState, actorId: string, npcEnabled = true): SARCollectionEntry[] => {
    const state = rememberSARCollections(migrateFishingCollection(input));
    const journal = state.sarCollection?.actors[actorId];
    const fishRecords = new Set((state.collectionEntries || []).filter(entry => entry.actorId === actorId).map(entry => entry.speciesId));
    const ownedFish = new Map<string, number>();
    for (const item of state.inventory.filter(item => item.ownerId === actorId)) ownedFish.set(item.speciesId, (ownedFish.get(item.speciesId) || 0) + 1);
    const rarityNames = { common: '常見', uncommon: '少見', rare: '稀有', epic: '珍稀', relic: '橡皮泥收藏' };
    const entries: SARCollectionEntry[] = [...FISH_CATALOG, ...STORY_CATCH_CATALOG].filter(s=>s.id!=='dinosaur-egg'||state.sarFamiliarity?.unlocks.includes('eggs')||fishRecords.has(s.id)||ownedFish.has(s.id)).map(species => ({
        id: species.id, category: species.category === 'fish' ? 'fish' : 'dinosaur', title: species.name, description: species.id === 'aiven-chimera' && !fishRecords.has(species.id) && !ownedFish.has(species.id)
            ? '形狀有點奇怪。還不知道它究竟是什麼。' : species.blurb,
        speciesId: species.id, tag: rarityNames[species.rarity], collected: fishRecords.has(species.id) || ownedFish.has(species.id), owned: ownedFish.get(species.id) || 0,
        source: species.id==='aiven-chimera'?(fishRecords.has(species.id)||ownedFish.has(species.id)?'艾文的三星回憶 · 只此一隻。':'和艾文相處下去，也許會收到一份特別的禮物。'):species.id==='dinosaur-egg'?'艾文的三星話題贈送。':`彼方水域 · ${species.weathers.map(kind => WEATHER_LABELS[kind]).join('、')}時更常出現。也可通過實物交易或贈送獲得。`,
    }));
    for (const chip of SAR_ALL_MODULES) {
        const owned = actorId === 'user' ? state.sarCommerce?.gacha.collection[chip.id] || 0 : 0;
        entries.push({ id: chip.id, category: 'chip', title: chip.title, description: chip.summary,
            tag: chip.pool === 'story' ? '故事芯片' : '變體芯片', collected: !!journal?.chips.includes(chip.id) || owned > 0, owned,
            source: actorId === 'user' ? `扭蛋機 · ${chip.pool === 'story' ? '異界座標' : '人格異格'}卡池。` : '角色短篇演繹使用臨時芯片，不計入永久收集。',
        });
    }
    const moduleTags = { voice: '語氣', bond: '關係', genre: '風格', stage: '場景' };
    for (const module of SAR_MODULE_CATALOG) {
        const owned = actorId === 'user' ? state.sarCommerce?.moduleShop.inventory[module.id] || 0 : state.sarCharacterModules?.[actorId]?.[module.id] || 0;
        entries.push({ id: module.id, category: 'module', title: module.title, description: module.description,
            tag: moduleTags[module.category], collected: !!journal?.modules.includes(module.id) || owned > 0, owned,
            source: actorId === 'user' ? '模塊商店 · 留意每日貨架。買下後收錄，裝載用掉也會保留記錄。' : '角色自己購買的模塊會收錄。被別人裝載的效果不等於擁有這枚模塊。',
        });
    }
    return npcEnabled ? entries : entries.filter(entry => !['aiven-chimera', 'dinosaur-egg'].includes(entry.id)).map(entry => ({
        ...entry, description: entry.description.replace('艾文捏的小霸王龍', '橡皮泥小霸王龍').replace('——艾文堅持這麼說。', '。'),
    }));
};
export const sarCollectionProgress = (entries: SARCollectionEntry[]) => SAR_COLLECTION_CATEGORIES.map(category => {
    const items = entries.filter(entry => entry.category === category.id);
    return { ...category, collected: items.filter(entry => entry.collected).length, total: items.length };
});
