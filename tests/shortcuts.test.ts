import test from 'node:test';
import assert from 'node:assert/strict';
import { isReplayShortcut, matchesReplayShortcut, replayShortcutLabel, REPLAY_SHORTCUT_OPTIONS, type ReplayShortcut, type ReplayShortcutEvent } from '../src/core/shortcuts';

const keyEvent = (key: string, patch: Partial<ReplayShortcutEvent> = {}): ReplayShortcutEvent => ({
  key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, repeat: false, isComposing: false, ...patch,
});

test('replay choices have stable persisted values and readable key labels', () => {
  assert.deepEqual(REPLAY_SHORTCUT_OPTIONS, [
    { value: 'Escape', label: 'Esc（標準）' },
    { value: 'Shift+Enter', label: 'Shift + Enter' },
    { value: 'F2', label: 'F2' },
  ]);
  assert.deepEqual(REPLAY_SHORTCUT_OPTIONS.map(option => replayShortcutLabel(option.value)), ['Esc', 'Shift + Enter', 'F2']);
  for (const option of REPLAY_SHORTCUT_OPTIONS) assert.equal(isReplayShortcut(option.value), true);
  for (const value of [undefined, null, '', 'Esc', 'escape', 'Shift + Enter', 'Ctrl+Enter', 'F3', 1, {}, []]) {
    assert.equal(isReplayShortcut(value), false);
  }
});

test('only the exact key and modifier combination can match a replay shortcut', () => {
  const cases: [ReplayShortcut, string, number][] = [['Escape', 'Escape', 0], ['Shift+Enter', 'Enter', 8], ['F2', 'F2', 0]];
  for (const [shortcut, key, allowed] of cases) {
    for (let mask = 0; mask < 16; mask++) {
      const event = keyEvent(key, { ctrlKey: Boolean(mask & 1), altKey: Boolean(mask & 2), metaKey: Boolean(mask & 4), shiftKey: Boolean(mask & 8) });
      assert.equal(matchesReplayShortcut(event, shortcut), mask === allowed, `${shortcut}, modifier mask ${mask}`);
    }
    for (const wrong of ['a', ' ', 'Tab', 'F1', 'F3', 'Process']) {
      assert.equal(matchesReplayShortcut(keyEvent(wrong, { shiftKey: allowed === 8 }), shortcut), false);
    }
  }
  assert.equal(matchesReplayShortcut(keyEvent('Enter'), 'Shift+Enter'), false);
  assert.equal(matchesReplayShortcut(keyEvent('Escape'), 'F2'), false);
  assert.equal(matchesReplayShortcut(keyEvent('F2'), 'Escape'), false);
});

test('repeat and IME composition cannot trigger replay, and matching does not alter the native event', () => {
  for (const [shortcut, key, shiftKey] of [['Escape', 'Escape', false], ['Shift+Enter', 'Enter', true], ['F2', 'F2', false]] as const) {
    for (const patch of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }]) {
      assert.equal(matchesReplayShortcut(keyEvent(key, { shiftKey, ...patch }), shortcut), false);
    }
    const event = Object.freeze({ ...keyEvent(key, { shiftKey }), preventDefault() { assert.fail('Native event must be untouched'); }, stopPropagation() { assert.fail('Native event must be untouched'); } });
    assert.equal(matchesReplayShortcut(event, shortcut), true);
  }
});
