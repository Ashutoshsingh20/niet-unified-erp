import { safeReturnTo } from '../lib/return-to';

describe('safeReturnTo', () => {
  it('allows same-origin relative paths', () => {
    expect(safeReturnTo('/workflows?view=open')).toBe('/workflows?view=open');
  });

  it.each(['//attacker.example/path', 'https://attacker.example', null])(
    'rejects unsafe return target %s', (target) => {
      expect(safeReturnTo(target)).toBe('/');
    },
  );
});
