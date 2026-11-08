/** 确定性噪声场：不依赖 Math.random，重建 / 热重载逐字节一致 */

export function hash2(ix: number, iz: number, seed: number): number {
  let n = Math.imul(ix + seed * 101, 374761393) + Math.imul(iz + seed * 31, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

export function hash3(ix: number, iy: number, iz: number, seed: number): number {
  let n = Math.imul(ix + seed * 101, 374761393)
    + Math.imul(iy + seed * 47, 668265263)
    + Math.imul(iz + seed * 17, 2147483647);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function valueNoise2(x: number, z: number, scale: number, seed: number): number {
  const fx = x / scale, fz = z / scale;
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const sx = smooth(fx - ix), sz = smooth(fz - iz);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sz);
}

/** 分形叠加：octaves 越高细节越密，输出仍归一化到 0~1 */
export function fbm2(x: number, z: number, scale: number, octaves: number, seed: number): number {
  let amplitude = 0.5, frequency = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amplitude * valueNoise2(x, z, scale / frequency, seed + o * 131);
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum / norm;
}

/** 3D 值噪声：洞穴侵蚀用；8 个角点 + 三线性插值 */
export function valueNoise3(x: number, y: number, z: number, scale: number, seed: number): number {
  const fx = x / scale, fy = y / scale, fz = z / scale;
  const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
  const sx = smooth(fx - ix), sy = smooth(fy - iy), sz = smooth(fz - iz);
  const c000 = hash3(ix, iy, iz, seed), c100 = hash3(ix + 1, iy, iz, seed);
  const c010 = hash3(ix, iy + 1, iz, seed), c110 = hash3(ix + 1, iy + 1, iz, seed);
  const c001 = hash3(ix, iy, iz + 1, seed), c101 = hash3(ix + 1, iy, iz + 1, seed);
  const c011 = hash3(ix, iy + 1, iz + 1, seed), c111 = hash3(ix + 1, iy + 1, iz + 1, seed);
  const x00 = lerp(c000, c100, sx), x10 = lerp(c010, c110, sx);
  const x01 = lerp(c001, c101, sx), x11 = lerp(c011, c111, sx);
  return lerp(lerp(x00, x10, sy), lerp(x01, x11, sy), sz);
}
