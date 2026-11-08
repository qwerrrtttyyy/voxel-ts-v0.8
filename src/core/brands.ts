/**
 * v0.8 TS 特性基座：名义类型（nominal / branded types）。
 *
 * TypeScript 默认是结构化类型：`string` 和 `PluginId` 长得一样就能互赋，
 * 于是「插件 id 写错前缀」「tag 用了没申领的裸数字」「事件名没带命名空间」
 * 这类错误只能等运行时炸。这里用一个不导出的 `unique symbol` 给每条
 * 业务概念打上品牌，让它们在编译期互不相容，同时因为交叉的是基础类型，
 * 仍然可以无缝传给既有 `string` / `number` 参数。
 */

declare const brand: unique symbol;

/** 通用品牌：T 保持原类型能力，B 只用于编译期区分 */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** 命名空间化标识符：`owner.name`，至少一个点 */
export type NamespacedId = `${string}.${string}`;

/** 插件 id 必须是命名空间化的，且带品牌（防止把普通字符串误当插件 id 用） */
export type PluginId = Brand<NamespacedId, 'PluginId'>;

/** 依赖引用：命名空间化插件 id，或 `cap:能力名` */
export type DependencyRef = NamespacedId | `cap:${string}`;
/** 能力名本身允许任意标识符（clouds / generator ...），由 provides 声明 */
export type CapabilityName = string;

/** 服务令牌 id：`core.mesher` / `voxel.profiler` 这类 */
export type ServiceId = NamespacedId;

/** 二进制段 tag：只有 BinaryHub.claimTag() 的返回值才是合法 tag */
export type SegmentTag = Brand<number, 'SegmentTag'>;

/** 审计规则 id：命名空间化 + 品牌 */
export type AuditRuleId = Brand<NamespacedId, 'AuditRuleId'>;

/** 动态事件名必须是 `namespace:name`，防止第三方乱写核心前缀 */
export type PluginEventKey = `${string}:${string}`;

/** 体素方块 id（u8），为后续 16bit 升级预留的类型入口 */
export type BlockId = Brand<number, 'BlockId'>;

/** chunk / region 的 `x,z` 键，避免与随机字符串混用 */
export type ChunkKey = Brand<string, 'ChunkKey'>;
export type RegionKey = Brand<string, 'RegionKey'>;

/** 把一个字面量提升为品牌值；运行时零开销（就是原值） */
export function brandId<B extends string, T>(value: T): Brand<T, B> {
  return value as Brand<T, B>;
}

export function asPluginId<S extends NamespacedId>(id: S): Brand<S, 'PluginId'> {
  return id as Brand<S, 'PluginId'>;
}

export function asAuditRuleId<S extends NamespacedId>(id: S): Brand<S, 'AuditRuleId'> {
  return id as Brand<S, 'AuditRuleId'>;
}

export function asSegmentTag(n: number): SegmentTag {
  return n as SegmentTag;
}
