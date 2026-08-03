export default function TopNav({ page, onNavigate, status }) {
  return (
    <header className="topbar">
      <div className="brand">
        <img src="/logo.png" alt="Isostatic Pressure" className="brand-logo" />
      </div>
      <nav className="nav-links" role="group" aria-label="Page">
        <button className={page === 'trend' ? 'active' : ''} onClick={() => onNavigate('/')}>
          Trend
        </button>
        <button className={page === 'cycles' ? 'active' : ''} onClick={() => onNavigate('/cycles')}>
          Cycles
        </button>
        <button className={page === 'dashboard' ? 'active' : ''} onClick={() => onNavigate('/dashboard')}>
          Dashboard
        </button>
      </nav>
      <div className={`plc-status ${status}`}>
        <span className="led" />
        {status === 'online' ? 'PLC online' : status === 'offline' ? 'PLC offline' : 'Connecting…'}
      </div>
    </header>
  );
}
