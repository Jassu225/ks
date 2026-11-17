import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { worktreeHolding } from './stateyaml.js';

const MAIN = '/Users/x/karmasuite/karmasuite';
const WT = '/Users/x/karmasuite/karmasuite-worktree/x/kar-13509-enable-default';
const OTHER = '/Users/x/karmasuite/karmasuite-worktree/x/kar-13483-auto-gl';
const STATE = (root: string, id = 'kar-13509') => `${root}/workflow/x/tickets/${id}/state.yaml`;

test("worktreeHolding: the unit's own worktree holding its state.yaml", () => {
  assert.equal(worktreeHolding(STATE(WT), 'KAR-13509', [MAIN, WT, OTHER], MAIN), WT);
  assert.equal(worktreeHolding(STATE(`${WT}/`.slice(0, -1)), 'KAR-13509', [MAIN, `${WT}/`], `${MAIN}/`), WT, 'trailing slashes');
});

test("worktreeHolding: another ticket's copy inside a worktree never claims it", () => {
  // Every worktree carries the whole workflow/ folder: KAR-11021's copy inside KAR-13483's worktree.
  assert.equal(worktreeHolding(STATE(OTHER, 'kar-11021'), 'KAR-11021', [MAIN, WT, OTHER], MAIN), null);
  assert.equal(worktreeHolding(STATE(OTHER, 'kar-13509'), 'KAR-13509', [MAIN, WT, OTHER], MAIN), null);
});

test('worktreeHolding: never the main checkout, an unknown worktree, or a look-alike name', () => {
  assert.equal(worktreeHolding(STATE(MAIN), 'KAR-13509', [MAIN, WT], MAIN), null);
  assert.equal(worktreeHolding(STATE(WT), 'KAR-13509', [MAIN], MAIN), null);
  const lookAlike = '/Users/x/karmasuite/karmasuite-worktree/x/kar-135090-x';
  assert.equal(worktreeHolding(STATE(lookAlike), 'KAR-13509', [MAIN, lookAlike], MAIN), null);
});
