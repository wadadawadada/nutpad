import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './lib/auth';
import { CelebrateProvider, ToastProvider } from './components/ui';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <CelebrateProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </CelebrateProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
