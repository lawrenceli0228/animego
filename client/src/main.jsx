import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'react-hot-toast'
import { AuthProvider } from './context/AuthContext'
import { LanguageProvider } from './context/LanguageContext'
import App from './App.jsx'
import './index.css'
import './components/landing/shared/motion.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 3 * 60 * 1000 }
  }
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <LanguageProvider>
      <AuthProvider>
        <App />
        <Toaster
          position="bottom-right"
          toastOptions={{
            style: {
              background: '#2c2c2e',
              color: '#ffffff',
              border: '1px solid rgba(10,132,255,0.3)',
              borderRadius: '10px',
              fontFamily: "'DM Sans', sans-serif"
            }
          }}
        />
      </AuthProvider>
      </LanguageProvider>
    </QueryClientProvider>
  </StrictMode>
)
