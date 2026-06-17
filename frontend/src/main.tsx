import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'sonner';

import App from './App';
import './styles/index.css';

const basePath = window.location.pathname.startsWith('/bngblaster-gui') ? '/bngblaster-gui' : '/';

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <BrowserRouter basename={basePath}>
            <App />
            <Toaster position="top-right" richColors />
        </BrowserRouter>
    </StrictMode>,
);
