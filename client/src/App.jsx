import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import ScrollToTop from './components/common/ScrollToTop'
import Layout from './components/layout/Layout'
import ProtectedRoute from './components/common/ProtectedRoute'
import HomePage from './pages/HomePage'
import LoginPage from './pages/LoginPage'

// Route-level code splitting: keep HomePage + LoginPage eager, lazy-load the rest
// to trim the landing/login bundle. PlayerPage / LandingPage / AdminDashboard are
// the heaviest (artplayer + motion + admin charts) so they MUST stay lazy.
const LandingPage = lazy(() => import('./pages/LandingPage'))
const SeasonPage = lazy(() => import('./pages/SeasonPage'))
const AnimeDetailPage = lazy(() => import('./pages/AnimeDetailPage'))
const SearchPage = lazy(() => import('./pages/SearchPage'))
const RegisterPage = lazy(() => import('./pages/RegisterPage'))
const ProfilePage = lazy(() => import('./pages/ProfilePage'))
const UserProfilePage = lazy(() => import('./pages/UserProfilePage'))
const FollowListPage = lazy(() => import('./pages/FollowListPage'))
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage'))
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage'))
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'))
const PlayerPage = lazy(() => import('./pages/PlayerPage'))
const LibraryPage = lazy(() => import('./pages/LibraryPage'))
const CalendarPage = lazy(() => import('./pages/CalendarPage'))
const FaqPage = lazy(() => import('./pages/FaqPage'))

export default function App() {
  return (
    <BrowserRouter>
      <ScrollToTop />
      <Suspense fallback={null}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/"          element={<HomePage />} />
            <Route path="/about"     element={<LandingPage />} />
            <Route path="/season"    element={<SeasonPage />} />
            <Route path="/anime/:id" element={<AnimeDetailPage />} />
            <Route path="/search"    element={<SearchPage />} />
            <Route path="/calendar"  element={<CalendarPage />} />
            <Route path="/faq"       element={<FaqPage />} />
            <Route path="/player"    element={<ProtectedRoute><PlayerPage /></ProtectedRoute>} />
            <Route path="/library"   element={<ProtectedRoute><LibraryPage /></ProtectedRoute>} />
            <Route path="/login"                   element={<LoginPage />} />
            <Route path="/register"                element={<RegisterPage />} />
            <Route path="/forgot-password"         element={<ForgotPasswordPage />} />
            <Route path="/reset-password/:token"   element={<ResetPasswordPage />} />
            <Route path="/profile"                 element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
            <Route path="/admin"                   element={<ProtectedRoute><AdminDashboard /></ProtectedRoute>} />
            <Route path="/u/:username"             element={<UserProfilePage />} />
            <Route path="/u/:username/followers"  element={<FollowListPage type="followers" />} />
            <Route path="/u/:username/following"  element={<FollowListPage type="following" />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}
