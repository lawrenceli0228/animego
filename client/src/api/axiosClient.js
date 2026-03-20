import axios from 'axios';

let accessToken = null;

export const setAccessToken = (token) => { accessToken = token; };
export const getAccessToken = () => accessToken;

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  withCredentials: true,
});

// Inject access token on every request
api.interceptors.request.use((config) => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  return config;
});

let isRefreshing = false;
let refreshQueue = [];

const processQueue = (error, token = null) => {
  refreshQueue.forEach(p => error ? p.reject(error) : p.resolve(token));
  refreshQueue = [];
};

// Auto-refresh access token on 401
api.interceptors.response.use(
  res => res,
  async (err) => {
    const original = err.config;

    // Skip retry if: not 401, already retried, or the failed request IS the refresh endpoint
    if (
      err.response?.status !== 401 ||
      original._retry ||
      original.url?.includes('/auth/refresh')
    ) {
      return Promise.reject(err);
    }

    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        refreshQueue.push({ resolve, reject });
      }).then(token => {
        original.headers.Authorization = `Bearer ${token}`;
        return api(original);
      });
    }

    original._retry = true;
    isRefreshing = true;

    try {
      // Use plain axios (no interceptor) to avoid recursive loop
      const refreshBase = import.meta.env.VITE_API_BASE_URL || '/api';
      const { data } = await axios.post(`${refreshBase}/auth/refresh`, {}, { withCredentials: true });
      const newToken = data.data.accessToken;
      setAccessToken(newToken);
      processQueue(null, newToken);
      original.headers.Authorization = `Bearer ${newToken}`;
      return api(original);
    } catch (refreshErr) {
      processQueue(refreshErr, null);
      setAccessToken(null);
      // Dispatch event instead of hard redirect — let React Router handle navigation
      window.dispatchEvent(new CustomEvent('auth:expired'));
      return Promise.reject(refreshErr);
    } finally {
      isRefreshing = false;
    }
  }
);

export default api;
