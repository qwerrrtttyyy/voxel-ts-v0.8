import { EffectStack } from './Effect';

export type FiberState = 'inactive' | 'active' | 'failed' | 'disposed';

/** 反应式共效应的一次解析：inject key → 实际绑定到的 provider 组件 id（null = 未提供） */
export type Resolution = Readonly<Record<string, string | null>>;

/**
 * 一个组件实例的生命周期状态机（对应 Cordis 的 Fiber）。
 * 每个 Fiber 独享一条效应栈，因此交错执行多个组件后，
 * 撤销其中一个不会触碰到其他组件的效应 —— 恢复精确性的结构基础。
 */
export class Fiber {
  readonly effects = new EffectStack();
  readonly children: Fiber[] = [];
  state: FiberState = 'inactive';
  error: unknown = undefined;
  /** 当前生效解析 */
  resolution: Resolution = {};
  /** 本次激活锁定的解析（inertial：一个 episode 内不中途换目标） */
  committed: Resolution = {};
  generation = 0;

  constructor(
    readonly id: string,
    readonly inject: readonly string[],
    readonly parentId: string | null = null,
  ) {}

  get isActive(): boolean { return this.state === 'active'; }
}
