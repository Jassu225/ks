---
description: Frontend patterns for KarmaSuite - React, Next.js Pages Router, TailwindCSS, Radix UI, AG Grid, tRPC hooks.
---

# Frontend Development Patterns

Frontend patterns for KarmaSuite's React/Next.js Pages Router application.

## Component Patterns

### Component Structure with TailwindCSS

```typescript
import { FC, PropsWithChildren } from 'react'
import { cn } from '@karmasuite/utils'

interface CardProps {
  variant?: 'default' | 'outlined'
  className?: string
}

export const Card: FC<PropsWithChildren<CardProps>> = ({
  children,
  variant = 'default',
  className,
}) => {
  return (
    <div className={cn(
      'rounded-lg p-4',
      variant === 'default' && 'bg-white shadow',
      variant === 'outlined' && 'border border-gray-200',
      className
    )}>
      {children}
    </div>
  )
}
```

### Radix UI Compound Components

```typescript
import * as Dialog from '@radix-ui/react-dialog'

// ✅ Use Radix UI primitives for accessible modals, dropdowns, etc.
export function ConfirmDialog({ trigger, title, description, onConfirm }: ConfirmDialogProps) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-6 shadow-lg">
          <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-gray-600">
            {description}
          </Dialog.Description>
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button className="rounded px-4 py-2 text-gray-600 hover:bg-gray-100">Cancel</button>
            </Dialog.Close>
            <button
              onClick={onConfirm}
              className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
            >
              Confirm
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
```

## tRPC Data Fetching Patterns

### Query with Loading States

```typescript
// ✅ Use tRPC hooks (not raw fetch)
export function FundList() {
  const { data: funds, isLoading, error } = trpc.fund.getAll.useQuery({
    status: FundStatusKind.ACTIVE,
  })

  if (isLoading) return <Spinner />
  if (error) return <ErrorMessage error={error} />

  return (
    <div className="space-y-2">
      {funds?.map((fund) => <FundCard key={fund.id} fund={fund} />)}
    </div>
  )
}
```

### Mutations with Cache Invalidation

```typescript
// ✅ Invalidate related queries after mutations
export function useUpdateExpense() {
  const utils = trpc.useUtils()

  return trpc.expense.update.useMutation({
    onSuccess: () => {
      utils.expense.getAll.invalidate()
      utils.allocation.getByPeriod.invalidate()
    },
    onError: (err) => {
      toast.error(err.message)
    },
  })
}
```

## AG Grid Patterns

### Grid with Column Definitions

```typescript
import { AgGridReact } from 'ag-grid-react'
import { ColDef, ValueFormatterParams } from 'ag-grid-community'

// ✅ Define columns with proper types and formatters
const columnDefs: ColDef<Expense>[] = [
  { field: 'description', headerName: 'Description', flex: 2 },
  {
    field: 'amount',
    headerName: 'Amount',
    flex: 1,
    valueFormatter: (params: ValueFormatterParams<Expense>) =>
      formatCurrency(params.value),
  },
  {
    field: 'status',
    headerName: 'Status',
    flex: 1,
    cellRenderer: StatusBadge,
  },
]

export function ExpenseGrid({ expenses }: { expenses: Expense[] }) {
  return (
    <div className="ag-theme-alpine h-[600px]">
      <AgGridReact<Expense>
        rowData={expenses}
        columnDefs={columnDefs}
        defaultColDef={{ sortable: true, filter: true, resizable: true }}
        pagination
        paginationPageSize={50}
      />
    </div>
  )
}
```

## Custom Hooks

### Debounce Hook

```typescript
export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value)

  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay)
    return () => clearTimeout(handler)
  }, [value, delay])

  return debouncedValue
}
```

### Toggle Hook

```typescript
export function useToggle(initialValue = false): [boolean, () => void] {
  const [value, setValue] = useState(initialValue)
  const toggle = useCallback(() => setValue((v) => !v), [])
  return [value, toggle]
}
```

## Performance Optimization

### Memoization

```typescript
// ✅ useMemo for expensive computations
const sortedFunds = useMemo(() => {
  return funds.sort((a, b) => a.name.localeCompare(b.name))
}, [funds])

// ✅ useCallback for functions passed to children
const handleSearch = useCallback((query: string) => {
  setSearchQuery(query)
}, [])

// ✅ React.memo for pure components
export const FundCard = React.memo<FundCardProps>(({ fund }) => {
  return (
    <div className="rounded-lg border p-4">
      <h3 className="font-semibold">{fund.name}</h3>
      <p className="text-sm text-gray-600">{fund.description}</p>
    </div>
  )
})
```

### Lazy Loading

```typescript
import { lazy, Suspense } from 'react'

const AllocationChart = lazy(() => import('./AllocationChart'))

export function FundDashboard() {
  return (
    <Suspense fallback={<div className="h-64 animate-pulse bg-gray-100 rounded" />}>
      <AllocationChart fundId={fundId} />
    </Suspense>
  )
}
```

## Next.js Pages Router Patterns

### Page with getServerSideProps

```typescript
import { GetServerSideProps } from 'next'
import { getAuth } from '@clerk/nextjs/server'

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const { userId, orgId } = getAuth(ctx.req)

  if (!userId) {
    return { redirect: { destination: '/sign-in', permanent: false } }
  }

  return { props: { orgId } }
}
```

### Layout Pattern

```typescript
// ✅ Use layout components with _app.tsx
import type { AppProps } from 'next/app'
import { NextPageWithLayout } from '@/types'

type AppPropsWithLayout = AppProps & {
  Component: NextPageWithLayout
}

export default function App({ Component, pageProps }: AppPropsWithLayout) {
  const getLayout = Component.getLayout ?? ((page) => page)
  return getLayout(<Component {...pageProps} />)
}
```

## Accessibility

- Use Radix UI primitives for accessible interactive components
- Always include keyboard navigation for custom dropdowns/menus
- Use `aria-label` for icon-only buttons
- Manage focus when opening/closing modals and drawers
