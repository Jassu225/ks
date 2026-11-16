// The board derives its columns itself (web/lib/phasemodel.ts) with a twin of
// src/lib/phasemodel.ts's derivePhaseModel: both must give the same columns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PhaseEntry, WorkUnitDoc } from './db/types.js';
import { derivePhaseModel } from './phasemodel.js';
import { derivePhaseModel as boardDerivePhaseModel } from '../../web/lib/phasemodel.ts';

const unit = (type: 'ticket' | 'project', phases: Array<[number, string]>): WorkUnitDoc =>
  ({
    unitId: `${type}-${phases.length}`,
    type,
    phases: phases.map(([number, name]): PhaseEntry => ({ number, name, status: 'COMPLETED', startedAt: null, endedAt: null })),
  }) as WorkUnitDoc;

const cases: Array<[string, WorkUnitDoc[]]> = [
  ['no cards', []],
  ['tickets only', [unit('ticket', [[0, 'ticket-initialization'], [1, 'Context']]), unit('ticket', [[10, 'Implementation']])]],
  ['projects only', [unit('project', [[3, 'PRD'], [12, 'extra-phase']])]],
  ['mixed, observed names win, later card wins a name', [
    unit('ticket', [[2, 'research A']]),
    unit('project', [[2, 'research B'], [7, 'TAD']]),
  ]],
  ['a card with no phases', [unit('ticket', [])]],
];

for (const [name, units] of cases) {
  test(`derivePhaseModel twins agree: ${name}`, () => {
    assert.deepEqual(boardDerivePhaseModel(units), derivePhaseModel(units));
  });
}

test('derivePhaseModel: seeded by the template, observed names override, sorted', () => {
  const cols = derivePhaseModel([unit('ticket', [[1, 'Context'], [5, 'odd']])]);
  assert.deepEqual(cols.map((c) => c.number), [0, 1, 2, 5, 9, 10]);
  assert.equal(cols.find((c) => c.number === 1)!.name, 'Context');
});
