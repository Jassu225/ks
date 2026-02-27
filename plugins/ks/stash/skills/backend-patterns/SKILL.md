---
description: Backend architecture patterns for KarmaSuite - Next.js Pages Router, tRPC, Prisma ORM, Clerk auth, Inngest background jobs.
---

# Backend Development Patterns

Backend architecture patterns for KarmaSuite's monorepo (Next.js Pages Router + tRPC + Prisma).

## tRPC API Patterns

### Router Definition

```typescript
// ✅ tRPC router with Zod validation
export const fundRouter = createTRPCRouter({
  getAll: protectedProcedure
    .input(z.object({
      status: z.nativeEnum(FundStatusKind).optional(),
      limit: z.number().min(1).max(100).default(50),
    }))
    .query(async ({ ctx, input }) => {
      return ctx.prisma.fund.findMany({
        where: input.status ? { status: input.status } : undefined,
        take: input.limit,
        select: { id: true, name: true, status: true },
      })
    }),

  create: protectedProcedure
    .input(CreateFundSchema)
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.fund.create({ data: input })
    }),
})
```

### Error Handling in tRPC

```typescript
// ✅ Use TRPCError for consistent error responses
import { TRPCError } from '@trpc/server'

export const expenseRouter = createTRPCRouter({
  getById: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const expense = await ctx.prisma.expense.findUnique({
        where: { id: input.id },
      })

      if (!expense) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Expense ${input.id} not found`,
        })
      }

      return expense
    }),
})

// ✅ Client-side error handling
const { data, error } = trpc.expense.getById.useQuery(
  { id: expenseId },
  {
    onError: (err) => {
      Sentry.captureException(err)
    },
  }
)
```

## Prisma Database Patterns

### Query Optimization

```typescript
// ✅ GOOD: Select only needed columns
const funds = await prisma.fund.findMany({
  where: { status: FundStatusKind.ACTIVE },
  select: { id: true, name: true, balance: true },
  orderBy: { name: 'asc' },
  take: 10,
})

// ❌ BAD: Select everything
const funds = await prisma.fund.findMany()
```

### N+1 Query Prevention

```typescript
// ❌ BAD: N+1 query problem
const expenses = await prisma.expense.findMany()
for (const expense of expenses) {
  expense.fund = await prisma.fund.findUnique({ where: { id: expense.fundId } })
}

// ✅ GOOD: Use Prisma include/select for joins
const expenses = await prisma.expense.findMany({
  include: { fund: { select: { id: true, name: true } } },
})
```

### Transaction Pattern

```typescript
// ✅ Use Prisma interactive transactions for atomic operations
async function allocateExpense(expenseId: string, allocations: AllocationInput[]) {
  return prisma.$transaction(async (tx) => {
    const expense = await tx.expense.findUniqueOrThrow({
      where: { id: expenseId },
    })

    // Create allocations atomically
    await tx.allocation.createMany({
      data: allocations.map((a) => ({
        expenseId,
        fundId: a.fundId,
        amount: a.amount,
      })),
    })

    // Update expense status
    await tx.expense.update({
      where: { id: expenseId },
      data: { status: ExpenseStatusKind.ALLOCATED },
    })

    return expense
  })
}
```

### Batch Operations

```typescript
// ✅ Batch queries with Promise.all for independent operations
const [funds, expenses, allocations] = await Promise.all([
  prisma.fund.findMany({ where: { status: FundStatusKind.ACTIVE } }),
  prisma.expense.findMany({ where: { periodId } }),
  prisma.allocation.findMany({ where: { periodId } }),
])

// ✅ Use MathUtils.sum() for calculations
const totalAllocated = MathUtils.sum(allocations.map((a) => a.amount))
```

## Clerk Authentication

```typescript
// ✅ Auth is handled by Clerk middleware + tRPC context
// protectedProcedure automatically validates the session
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.auth?.userId) {
    throw new TRPCError({ code: 'UNAUTHORIZED' })
  }
  return next({ ctx: { ...ctx, auth: ctx.auth } })
})
```

## Inngest Background Jobs

```typescript
import { inngest } from '@/inngest/client'

// ✅ Define Inngest functions for background processing
export const syncGLTransactions = inngest.createFunction(
  { id: 'sync-gl-transactions', retries: 3 },
  { event: 'gl/sync.requested' },
  async ({ event, step }) => {
    const { organizationId, provider } = event.data

    const transactions = await step.run('fetch-transactions', async () => {
      return fetchTransactionsFromGL(organizationId, provider)
    })

    await step.run('save-transactions', async () => {
      return prisma.gLTransaction.createMany({ data: transactions })
    })
  }
)

// ✅ Trigger from tRPC
export const glRouter = createTRPCRouter({
  syncTransactions: protectedProcedure
    .input(z.object({ provider: z.nativeEnum(GLProvider) }))
    .mutation(async ({ ctx, input }) => {
      await inngest.send({
        name: 'gl/sync.requested',
        data: {
          organizationId: ctx.auth.orgId,
          provider: input.provider,
        },
      })
    }),
})
```

## Error Tracking with Sentry

```typescript
// ✅ Capture errors in server-side code
import * as Sentry from '@sentry/nextjs'

try {
  await riskyOperation()
} catch (error) {
  Sentry.captureException(error, {
    extra: { organizationId, fundId },
  })
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Operation failed',
  })
}
```

## Retry with Exponential Backoff

```typescript
async function fetchWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3
): Promise<T> {
  let lastError: Error

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error as Error

      if (i < maxRetries - 1) {
        const delay = Math.pow(2, i) * 1000
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  throw lastError!
}
```

## Coding Conventions

- Use Prisma enum types (`FundStatusKind.ACTIVE`) not string literals (`"ACTIVE"`)
- Use `MathUtils.sum()` for all summation calculations
- Use `Promise.all` for independent async operations
- Perform aggregations in database when possible
- Use atomic transactions for related DB operations
- Use `@karmasuite/prisma` for all Prisma imports
