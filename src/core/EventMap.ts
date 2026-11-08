/**
 * 类型化事件表。第三方插件可用 declaration merging 扩展：
 *
 *   declare module '../core/EventMap' {
 *     interface EventMap { 'mypack:explode': { x: number; y: number; z: number } }
 *   }
 *
 * 之后 events.on('mypack:explode', e => ...) 自动推导出 payload 类型。
 */
export interface ChunkDirtyEvent {
  key: string;
  cx: number;
  cz: number;
  reason: 'generated' | 'edited' | 'neighbor' | 'remesh';
}

export interface BlockChangedEvent {
  x: number;
  y: number;
  z: number;
  oldId: number;
  newId: number;
}

export interface PluginLifecycleEvent {
  id: string;
  version: string;
  phase: 'loaded' | 'unloaded' | 'reloaded' | 'enabled' | 'disabled';
}

export interface ServiceChangedEvent {
  tokenId: string;
  owner: string | undefined;
  action: 'provided' | 'removed';
}

export interface WorldRegeneratedEvent {
  generatorId: string;
  chunkCount: number;
}

export interface WorldLoadedEvent {
  chunkCount: number;
  segmentCount: number;
  unknownSegments: number;
}

/** v0.6：滑动窗口加载 / 卸载一个 chunk */
export interface ChunkStreamEvent {
  key: string;
  cx: number;
  cz: number;
  action: 'loaded' | 'unloaded';
  /** loaded 时是否为归档恢复（而非重新生成） */
  restored: boolean;
}

/** v0.6：分区激活 / 导出 / 合并 */
export interface RegionChangedEvent {
  key: string;
  rx: number;
  rz: number;
  action: 'activated' | 'saved' | 'loaded';
  chunkCount: number;
  editedCount: number;
}

/** v0.3 玩法事件 */
export interface BlockActionEvent {
  x: number; y: number; z: number;
  blockId: number;
  by: 'player' | 'plugin' | 'save';
  tool?: string;
}
export interface InventoryChangedEvent {
  selected: number;
  blockId: number;
  label: string;
  page: number;
  total: number;
}
export interface TimeChangedEvent {
  /** 0..1，0=日出 */
  phase: number;
  /** 人类可读时刻 */
  clock: string;
  daylight: number;
}
export interface GameToastEvent {
  text: string;
  kind: 'info' | 'good' | 'warn' | 'achievement';
}
export interface GameModeEvent {
  mode: 'creative' | 'survival';
  flying: boolean;
}
export interface StatsChangedEvent {
  placed: number;
  broken: number;
  distance: number;
}
export interface SaveChangedEvent {
  slot: number;
  action: 'saved' | 'loaded' | 'deleted';
  bytes: number;
}

export interface EventMap {
  'chunk:dirty': ChunkDirtyEvent;
  'block:changed': BlockChangedEvent;
  'plugin:loaded': PluginLifecycleEvent;
  'plugin:unloaded': PluginLifecycleEvent;
  'service:changed': ServiceChangedEvent;
  'world:regenerated': WorldRegeneratedEvent;
  'world:loaded': WorldLoadedEvent;
  'chunk:streamed': ChunkStreamEvent;
  'region:changed': RegionChangedEvent;
  'block:broken': BlockActionEvent;
  'block:placed': BlockActionEvent;
  'inventory:changed': InventoryChangedEvent;
  'time:changed': TimeChangedEvent;
  'game:toast': GameToastEvent;
  'game:mode': GameModeEvent;
  'stats:changed': StatsChangedEvent;
  'save:changed': SaveChangedEvent;
  'game:paused': { paused: boolean; reason: 'menu' | 'escape' | 'resume' };
}
