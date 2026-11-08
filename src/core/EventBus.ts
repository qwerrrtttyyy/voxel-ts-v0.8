import type { EventMap } from './EventMap';
import type { PluginEventKey } from './brands';

export type Unsubscribe = () => void;
type Handler = (payload: unknown) => void;

/**
 * 类型化事件总线。
 * - on/emit：走 EventMap，拼错事件名或 payload 类型不对在编译期就报错
 * - onDynamic/emitDynamic：给运行时才知道名字的插件事件兜底
 */
export class EventBus {
  private readonly map = new Map<string, Set<Handler>>();

  on<K extends keyof EventMap>(
    type: K,
    fn: (payload: EventMap[K]) => void,
  ): Unsubscribe {
    return this.add(type, fn as Handler);
  }

  emit<K extends keyof EventMap>(type: K, payload: EventMap[K]): void {
    this.dispatch(type, payload);
  }

  /** v0.8：动态事件也必须形如 `namespace:name`，防止第三方乱写核心前缀 */
  onDynamic(type: PluginEventKey, fn: (payload: unknown) => void): Unsubscribe {
    return this.add(type, fn);
  }

  emitDynamic(type: PluginEventKey, payload: unknown): void {
    this.dispatch(type, payload);
  }

  listenerCount(type?: string): number {
    if (type) return this.map.get(type)?.size ?? 0;
    let n = 0;
    for (const s of this.map.values()) n += s.size;
    return n;
  }

  private add(type: string, fn: Handler): Unsubscribe {
    let set = this.map.get(type);
    if (!set) { set = new Set(); this.map.set(type, set); }
    set.add(fn);
    return () => { set!.delete(fn); if (set!.size === 0) this.map.delete(type); };
  }

  private dispatch(type: string, payload: unknown): void {
    const set = this.map.get(type);
    if (!set) return;
    // 逐个隔离：一个订阅者抛错不能吞掉同事件的其他订阅者。
    for (const fn of [...set]) {
      try { fn(payload); }
      catch (err) { console.error(`[EventBus] listener for "${type}" threw`, err); }
    }
  }

  clear(): void {
    this.map.clear();
  }
}
