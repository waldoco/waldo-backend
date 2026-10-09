export type GeneralBrowserAction =
  | Readonly<{ operation: 'click'; element_ref: string }>
  | Readonly<{ operation: 'set_checked'; element_ref: string; checked: boolean }>
  | Readonly<{ operation: 'fill' | 'select'; element_ref: string; value: string }>
  | Readonly<{ operation: 'press'; element_ref: string; key: GeneralBrowserKey }>
  | Readonly<{ operation: 'scroll'; direction: 'up' | 'down' | 'left' | 'right' }>
  | Readonly<{ operation: 'scroll'; delta: number }>;
const keys = ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space'] as const;
type GeneralBrowserKey = typeof keys[number];

// Runtime validation is required even when the caller supplies a typed contract.
// Unknown operations and extra arguments must never fall through to a click.
export function parseGeneralBrowserAction(input: unknown): GeneralBrowserAction | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const row = input as Record<string, unknown>;
  const exact = (...names: string[]) => Object.keys(row).length === names.length && names.every(name => Object.hasOwn(row, name));
  const reference = typeof row.element_ref === 'string' && row.element_ref.length > 0;
  switch (row.operation) {
    case 'click':
      if (reference && exact('operation', 'element_ref')) return row as GeneralBrowserAction;
      break;
    case 'set_checked':
      if(reference && typeof row.checked==='boolean' && exact('operation','element_ref','checked')) return row as GeneralBrowserAction;
      break;
    case 'fill': case 'select':
      if (reference && typeof row.value === 'string' && exact('operation', 'element_ref', 'value')) return row as GeneralBrowserAction;
      break;
    case 'press':
      if (reference && keys.some(key => key === row.key) && exact('operation', 'element_ref', 'key')) return row as GeneralBrowserAction;
      break;
    case 'scroll':
      if (Number.isSafeInteger(row.delta) && (row.delta as number) >= -2000 && (row.delta as number) <= 2000 && exact('operation', 'delta')) return row as GeneralBrowserAction;
      if (['up', 'down', 'left', 'right'].some(direction => direction === row.direction) && exact('operation', 'direction')) return row as GeneralBrowserAction;
  }
}
