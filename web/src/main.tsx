import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initializeAppearance } from './services/appearance'
import { migrateHobPreferences } from './services/hob-storage'

migrateHobPreferences();
initializeAppearance();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
