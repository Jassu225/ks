// lib/phasemodel.ts — the board's twin of src/lib/phasemodel.ts's
// derivePhaseModel (web can't import src/): the board's COLUMNS, derived from
// every card in the store, whichever device wrote it. (Before devices, the
// daemon derived them from its own cards into meta/project; with several
// devices each daemon would derive different columns.) Keep the templates and
// the rules identical to src's: src/lib/phasemodel.test.ts checks that both
// give the same columns.
//
// phaseModel = the ordered union of {number,name} across every card's
// phases, seeded by the type template so unreached phases still render as
// empty columns. Observed names override template names for the same number.
import type { PhaseRef } from './types';

const TICKET_TEMPLATE: PhaseRef[] = [
  { number: 0, name: 'ticket-initialization' },
  { number: 1, name: 'context-creation' },
  { number: 2, name: 'codebase-research' },
  { number: 9, name: 'implementation-plan-creation' },
  { number: 10, name: 'implementation' },
];

const PROJECT_TEMPLATE: PhaseRef[] = [
  { number: 0, name: 'project-initialization' },
  { number: 1, name: 'context-creation' },
  { number: 2, name: 'codebase-research' },
  { number: 3, name: 'prd-creation' },
  { number: 4, name: 'user-stories' },
  { number: 5, name: 'prototype-creation' },
  { number: 6, name: 'product-requirements' },
  { number: 7, name: 'tad-creation' },
  { number: 8, name: 'linear-tickets-creation' },
  { number: 9, name: 'implementation-plan-creation' },
  { number: 10, name: 'implementation' },
];

/** What derivePhaseModel reads of a card. */
export interface PhaseModelUnit {
  type: 'ticket' | 'project';
  phases?: PhaseRef[] | null;
}

export function derivePhaseModel(units: PhaseModelUnit[]): PhaseRef[] {
  const types = new Set(units.map((u) => u.type));
  const byNumber = new Map<number, string>();

  // Seed from the relevant template(s) first (lowest precedence).
  const seeds: PhaseRef[] = [];
  if (types.has('ticket') || types.size === 0) seeds.push(...TICKET_TEMPLATE);
  if (types.has('project')) seeds.push(...PROJECT_TEMPLATE);
  for (const s of seeds) if (!byNumber.has(s.number)) byNumber.set(s.number, s.name);

  // Observed phases override the seed name for that number.
  for (const u of units) for (const p of u.phases ?? []) byNumber.set(p.number, p.name);

  return [...byNumber.entries()]
    .map(([number, name]) => ({ number, name }))
    .sort((a, b) => a.number - b.number);
}
