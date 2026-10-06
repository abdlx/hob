import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

if (localStorage.getItem('mused-contrast') === 'high') document.documentElement.style.filter = 'contrast(1.15)';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
