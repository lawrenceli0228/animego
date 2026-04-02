import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import { getMe, login as apiLogin, register as apiRegister, logout as apiLogout } from '../api/auth.api';
import { setAccessToken } from '../api/axiosClient';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser]             = useState(null);
  const [initializing, setInit]     = useState(true);  // startup session check
  const [loading, setLoading]       = useState(false);  // login/register/logout ops

  const didInit = useRef(false);

  // On mount: silently try to restore session via refresh cookie
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    (async () => {
      try {
        const { data } = await axios.post('/api/auth/refresh', {}, { withCredentials: true });
        setAccessToken(data.data.accessToken);
        const me = await getMe();
        setUser(me.data.data.user);
      } catch {
        // No session — guest mode, never redirect
        setUser(null);
      } finally {
        setInit(false);
      }
    })();
  }, []);

  // Listen for token expiry dispatched by axiosClient
  useEffect(() => {
    const handleExpired = () => { setAccessToken(null); setUser(null); };
    window.addEventListener('auth:expired', handleExpired);
    return () => window.removeEventListener('auth:expired', handleExpired);
  }, []);

  const login = useCallback(async (email, password) => {
    setLoading(true);
    try {
      const res = await apiLogin({ email, password });
      setAccessToken(res.data.data.accessToken);
      setUser(res.data.data.user);
      return res.data.data.user;
    } finally { setLoading(false); }
  }, []);

  const register = useCallback(async (username, email, password) => {
    setLoading(true);
    try {
      const res = await apiRegister({ username, email, password });
      setAccessToken(res.data.data.accessToken);
      setUser(res.data.data.user);
      return res.data.data.user;
    } finally { setLoading(false); }
  }, []);

  const logout = useCallback(async () => {
    setLoading(true);
    try {
      await apiLogout().catch(() => {});
    } finally {
      setAccessToken(null);
      setUser(null);
      setLoading(false);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, initializing, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
