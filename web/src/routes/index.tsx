import { createFileRoute } from '@tanstack/react-router'
import { ErrorBoundary } from '../ErrorBoundary'
import { HomePage } from '../HomePage'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  return (
    <ErrorBoundary>
      <HomePage />
    </ErrorBoundary>
  )
}
