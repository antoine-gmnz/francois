import { describe, expect, it } from 'vitest';
import { parseProjectPins, toggleProjectPin } from './projectPinsStore';

describe('project pins', () => {
  it('parses tolerantly', () => {
    expect(parseProjectPins(null)).toEqual([]);
    expect(parseProjectPins('nope')).toEqual([]);
    expect(parseProjectPins('{"a":1}')).toEqual([]);
    expect(parseProjectPins('["a","a"," ",3,"b"]')).toEqual(['a', 'b']);
  });
  it('toggles, appending in pin order', () => {
    expect(toggleProjectPin(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleProjectPin(['a', 'b'], 'a')).toEqual(['b']);
  });
});
