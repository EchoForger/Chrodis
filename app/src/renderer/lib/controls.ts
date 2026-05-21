export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function controlAngle(value: number, min: number, max: number, center?: number): number {
  const start = 135;
  const range = 270;
  if (center !== undefined && value === center) return start + range / 2;
  const norm = clamp((value - min) / (max - min), 0, 1);
  return start + norm * range;
}
