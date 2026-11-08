import type { Plugin } from '../core/types';

interface CommunityModule {
  default?: Plugin | (() => Plugin);
  plugin?: Plugin;
}

/**
 * 第三方插件自动发现（Vite 构建期扫描）。
 * 把一个 `.ts` 文件丢进 `plugins/community/`，
 * `export default` 一个 Plugin 对象或返回 Plugin 的工厂函数即可，
 * 不需要改 index.ts、不需要改 main.ts。
 *
 * 仅在浏览器入口 main.ts 中调用；逻辑层自检不依赖它。
 */
export function discoverPlugins(): Plugin[] {
  const modules = import.meta.glob<CommunityModule>('./community/*.ts', { eager: true });
  const out: Plugin[] = [];
  for (const [path, mod] of Object.entries(modules)) {
    try {
      const candidate = mod.plugin ?? mod.default;
      const plugin = typeof candidate === 'function'
        ? (candidate as () => Plugin)()
        : candidate;
      if (plugin && typeof plugin.id === 'string' && typeof plugin.setup === 'function') {
        out.push(plugin);
      } else {
        console.warn(`[discover] ${path} 没有导出合法的 Plugin，已跳过`);
      }
    } catch (err) {
      console.error(`[discover] ${path} 加载失败`, err);
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
