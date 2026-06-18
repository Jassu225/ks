// lib/phasemodel.ts — the project's ordered COLUMN SET, derived (never hard-coded).
//
// phaseModel = the ordered union of {number,name} across every work-unit's
// state.yaml phases, seeded by the type template so unreached phases still
// render as empty columns. Observed names override template names for the same
// number. Re-derived on each state.yaml change, so a new phase becomes a new
// column automatically.
import type { PhaseRef, WorkUnitDoc } from './db/types.js';

// Best-effort seed templates. The schema does not fix phase names, so these are
// only used to render columns that no work-unit has reached yet; any observed
// name for a given number wins over the template.
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

export function derivePhaseModel(units: WorkUnitDoc[]): PhaseRef[] {
  const types = new Set(units.map((u) => u.type));
  const byNumber = new Map<number, string>();

  // Seed from the relevant template(s) first (lowest precedence).
  const seeds: PhaseRef[] = [];
  if (types.has('ticket') || types.size === 0) seeds.push(...TICKET_TEMPLATE);
  if (types.has('project')) seeds.push(...PROJECT_TEMPLATE);
  for (const s of seeds) if (!byNumber.has(s.number)) byNumber.set(s.number, s.name);

  // Observed phases override the seed name for that number.
  for (const u of units) for (const p of u.phases) byNumber.set(p.number, p.name);

  return [...byNumber.entries()]
    .map(([number, name]) => ({ number, name }))
    .sort((a, b) => a.number - b.number);
}

export function projectWorkflowType(units: WorkUnitDoc[]): 'ticket' | 'project' | 'mixed' {
  const types = new Set(units.map((u) => u.type));
  if (types.size > 1) return 'mixed';
  return types.has('project') ? 'project' : 'ticket';
}

/**
 * Which column a card sits in: the IN_PROGRESS (or REVISITING) phase, else the
 * furthest progress (highest-numbered phase that is neither SKIPPED nor
 * NOT_STARTED).
 */
export function currentPhase(unit: WorkUnitDoc): PhaseRef | null {
  if (unit.phases.length === 0) return null;
  const active = unit.phases.find(
    (p) => p.status === 'IN_PROGRESS' || p.status === 'REVISITING',
  );
  if (active) return { number: active.number, name: active.name };
  const progressed = unit.phases
    .filter((p) => p.status !== 'SKIPPED' && p.status !== 'NOT_STARTED')
    .sort((a, b) => b.number - a.number);
  if (progressed[0]) return { number: progressed[0].number, name: progressed[0].name };
  const first = unit.phases[0];
  return { number: first.number, name: first.name };
}

// The terminal phase of both the ticket and project workflows (see TEMPLATEs):
// real work is done once `implementation` (10) completes. Earlier phases
// completing (e.g. only `ticket-initialization`) does NOT mean the unit is done.
const TERMINAL_PHASE = 10;

// Linear workflow-states that mean the ticket is closed (case-insensitive). A
// ticket closed in Linear is "done" even if its KS workflow never reached
// phase 10 (e.g. a quick fix merged without the full lifecycle).
const DONE_LINEAR_STATUSES = new Set(['done', 'canceled', 'cancelled', 'merged', 'duplicate']);

/**
 * Whether a work-unit has finished — either its terminal phase (`implementation`,
 * 10) is COMPLETED, or Linear marks it closed (Done/Canceled/Merged/…). In both
 * cases nothing may be IN_PROGRESS/REVISITING. Used to suppress stop-nudges: an
 * idle session whose ticket/project is done is finished work, not a session
 * waiting on the user. A unit that has only completed early phases (just
 * initialized) and is still open in Linear is NOT done and still nudges.
 */
export function unitCompleted(unit: WorkUnitDoc): boolean {
  if (unit.phases.some((p) => p.status === 'IN_PROGRESS' || p.status === 'REVISITING'))
    return false;
  const terminalDone = unit.phases.find((p) => p.number === TERMINAL_PHASE)?.status === 'COMPLETED';
  const linearDone = !!unit.linearStatus && DONE_LINEAR_STATUSES.has(unit.linearStatus.toLowerCase());
  return terminalDone || linearDone;
}
