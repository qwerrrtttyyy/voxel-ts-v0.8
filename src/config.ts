/**
 * 全局常量。纯数据模块，插件可直接 import。
 * 数值改动不需要动任何类。
 */

/** 单个 chunk 的水平边长（体素数） */
export const CHUNK_SIZE = 16;
/** 单个 chunk 的高度（体素数） */
export const CHUNK_HEIGHT = 48;
/** 首版有限世界：WORLD_CHUNKS × WORLD_CHUNKS 个 chunk（未开启流式时的默认行为） */
export const WORLD_CHUNKS = 6;
/** v0.6 分区系统：一个 region 含 REGION_CHUNKS × REGION_CHUNKS 个 chunk */
export const REGION_CHUNKS = 16;
/** v0.6 无限世界：默认加载窗口半径（chunk 数），(2R+1)² 个 chunk 常驻 */
export const DEFAULT_STREAM_RADIUS = 4;
/** 基准地表高度 */
export const SEA_LEVEL = 12;

/** 相机参数 */
export const FOV = 75;
export const NEAR = 0.05;
export const FAR = 260;
export const FOG_NEAR = 42;
export const FOG_FAR = 148;

/** 玩家参数（单位：方块 / 秒） */
export const EYE_HEIGHT = 1.62;
export const WALK_SPEED = 5.2;
export const SPRINT_MULTIPLIER = 1.7;
export const JUMP_SPEED = 7.4;
export const GRAVITY = 22;
export const MOUSE_SENSITIVITY = 0.0022;
export const REACH = 6;
/** 可自动登上的最大台阶高度（方块） */
export const MAX_STEP_UP = 1.05;
/** 虚空（该列一个方块都没有）时的安全脚底高度 */
export const VOID_GROUND_Y = 0;

/** 固定逻辑步长 */
export const FIXED_STEP = 1 / 60;

/** 插件自动分配的方块 id 起点（0~63 留给核心与显式声明） */
export const AUTO_ID_START = 64;
/** 图集初始格数，不够自动翻倍 */
export const ATLAS_INITIAL_TILES = 16;

// ---- v0.3：玩法 / 昼夜 / 画质 ----
/** 一个完整昼夜的现实秒数（默认 6 分钟） */
export const DAY_LENGTH = 360;
/** 时间 0 = 日出，0.25 = 正午，0.5 = 日落，0.75 = 午夜 */
export const DAWN_PHASE = 0;
/** 玩家 AABB 半宽与身高（Minecraft 近似值） */
export const PLAYER_RADIUS = 0.3;
export const PLAYER_HEIGHT = 1.8;
/** 连续破坏方块的间隔（秒） */
export const BREAK_INTERVAL = 0.22;
/** 快捷栏槽位数 */
export const HOTBAR_SLOTS = 9;
/** 云层高度 */
export const CLOUD_Y = 96;
/** 存档数据库与槽位 */
export const SAVE_DB = 'voxel-ts-saves';
export const SAVE_STORE = 'worlds';
export const SAVE_SLOTS = 3;

/** chunk 的 Map key */
export function chunkKey(cx: number, cz: number): string {
  return `${cx},${cz}`;
}

/** v0.6：把 "cx,cz" 解析回整数对（负坐标同样正确） */
export function chunkKeyPair(key: string): [number, number] {
  const [a, b] = key.split(',');
  return [Number(a), Number(b)];
}

/** 世界坐标 → chunk 坐标（正确 handling 负数） */
export function toChunkCoord(w: number): number {
  return Math.floor(w / CHUNK_SIZE);
}

/** 世界坐标 → chunk 内局部坐标 */
export function toLocalCoord(w: number): number {
  const r = w % CHUNK_SIZE;
  return r < 0 ? r + CHUNK_SIZE : r;
}
