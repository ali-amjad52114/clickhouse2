import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// No StrictMode: its double-invoked effects create and destroy the Phaser
// game twice on mount, which intermittently leaves a blank canvas in dev.
createRoot(document.getElementById('root')!).render(<App />)
