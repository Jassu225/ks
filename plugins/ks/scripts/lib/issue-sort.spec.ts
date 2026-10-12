// Run: node --import tsx --test lib/issue-sort.spec.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { issueSort } from './issue-sort.js'

// The regression: `--sort manual --limit N` fetched N issues in API order and
// sorted only those, so issues ranked above them went missing. The order must
// reach Linear with the query, where it applies before the limit.
test('each --sort is asked of Linear, so it orders before the limit cuts', () => {
  assert.deepEqual(issueSort('manual'), [{ manual: { order: 'Ascending' } }])
  assert.deepEqual(issueSort('created'), [{ createdAt: { order: 'Descending' } }])
  assert.deepEqual(issueSort('updated'), [{ updatedAt: { order: 'Descending' } }])
  assert.equal(issueSort(undefined), undefined)
})
