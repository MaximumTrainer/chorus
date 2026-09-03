import { createBrowserRouter } from 'react-router-dom'
import Home from './pages/Home'
import Settings from './pages/Settings'

export const router = createBrowserRouter([
  { path: '/', element: <Home /> },
  { path: '/settings', element: <Settings /> },
  { path: '/users/:id', element: <UserDetail /> },
])
