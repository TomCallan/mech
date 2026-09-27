/**
 * Units are a presentation concern only. Every length in the document is stored
 * in SI metres so the solver never sees a converted value, and the scene's
 * chosen unit system affects display, input parsing and grid labels.
 */

export type UnitSystem = 'mm' | 'cm' | 'm' | 'in';

export const UNIT_TO_METRES: Record<UnitSystem, number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  in: 0.0254,
};

export const UNIT_LABEL: Record<UnitSystem, string> = {
  mm: 'mm',
  cm: 'cm',
  m: 'm',
  in: 'in',
};

/** Format a metre value for display in the given unit system. */
export function formatLength(metres: number, units: UnitSystem, digits?: number): string {
  const scale = UNIT_TO_METRES[units];
  const value = metres / scale;
  const d = digits ?? defaultDigits(units, value);
  return `${trimZeros(value.toFixed(d))} ${UNIT_LABEL[units]}`;
}

function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

function defaultDigits(units: UnitSystem, value: number): number {
  if (units === 'm') return Math.abs(value) >= 1 ? 3 : 4;
  return Math.abs(value) >= 100 ? 1 : 2;
}


export function defaultScaleFor(units: UnitSystem): { link: number; thickness: number } {
  // Aim for 0.05–0.3 m parts regardless of the display unit.
  const link = units === 'mm' ? 0.08 : units === 'cm' ? 0.08 : units === 'in' ? 0.0762 : 0.08;
  return { link, thickness: link * 0.08 };
}
