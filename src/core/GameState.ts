import type { ConfigNamespace } from './ConfigStore';

export type GameMode = 'creative' | 'survival';

/** 所有设置都持久化在 localStorage（Node 环境自动降级内存） */
export interface Settings {
  mode: GameMode;
  dayCycle: boolean;
  timeScale: number;
  viewDistance: number;
  sensitivity: number;
  fov: number;
  clouds: boolean;
  particles: boolean;
  ao: boolean;
  showHud: boolean;
  autoSave: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'creative',
  dayCycle: true,
  timeScale: 1,
  viewDistance: 1,
  sensitivity: 1,
  fov: 75,
  clouds: true,
  particles: true,
  ao: true,
  showHud: true,
  autoSave: true,
};

export interface GameStats {
  placed: number;
  broken: number;
  distance: number;
  /** 已经达成的成就 id，避免重复弹提示 */
  achievements: string[];
}

type Listener = () => void;

/**
 * 全局游戏状态。刻意不放进 PluginContext：它是「外壳状态」而非插件能力，
 * 通过 GAME_STATE 服务令牌暴露，插件按需取用，核心接口保持封闭。
 */
export class GameState {
  paused = true;
  pausedReason: 'menu' | 'escape' | 'resume' = 'menu';
  flying = false;
  started = false;
  readonly stats: GameStats = { placed: 0, broken: 0, distance: 0, achievements: [] };
  settings: Settings;

  private readonly listeners = new Set<Listener>();

  constructor(private readonly cfg: ConfigNamespace) {
    const saved = cfg.get<Partial<Settings>>('settings', {});
    this.settings = { ...DEFAULT_SETTINGS, ...saved };
  }

  get mode(): GameMode { return this.settings.mode; }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    for (const fn of [...this.listeners]) {
      try { fn(); } catch { /* 订阅者不能拖垮状态机 */ }
    }
  }

  setPaused(paused: boolean, reason: 'menu' | 'escape' | 'resume' = 'menu'): void {
    if (this.paused === paused && this.pausedReason === reason) return;
    this.paused = paused;
    this.pausedReason = reason;
    this.emit();
  }

  setMode(mode: GameMode): void {
    this.settings.mode = mode;
    if (mode === 'survival') this.flying = false;
    this.persist();
    this.emit();
  }

  setFlying(flying: boolean): void {
    if (this.mode === 'survival' && flying) return;
    this.flying = flying;
    this.emit();
  }

  setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.settings[key] = value;
    this.persist();
    this.emit();
  }

  resetSettings(): void {
    this.settings = { ...DEFAULT_SETTINGS };
    this.persist();
    this.emit();
  }

  addStat(key: 'placed' | 'broken', n = 1): void {
    this.stats[key] += n;
    this.emit();
  }

  addDistance(n: number): void {
    if (n > 0 && Number.isFinite(n)) this.stats.distance += n;
  }

  private persist(): void {
    this.cfg.set('settings', this.settings);
  }
}
