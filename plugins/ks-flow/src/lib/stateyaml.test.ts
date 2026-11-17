import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { worktreeHolding } from './stateyaml.js';

const MAIN = '/Users/x/karmasuite/karmasuite';
const WT = '/Users/x/karmasuite/karmasuite-worktree/x/kar-13509-enable-default';
const STATE = (root: string) => `${root}/workflow/x/tickets/kar-13509/state.yaml`;

test('worktreeHolding: the worktree a state.yaml lives in; never the main checkout', () => {
  assert.equal(worktreeHolding(STATE(WT), [MAIN, WT], MAIN), WT);
  assert.equal(worktreeHolding(STATE(MAIN), [MAIN, WT], MAIN), null, "the main checkout's copy belongs to no worktree");
  assert.equal(worktreeHolding(STATE(WT), [MAIN], MAIN), null, 'not a known worktree');
  assert.equal(worktreeHolding(STATE(`${WT}-two`), [MAIN, WT], MAIN), null, 'a folder that only starts with the same name');
  assert.equal(worktreeHolding(STATE(WT), [MAIN, `${WT}/`], `${MAIN}/`), WT, 'trailing slashes');
});
