import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { getMe, login as apiLogin, register as apiRegister, logout as apiLogout } from '../api/auth.api';
import { setAccessToken } from '../api/axiosClient';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null);
  const [loading, setLoading] = useState(true);

  // On mount, try to restore session via refresh cookie
  useEffect(() => {
    (async () => {
      try {
        // Use plain axios (NOT the intercepted api) to avoid triggering the 401 interceptor
        const { data } = await axios.post('/api/auth/refresh', {}, { withCredentials: true });
        setAccessToken(data.data.accessToken);
        const me = await getMe();
        setUser(me.data.data.user);
      } catch {
        // No valid session — stay as guest, do NOT redirect
        setUser(null);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Listen for token expiry event dispatched by axiosClient interceptor
  useEffect(() => {
    const handleExpired = () => {
      setAccessToken(null);
      setUser(null);
    };
    window.addEventListener('auth:expired', handleExpired);
    return () => window.removeEventListener('auth:expired', handleExpired);
  }, []);

  const login = useCallback(async (email, password) => {
    const res = await apiLogin({ email, password });
    setAccessToken(res.data.data.accessToken);
    setUser(res.data.data.user);
    return res.data.data.user;
  }, []);

  const register = useCallback(async (username, email, password) => {
    const res = await apiRegister({ username, email, password });
    setAccessToken(res.data.data.accessToken);
    setUser(res.data.data.user);
    return res.data.data.user;
  }, []);

  const logout = useCallback(async () => {
    await apiLogout().catch(() => {});
    setAccessToken(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
