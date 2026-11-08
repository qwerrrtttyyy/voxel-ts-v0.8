/**
 * Revertible Effects —— Cordis 论文《A Programming Paradigm for Spatiotemporal
 * Composability》(arXiv:2608.25512) 的最小运行时实现。
 *
 * 形式化：设环境状态为 S，一次效应 e = (f, f⁻¹)，其中 f : S → S，
 * f⁻¹ ∘ f = id_S。栈内效应 e₁…eₙ 按执行顺序累积，其复合逆为
 *   (e₁ ⋯ eₙ)⁻¹ = eₙ⁻¹ ∘ ⋯ ∘ e₁⁻¹   （LIFO）
 * 因此 undo() 后环境精确回到效应执行前 —— 这是「恢复精确性」的局部形式，
 * 也是 Theorem 16 的栈级对应物。
 *
 * 注意（与论文一致）：框架不验证插件作者提供的逆是否真的可逆，
 * 数学结论以「逆见证正确」为前提。本实现保证的是组合与调度顺序的正确性。
 */

export type Inverse = () => void;

export interface EffectBody<T> {
  readonly value: T;
  readonly inverse: Inverse;
}

export interface EffectRecord {
  readonly label: string;
  readonly inverse: Inverse;
}

export class EffectStack {
  private readonly records: EffectRecord[] = [];
  private undone = false;

  get size(): number { return this.records.length; }
  get labels(): readonly string[] { return this.records.map((r) => r.label); }
  get isUndone(): boolean { return this.undone; }

  /** 执行带显式逆的动作并压栈。body 抛错时不压栈（由 Fiber 统一回滚既有栈）。 */
  run<T>(label: string, body: () => EffectBody<T>): T {
    if (this.undone) throw new Error(`[Effect] stack already undone (${label})`);
    const { value, inverse } = body();
    this.records.push({ label, inverse });
    return value;
  }

  /** Cordis `ctx.effect()` 形态：fn 执行副作用，返回值是它的逆（void 表示无撤销需求）。 */
  effect(label: string, fn: () => void | Inverse): void {
    this.run<void>(label, () => {
      const inverse = fn();
      return { value: undefined, inverse: typeof inverse === 'function' ? inverse : () => {} };
    });
  }

  /** LIFO 逆序执行所有逆；单个逆抛错不阻断其余（失败隔离），并把标签带 `!` 返回。 */
  undo(): string[] {
    const done: string[] = [];
    if (this.undone) return done;
    this.undone = true;
    for (const record of [...this.records].reverse()) {
      try {
        record.inverse();
        done.push(record.label);
      } catch (err) {
        done.push(`${record.label}!`);
        console.warn(`[Effect] inverse of "${record.label}" threw`, err);
      }
    }
    this.records.length = 0;
    return done;
  }

  /** 复用同一个栈（组件被重新激活时）；必须在 undo 之后调用。 */
  reset(): void {
    this.records.length = 0;
    this.undone = false;
  }
}
