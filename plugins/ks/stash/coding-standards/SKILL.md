---
description: Coding standards for KarmaSuite - TypeScript, React, Next.js Pages Router, tRPC, Prisma, Vitest.
---

# Coding Standards & Best Practices

Coding standards for KarmaSuite's TypeScript/React monorepo.

## Code Quality Principles

1. **Readability First** - Self-documenting code, clear names, consistent formatting
2. **KISS** - Simplest solution that works, no over-engineering
3. **DRY** - Extract common logic, share utilities across packages
4. **YAGNI** - Don't build features before they're needed

## TypeScript Standards

### Naming

```typescript
// ✅ GOOD: Descriptive names
const fundSearchQuery = 'restricted'
const isExpenseAllocated = true
const totalAllocationAmount = new Decimal(1000)

// ✅ Verb-noun pattern for functions
async function fetchFundData(fundId: string) { }
function calculateAllocationTotal(allocations: Allocation[]) { }
function isValidRestriction(restriction: Restriction): boolean { }
```

### Immutability (CRITICAL)

```typescript
// ✅ ALWAYS use spread operator
const updatedFund = { ...fund, status: FundStatusKind.ACTIVE }
const updatedExpenses = [...expenses, newExpense]

// ❌ NEVER mutate directly
fund.status = FundStatusKind.ACTIVE  // BAD
expenses.push(newExpense)             // BAD
```

### Async/Await

```typescript
// ✅ GOOD: Parallel execution for independent operations
const [funds, expenses, allocations] = await Promise.all([
  fetchFunds(),
  fetchExpenses(),
  fetchAllocations(),
])

// ❌ BAD: Sequential when unnecessary
const funds = await fetchFunds()
const expenses = await fetchExpenses()
const allocations = await fetchAllocations()
```

### Type Safety

```typescript
// ✅ Use Prisma enum types, not string literals
import { FundStatusKind } from '@karmasuite/prisma'
const activeFunds = funds.filter((f) => f.status === FundStatusKind.ACTIVE)

// ✅ Use .reduce<TYPE>() for type safety
const fundMap = funds.reduce<Record<string, Fund>>((acc, fund) => {
  acc[fund.id] = fund
  return acc
}, {})

// ❌ Never use 'any'
function getFund(id: any): Promise<any> { }
```

### Calculations

```typescript
// ✅ ALWAYS use MathUtils.sum() for consistency
import { MathUtils } from '@karmasuite/utils'
const total = MathUtils.sum(allocations.map((a) => a.amount))
```

## React Best Practices

### Component Structure

```typescript
// ✅ Use FC<PropsWithChildren<...>> for components with children
import { FC, PropsWithChildren } from 'react'

interface PanelProps {
  title: string
  variant?: 'default' | 'outlined'
}

export const Panel: FC<PropsWithChildren<PanelProps>> = ({
  title,
  variant = 'default',
  children,
}) => {
  return (
    <div className={cn('rounded-lg border p-4', variant === 'outlined' && 'border-gray-300')}>
      <h3 className="text-lg font-semibold">{title}</h3>
      {children}
    </div>
  )
}
```

### tRPC Data Fetching

```typescript
// ✅ Use tRPC hooks with proper error handling
const { data: funds, isLoading } = trpc.fund.getAll.useQuery(
  { status: FundStatusKind.ACTIVE },
  {
    onError: (err) => {
      toast.error(err.message)
    },
  }
)

// ✅ Mutations with optimistic updates
const utils = trpc.useUtils()
const mutation = trpc.expense.update.useMutation({
  onSuccess: () => {
    utils.expense.getAll.invalidate()
  },
})
```

### Conditional Rendering

```typescript
// ✅ Clear conditional rendering
{isLoading && <Spinner />}
{error && <ErrorMessage error={error} />}
{data && <DataDisplay data={data} />}

// ❌ Ternary hell
{isLoading ? <Spinner /> : error ? <ErrorMessage /> : data ? <DataDisplay /> : null}
```

## Input Validation

```typescript
import { z } from 'zod'

// ✅ Zod schemas for tRPC input validation
const CreateFundSchema = z.object({
  name: z.string().min(1).max(200),
  donorId: z.string().cuid(),
  restrictions: z.array(z.string()).min(1),
  startDate: z.date(),
})
```

## Monorepo Structure

```
apps/www/                  - Main Next.js app (Pages Router)
  src/pages/              - Page routes
  src/server/             - tRPC routers, server logic
  src/client/             - Client-only code
packages/engines/         - Core business logic (allocation, expenses)
packages/prisma/          - Schema, migrations, ORM
packages/react-components/ - Design system (Tailwind, Radix UI, AG Grid)
packages/react-hooks/     - Shared React hooks
packages/utils/           - Common utilities (MathUtils, etc.)
```

### Import Rules (CRITICAL)

- NEVER import from client folder into server folder or vice versa
- NEVER import from client/server folders into other packages
- Use TypeScript path aliases from tsconfig

## Testing with Vitest

```typescript
// ✅ AAA pattern with descriptive names
test('allocates expense proportionally across funds', () => {
  // Arrange
  const expense = createExpense({ amount: 1000 })
  const funds = [createFund({ weight: 0.6 }), createFund({ weight: 0.4 })]

  // Act
  const allocations = allocateExpense(expense, funds)

  // Assert
  expect(allocations[0].amount).toBe(600)
  expect(allocations[1].amount).toBe(400)
})

// Run: TZ=UTC vitest run path/to/test.test.ts --max-concurrency=1 --no-file-parallelism
```

## Code Smells

- Functions > 50 lines - split into smaller functions
- Deep nesting > 3 levels - use early returns
- Magic numbers - use named constants
- `any` types - use proper TypeScript types
- `console.log` in production - use Sentry for error tracking
