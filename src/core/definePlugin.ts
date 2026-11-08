import type { Plugin } from './types';
import type { PrivilegedCapability } from './Sandbox';
import type { DependencyRef, NamespacedId } from './brands';

/**
 * v0.8 插件契约的编译期强化。
 *
 * 之前 `Plugin` 的 id / provides / dependencies / requiredCapabilities 全是
 * `string`，写错一个字母要等 `catalog.apply()` 甚至运行时才暴露。这里用
 * TS 5.0 的 `const` 类型参数 + `satisfies` + 模板字面量 + 递归条件类型，
 * 把四类错误前移到 `tsc --noEmit`：
 *
 *  - id 必须形如 `owner.name`（模板字面量类型）
 *  - provides / dependencies 只能是插件 id 或 `cap:xxx`
 *  - requiredCapabilities 只能是沙箱认识的特权能力联合
 *  - 清单里出现重复的**字面量** id 直接编译失败
 *
 * 运行时不新增任何字段、不产生任何包装对象，返回的仍是原来的 Plugin。
 */

export interface PluginSpec extends Plugin {
  readonly id: NamespacedId;
  /** 能力名保持开放；依赖必须是 `cap:xxx` 或命名空间化插件 id */
  readonly dependencies?: readonly DependencyRef[];
  readonly optionalDependencies?: readonly DependencyRef[];
  readonly requiredCapabilities?: readonly PrivilegedCapability[];
}

/**
 * 保留字面量 id 与能力元组，供 `PluginIdOf` / `ProvidedCaps` 反查。
 * 用 `Omit` 而不是直接 `Plugin & {...}`：交叉会把 provides 变成
 * `readonly string[] & readonly ['audit']`，infer 拿不到干净的元组。
 */
export type TypedPlugin<T extends PluginSpec> = Omit<Plugin, 'id' | 'provides' | 'dependencies'> & {
  readonly id: T['id'];
  readonly provides: T extends { readonly provides: infer C extends readonly string[] } ? C : undefined;
  readonly dependencies: T extends { readonly dependencies: infer D extends readonly DependencyRef[] } ? D : undefined;
};

/** `const` 类型参数让对象字面量的 id / 数组保留最窄推断 */
export function definePlugin<const T extends PluginSpec>(spec: T): TypedPlugin<T> {
  return spec as unknown as TypedPlugin<T>;
}

/** 从 TypedPlugin 反查编译期 id */
export type PluginIdOf<P> = P extends { readonly id: infer I extends string } ? I : never;
/** 从 TypedPlugin 反查编译期能力元组元素 */
export type ProvidedCaps<P> =
  P extends { readonly provides: infer C extends readonly string[] } ? C[number] : never;
/** 编译期判断某插件是否声明了指定能力 */
export type ProvidesCap<P, C extends string> = C extends ProvidedCaps<P> ? true : false;

// ---------------------------------------------------------------- 清单级去重

type IdsOf<T extends readonly Plugin[]> = {
  -readonly [K in keyof T]: T[K]['id'];
};

/**
 * 递归扫描元组，返回第一个重复的字面量 id。
 * `string extends H` 时说明该元素来自未迁移的旧插件（id 被推断成宽 string），
 * 跳过它 —— 让增量迁移可行，不必一次性改完 23 个插件。
 */
type FirstDuplicate<
  Ids extends readonly string[],
  Seen extends string = never,
> = Ids extends readonly [infer H extends string, ...infer R extends readonly string[]]
  ? string extends H
    ? FirstDuplicate<R, Seen>
    : H extends Seen
      ? H
      : FirstDuplicate<R, Seen | H>
  : never;

/** 有重复字面量 id 时得到 never，作为函数参数交叉项即可触发编译错误 */
export type UniquePluginList<T extends readonly Plugin[]> =
  [FirstDuplicate<IdsOf<T>>] extends [never] ? T : never;

/** 带编译期 id 去重检查的插件清单；`as const satisfies readonly Plugin[]` 效果最佳 */
export function definePluginList<const T extends readonly Plugin[]>(
  list: T & UniquePluginList<T>,
): readonly Plugin[] {
  return list;
}
