import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { api } from './api';
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';

export default function App() {
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');
  const onExpired = useCallback(() => setSession({ authenticated: false }), []);

  useEffect(() => {
    const controller = new AbortController();
    api('/session', { signal: controller.signal })
      .then(setSession)
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err.message);
      });
    return () => controller.abort();
  }, []);

  if (!session) {
    return (
      <main className="state-screen">
        <div className="brand"><ShieldCheck aria-hidden="true" /> Gatekeeper</div>
        {error ? (
          <>
            <h1>We couldn’t connect.</h1>
            <p className="muted" role="alert">{error}</p>
            <button className="button button-primary" onClick={() => window.location.reload()}>Try again</button>
          </>
        ) : <p className="muted" role="status">Checking your session…</p>}
      </main>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={session.authenticated ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/" element={session.authenticated
        ? <Dashboard session={session} onExpired={onExpired} />
        : <Navigate to="/login" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
