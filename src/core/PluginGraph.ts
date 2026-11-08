import { Kernel, type Component, type KernelSnapshot, type SettleReport } from '../kernel';
import { EffectStack } from '../kernel/Effect';
import type { Plugin } from './types';

/**
 * 插件依赖 → Cordis 能力的 key 编码。
 * 独立前缀避免与世界组件（infra.atlas / pack:xxx / stage.xxx）撞名。
 */
export const CAP = (name: string): string => `plugin.cap:${name}`;
export const PLUGIN_ID = (id: string): string => `plugin.id:${id}`;

/** 把 `cap:xxx` / 普通插件 id 依赖统一映射成 inject key */
export function depKey(dep: string): string {
  return dep.startsWith('cap:') ? CAP(dep.slice(4)) : PLUGIN_ID(dep);
}

export interface PluginNode {
  readonly id: string;
  readonly inject: readonly string[];
  readonly claims: readonly string[];
  readonly optional: readonly string[];
}

/**
 * 把 Plugin 编译成 Cordis 声明。
 *
 * `apply` **不执行插件 setup**（setup 是异步、且要真实 PluginContext），只做两件事：
 *   1. claim 自身存在性 / 提供的能力（可逆，停用自动移除）
 *   2. 登记一个 effect，其逆 = 回滚该插件的 EffectStack
 *
 * 于是插件的全部资源（events / services / blocks / tiles / binary / dom）虽由
 * PluginScope 异步登记，却都落在这条 Cordis EffectStack 里，且生命周期由 Kernel
 * 的停用顺序驱动 —— 这就是「全量 Cordis 化」。
 */
export function compile(plugin: Plugin): PluginNode {
  const hard = (plugin.dependencies ?? []).map(depKey);
  const optional = (plugin.optionalDependencies ?? []).map(depKey);
  const claims = [
    PLUGIN_ID(plugin.id),
    ...(plugin.provides ?? []).map(CAP),
  ];
  return {
    id: plugin.id,
    inject: hard,          // 硬依赖进 inject（缺失则不激活）
    claims,
    optional,              // 可选依赖仅记录，缺失静默降级
  };
}

export interface GraphStatus {
  readonly total: number;
  readonly active: number;
  readonly failed: string[];
  readonly quiescent: boolean;
}

/**
 * 统一编排层：一个 Kernel 同时容纳插件组件与世界组件。
 *
 * 控制反转的分工：
 *  - Kernel：依赖图真值源 —— 谁能激活、按什么顺序停（inject/provide 反应式共效应，
 *    四条定理：恢复精确性 / 有序性 / 进展性 / 汇聚性）
 *  - PluginHost：确定性执行器 —— 何时异步 setup、发什么事件、按拓扑+priority 启动
 *  - 每个插件一条独立 EffectStack（Cordis 可逆栈），通过 effect 桥接到 Fiber
 *
 * 因此 44/44 断言的确定性时序不被 Kernel.settle 顺序干扰，但每个插件的
 * 依赖图、能力声明、可逆回滚都真实地落在统一内核里。
 */
export class PluginGraph {
  readonly kernel: Kernel;
  private readonly nodes = new Map<string, PluginNode>();
  private readonly stacks = new Map<string, EffectStack>();
  private quiescent = true;

  constructor(kernel?: Kernel) {
    this.kernel = kernel ?? new Kernel();
  }

  get size(): number { return this.nodes.size; }
  ids(): string[] { return [...this.nodes.keys()]; }
  node(id: string): PluginNode | undefined { return this.nodes.get(id); }

  /** 该插件专属的可逆效应栈（供 PluginScope 复用） */
  stackFor(id: string): EffectStack {
    let stack = this.stacks.get(id);
    if (!stack) { stack = new EffectStack(); this.stacks.set(id, stack); }
    return stack;
  }

  /** 声明插件（不激活）：编译依赖/能力，登记为休眠组件进共享 Kernel */
  declare(plugin: Plugin): PluginNode {
    const node = compile(plugin);
    this.nodes.set(plugin.id, node);
    if (this.kernel.fiberOf(plugin.id)) return node;  // 重复声明沿用已登记 Fiber
    const stack = this.stackFor(plugin.id);
    const component: Component = {
      id: plugin.id,
      inject: node.inject,
      provide: node.claims,
      group: 'plugin',
      apply: (kctx) => {
        // 内核 settle 内部若发生「停用 → 重激活」，桥接逆会先 stack.undo()；
        // 此处重建，保证每次激活都从干净栈开始，后续 scope.track / setup 登记
        // 不会撞上 "stack already undone"。仅在已被 undo 过时重建（幂等），
        // 避免误清 setup 已登记、尚未回滚的资源逆。
        if (stack.isUndone) stack.reset();
        // 声明可变：reload 时以 nodes 里的最新声明为准
        for (const key of (this.nodes.get(plugin.id) ?? node).claims) kctx.claim(key);
        // 桥接：Kernel 停用本组件 → 精确回滚该插件的资源栈（LIFO）
        kctx.effect(`scope:${plugin.id}`, () => () => stack.undo());
      },
    };
    this.kernel.declare(component);
    return node;
  }

  /**
   * 激活插件：重置其资源栈 → 加入活动表 → settle。
   * silent：插件不是世界组件，开关不触发 onChange → 世界重建。
   */
  activate(id: string): SettleReport {
    if (!this.nodes.has(id)) return { iterations: 0, activated: [], deactivated: [], failed: [], quiescent: true };
    this.stackFor(id).reset();
    this.kernel.enable(id, true);
    const report = this.kernel.settle();
    this.quiescent = report.quiescent;
    return report;
  }

  /** 停用一组插件：Kernel 反应式级联、按依赖深度降序 LIFO 回滚各自资源栈 */
  deactivate(ids: readonly string[]): SettleReport {
    for (const id of ids) this.kernel.unregister(id);
    const report = this.kernel.settle();
    this.quiescent = report.quiescent;
    return report;
  }

  /** 反应式级联：停用 root 会牵连的所有插件，按依赖深度降序（consumer 先） */
  cascade(id: string): string[] {
    return this.kernel.dependents([id]).filter((x) => this.nodes.has(x));
  }

  /** 硬依赖是否全部满足 */
  satisfied(id: string): boolean {
    const node = this.nodes.get(id);
    return !!node && node.inject.every((k) => this.kernel.has(k));
  }

  activeIds(): string[] {
    return this.kernel.fiberIds.filter(
      (id) => this.nodes.has(id) && this.kernel.fiberOf(id)?.isActive,
    );
  }

  status(): GraphStatus {
    const failed = this.kernel.fiberIds.filter(
      (id) => this.nodes.has(id) && this.kernel.fiberOf(id)?.state === 'failed',
    );
    return { total: this.nodes.size, active: this.activeIds().length, failed, quiescent: this.quiescent };
  }

  snapshot(): KernelSnapshot { return this.kernel.snapshot(); }
  settle(): SettleReport {
    const report = this.kernel.settle();
    this.quiescent = report.quiescent;
    return report;
  }
}
