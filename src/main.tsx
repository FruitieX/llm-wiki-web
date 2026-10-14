import './styles.css'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { lazy, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ApiError } from './lib/api'
import { AuthGate } from './components/Auth'
import { Shell } from './components/Shell'
import { Home } from './routes/Home'
import { PageView } from './routes/PageView'
import { RawView } from './routes/RawView'
import { History } from './routes/History'
import { AllPages } from './routes/AllPages'
import { NotFound } from './components/States'

// The editor pulls in CodeMirror; load it only when editing.
const Editor = lazy(() => import('./routes/Editor'))

const rootRoute = createRootRoute({
  component: () => (
    <AuthGate>
      <Shell />
    </AuthGate>
  ),
  notFoundComponent: () => <NotFound />,
})

const routes = [
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: Home }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/pages',
    component: AllPages,
    validateSearch: (search: Record<string, unknown>) => ({
      filter: typeof search.filter === 'string' ? search.filter : undefined,
    }),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/page/$',
    component: PageView,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/raw/$',
    component: RawView,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/history/$',
    component: History,
    validateSearch: (search: Record<string, unknown>) => ({
      rev: typeof search.rev === 'string' ? search.rev : undefined,
    }),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/edit/$',
    component: () => <Editor mode="edit" />,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/new',
    component: () => <Editor mode="new" />,
    validateSearch: (search: Record<string, unknown>) => ({
      folder: typeof search.folder === 'string' ? search.folder : undefined,
      template:
        typeof search.template === 'string' ? search.template : undefined,
      name: typeof search.name === 'string' ? search.name : undefined,
    }),
  }),
]

const router = createRouter({
  routeTree: rootRoute.addChildren(routes),
  defaultPreload: 'intent',
  scrollRestoration: true,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) =>
        count < 2 &&
        !(
          error instanceof ApiError &&
          error.status >= 400 &&
          error.status < 500
        ),
      refetchOnWindowFocus: true,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
