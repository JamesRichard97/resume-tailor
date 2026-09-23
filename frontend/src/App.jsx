import { Navigate, Route, Routes } from 'react-router-dom'

import Header from './components/Header.jsx'
import StarfieldBackground from './components/StarfieldBackground.jsx'
import { ToastProvider } from './components/Toast.jsx'
import HomePage from './pages/HomePage.jsx'
import RegistryPage from './pages/RegistryPage.jsx'
import UserRegistrationPage from './pages/UserRegistrationPage.jsx'
import { useStarfield } from './hooks/useStarfield.js'
import styles from './App.module.css'

export default function App() {
  const stars = useStarfield()

  return (
    <ToastProvider>
      <div className={styles.shell}>
        {stars.enabled && <StarfieldBackground />}
        <Header stars={stars.enabled} onToggleStars={stars.toggle} />
        <main className={styles.main}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/register" element={<UserRegistrationPage />} />
            <Route path="/registry" element={<RegistryPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </ToastProvider>
  )
}
