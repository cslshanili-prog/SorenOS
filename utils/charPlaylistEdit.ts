/**
 * 角色歌單的本地編輯操作（純函數，不碰網絡 / 存儲）。
 *
 * 抽出來單獨放，是為了能脫離 React 組件直接做單元測試——
 * 批量刪歌這種"刪錯一首就糟"的邏輯，靠測試釘住比靠肉眼放心。
 */
import { CharPlaylist } from '../types';

/**
 * 從指定歌單裡批量移除若干首歌，返回新的 playlists 數組。
 *
 * - 只動 id === playlistId 的那個歌單，其它歌單原樣保留（連引用都不變）。
 * - songIds 裡不存在於歌單中的 id 會被安全忽略。
 * - 真有歌被刪掉時，目標歌單的 updatedAt 更新為 now；否則整個數組按原引用返回（no-op）。
 * - 刪光所有歌只會讓 songs 變空數組，歌單本身不會被刪除。
 *
 * @param playlists  當前所有歌單
 * @param playlistId 目標歌單的本地 id
 * @param songIds    要刪除的歌曲 id 集合
 * @param now        刪除發生的時間戳（注入而非內部取，方便測試）
 */
export function removeSongsFromPlaylist(
  playlists: CharPlaylist[],
  playlistId: string,
  songIds: Iterable<number>,
  now: number,
): CharPlaylist[] {
  const idSet = songIds instanceof Set ? songIds : new Set(songIds);
  if (idSet.size === 0) return playlists;

  let changed = false;
  const next = playlists.map(pl => {
    if (pl.id !== playlistId) return pl;
    const keptSongs = pl.songs.filter(s => !idSet.has(s.id));
    if (keptSongs.length === pl.songs.length) return pl; // 沒刪掉任何歌
    changed = true;
    return { ...pl, songs: keptSongs, updatedAt: now };
  });

  return changed ? next : playlists;
}
