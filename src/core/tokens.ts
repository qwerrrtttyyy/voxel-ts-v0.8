import { ServiceToken } from './ServiceRegistry';
import type { CallbackStat } from './Engine';
import type { IMesher } from '../world/mesher/IMesher';
import type { IGenerator } from '../world/IGenerator';
import type { ICollision } from '../player/ICollision';
import type { SkyHandle } from '../render/Sky';
import type { ChunkView } from '../render/ChunkView';
import type { FirstPersonController } from '../player/FirstPersonController';

/**
 * 内置令牌。全部是「可替换策略」或「可查询句柄」。
 * 第三方插件 provide 一个更高 priority 的实现即可顶替，无需改任何内置插件。
 */
export const MESHER = new ServiceToken<IMesher>('core.mesher', 'chunk 网格化策略');
export const GENERATOR = new ServiceToken<IGenerator>('core.generator', '地形生成器');
export const COLLISION = new ServiceToken<ICollision>('core.collision', '玩家碰撞策略');
export const SKY_HANDLE = new ServiceToken<SkyHandle>('core.skyHandle', '天空球句柄');
export const CHUNK_VIEW = new ServiceToken<ChunkView>('core.chunkView', 'chunk mesh 管理器');
export const FIRST_PERSON = new ServiceToken<FirstPersonController>('core.firstPerson', '第一人称控制器句柄');

/** 地形插件之间传递方块 id，避免硬编码插件内部名字 */
export interface TerrainMaterials {
  grass: number;
  dirt: number;
  [key: string]: number;
}
export const TERRAIN_MATERIALS = new ServiceToken<TerrainMaterials>('core.terrainMaterials', '地表方块 id 表');

// ---- v0.3：全部新能力都通过服务令牌暴露，不改 PluginContext ----
import type { GameState } from './GameState';
import type { PluginCatalog } from './PluginCatalog';
import type { SaveStore } from './SaveStore';
import type { Inventory } from './Inventory';
import type { DayCycle } from './DayCycle';
import type { SelectionHandle } from '../render/Selection';
import type { VoxelHit } from '../player/Raycast';

/**
 * v0.6：准星射线结果只算一次，由交互插件写入、HUD 等消费者只读。
 * 之前 PlayerPlugin / HudPlugin / InteractionPlugin 各跑一次 DDA，且两个 HUD
 * 抢同一个 textContent，纯属重复开销。
 */
export interface ReticleTarget { hit: VoxelHit | null }
export const RETICLE = new ServiceToken<ReticleTarget>('core.reticle', '准星射线结果（单源）');

/** v0.7：真 3D 密度场地形的可观测句柄（stats / inspect / densityAt） */
import type { Terrain3DGenerator } from '../world/terrain/Generator3D';
export const TERRAIN3D = new ServiceToken<Terrain3DGenerator>('voxel.terrain3d', '3D 密度场生成器');

/** v0.6：主循环逐回调耗时画像的只读门面，菜单 / HUD / 第三方插件按需查询 */
export interface ProfilerApi {
  /** 按 totalMs 降序的回调画像快照 */
  top(n?: number): CallbackStat[];
  /** 本进程累计慢回调次数 */
  slowCount(): number;
  /** 清空画像重新采样 */
  reset(): void;
}
export const PROFILER = new ServiceToken<ProfilerApi>('voxel.profiler', '逐插件回调耗时画像');

/** v0.8：深度审批本身也是插件 —— 规则注册表与菜单门面都是可替换服务 */
import type { AuditRegistry, AuditApi } from './audit';
export const AUDIT = new ServiceToken<AuditRegistry>('voxel.auditRegistry', '插件化审批规则注册表');
export const AUDIT_API = new ServiceToken<AuditApi>('voxel.auditApi', '深度审批门面');

export const GAME_STATE = new ServiceToken<GameState>('core.gameState', '游戏状态与设置');
export const PLUGIN_CATALOG = new ServiceToken<PluginCatalog>('core.pluginCatalog', '运行时插件市场');
export const SAVE_STORE = new ServiceToken<SaveStore>('core.saveStore', '二进制存档仓库');
export const INVENTORY = new ServiceToken<Inventory>('core.inventory', '快捷栏 / 物品栏');
export const DAY_CYCLE = new ServiceToken<DayCycle>('core.dayCycle', '昼夜循环控制器');
export const SELECTION = new ServiceToken<SelectionHandle>('core.selection', '准星选中高亮句柄');

/** 扩展方块包声明的 id 表：地形 / 玩法插件只读这张表，不绑死插件 id */
export interface ExtraBlocks { [local: string]: number }
export const EXTRA_BLOCKS = new ServiceToken<ExtraBlocks>('voxel.extraBlocks', '扩展方块 id 表');

/** 主菜单存/读档用的门面，由 voxel.saves 插件提供，可被第三方实现顶替 */
export interface SaveApi {
  save(slot: number, name?: string): Promise<void>;
  load(slot: number): Promise<boolean>;
  remove(slot: number): Promise<void>;
  list(): Promise<Array<{ slot: number; name: string; createdAt: number; bytes: number }>>;
  export(slot: number): Promise<void>;
  import(file: Blob, slot: number): Promise<void>;
}
export const SAVE_API = new ServiceToken<SaveApi>('voxel.saveApi', '世界存档门面');

// ---- v0.4：Cordis 可逆内核暴露的服务 ----
import type { BlockLibrary } from '../world/blocks/types';
import type { Kernel } from '../kernel';

export const BLOCK_LIBRARY = new ServiceToken<BlockLibrary>('cordis.blockLibrary', 'Cordis 方块库');
export const TERRAIN_KERNEL = new ServiceToken<Kernel>('cordis.kernel', 'Cordis 可逆内核');

// ---- v0.5：全量 Cordis 化的统一内核门面 ----
import type { PluginGraph } from './PluginGraph';
export const UNIFIED_KERNEL = new ServiceToken<Kernel>('cordis.unifiedKernel', '统一可逆内核（插件 + 世界组件同实例）');
export const PLUGIN_GRAPH = new ServiceToken<PluginGraph>('cordis.pluginGraph', '统一插件编排层');
