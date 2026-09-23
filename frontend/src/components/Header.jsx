import { NavLink } from 'react-router-dom'

import FontSizeControl from './FontSizeControl.jsx'
import Logo from './Logo.jsx'
import StarsToggle from './StarsToggle.jsx'
import ThemeToggle from './ThemeToggle.jsx'
import styles from './Header.module.css'

const linkClass = ({ isActive }) =>
  isActive ? `${styles.link} ${styles.linkActive}` : styles.link

export default function Header({ stars, onToggleStars }) {
  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <NavLink to="/" className={styles.brand}>
          <Logo size={26} />
          <span className={styles.wordmark}>Resume Tailor</span>
        </NavLink>

        <div className={styles.right}>
          <nav className={styles.nav}>
            <NavLink to="/" end className={linkClass}>
              Tailor
            </NavLink>
            <NavLink to="/register" className={linkClass}>
              User Registration
            </NavLink>
            <NavLink to="/registry" className={linkClass}>
              Registry
            </NavLink>
          </nav>

          <span className={styles.divider} aria-hidden="true" />
          <FontSizeControl />
          <StarsToggle enabled={stars} onToggle={onToggleStars} />
          <ThemeToggle />
        </div>
      </div>
    </header>
  )
}
