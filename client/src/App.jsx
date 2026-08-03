import { useEffect, useState } from 'react';
import TrendPage from './pages/TrendPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import CyclesPage from './pages/CyclesPage.jsx';
import CycleReportPage from './pages/CycleReportPage.jsx';

export default function App() {
  const [path, setPath] = useState(window.location.pathname);
  // A cycle's {from, to} picked on the Cycles page, handed to TrendPage so
  // it can jump straight to that cycle's range. Cleared once TrendPage has
  // consumed it, so navigating to Trend again later doesn't re-apply it.
  const [pendingRange, setPendingRange] = useState(null);

  useEffect(() => {
    function onPopState() {
      setPath(window.location.pathname);
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  function navigate(to) {
    if (to !== window.location.pathname) {
      window.history.pushState({}, '', to);
    }
    setPath(to);
  }

  function openCycle(range) {
    setPendingRange(range);
    navigate('/');
  }

  const reportMatch = path.match(/^\/cycles\/(\d+)\/report$/);

  const page = path === '/dashboard' ? 'dashboard' : path === '/cycles' ? 'cycles' : 'trend';

  if (reportMatch) return <CycleReportPage cycleId={reportMatch[1]} onNavigate={navigate} />;
  if (page === 'dashboard') return <DashboardPage page={page} onNavigate={navigate} />;
  if (page === 'cycles') return <CyclesPage page={page} onNavigate={navigate} onSelectCycle={openCycle} />;
  return (
    <TrendPage
      page={page}
      onNavigate={navigate}
      initialRange={pendingRange}
      onInitialRangeApplied={() => setPendingRange(null)}
    />
  );
}
