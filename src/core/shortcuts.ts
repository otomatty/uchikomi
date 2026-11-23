export type ReplayShortcut = 'Escape' | 'Shift+Enter' | 'F2';

export const REPLAY_SHORTCUT_OPTIONS = [
  { value: 'Escape', label: 'Esc（標準）' },
  { value: 'Shift+Enter', label: 'Shift + Enter' },
  { value: 'F2', label: 'F2' },
] as const satisfies readonly { value: ReplayShortcut; label: string }[];

export function isReplayShortcut(value: unknown): value is ReplayShortcut {
  return value === 'Escape' || value === 'Shift+Enter' || value === 'F2';
}

export function replayShortcutLabel(shortcut: ReplayShortcut): string {
  return shortcut === 'Escape' ? 'Esc' : shortcut === 'Shift+Enter' ? 'Shift + Enter' : 'F2';
}

export type ReplayShortcutEvent = Pick<KeyboardEvent,
  'key' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey' | 'repeat' | 'isComposing'
> & { keyCode?: number };

/** A pure match only. The game's native Escape must always pass through untouched. */
export function matchesReplayShortcut(event: ReplayShortcutEvent, shortcut: ReplayShortcut): boolean {
  if (event.repeat || event.isComposing || event.keyCode === 229) return false;
  if (event.ctrlKey !== false || event.altKey !== false || event.metaKey !== false) return false;
  if (shortcut === 'Shift+Enter') return event.key === 'Enter' && event.shiftKey === true;
  if (shortcut === 'Escape' || shortcut === 'F2') return event.key === shortcut && event.shiftKey === false;
  return false;
}
