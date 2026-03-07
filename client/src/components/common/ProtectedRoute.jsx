import { Navigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import LoadingSpinner from './LoadingSpinner';

export default function ProtectedRoute({ children }) {
  const { user, initializing } = useAuth();

  // Still checking session — wait before redirecting
  if (initializing) return <LoadingSpinner />;

  // Confirmed no session → go to login
  if (!user) return <Navigate to="/login" replace />;

  return children;
}
