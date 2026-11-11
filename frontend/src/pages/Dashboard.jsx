import { useEffect, useState } from 'react';
import { ArrowUpRight, Clock3, Laptop, LogOut, RefreshCw, ShieldCheck, Smartphone } from 'lucide-react';
import { api } from '../api';

function dateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function deviceName(userAgent = '') {
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Firefox\//.test(userAgent) ? 'Firefox' : /Chrome\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : 'Browser';
  const platform = /iPhone|iPad/.test(userAgent) ? 'iOS' : /Android/.test(userAgent) ? 'Android' : /Windows/.test(userAgent) ? 'Windows' : /Macintosh/.test(userAgent) ? 'macOS' : /Linux/.test(userAgent) ? 'Linux' : 'this device';
  return `${browser} on ${platform}`;
}

export default function Dashboard({ session, onExpired }) {
  const [apps, setApps] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function refresh() {
    try {
      const [appData, sessionData] = await Promise.all([api('/apps'), api('/sessions')]);
      setApps(appData.apps);
      setSessions(sessionData.sessions);
      setError('');
    } catch (err) {
      if (err.status === 401) onExpired();
      else setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    Promise.all([api('/apps'), api('/sessions')])
      .then(([appData, sessionData]) => {
        if (active) {
          setApps(appData.apps);
          setSessions(sessionData.sessions);
        }
      })
      .catch((err) => {
        if (!active) return;
        if (err.status === 401) onExpired();
        else setError(err.message);
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [onExpired]);

  async function mutate(path, action, message) {
    setBusy(action);
    setError('');
    setNotice('');
    try {
      await api(path, { method: 'POST', csrfToken: session.csrfToken, body: '{}' });
      if (path === '/logout') { window.location.assign('/login'); return; }
      setNotice(message);
      await refresh();
    } catch (err) {
      if (err.status === 401) onExpired();
      else setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function handleRefresh() { setBusy('refresh'); await refresh(); setBusy(''); }
  const otherSessions = sessions.filter((item) => !item.current);

  return (
    <div className="dashboard-shell">
      <header className="dashboard-header">
        <a className="brand" href="/" aria-label="Gatekeeper home"><ShieldCheck aria-hidden="true" /> Gatekeeper</a>
        <div className="header-actions"><span className="signed-in-as">{session.username}</span><button className="button button-subtle" disabled={Boolean(busy)} onClick={() => mutate('/logout', 'logout', '')}><LogOut aria-hidden="true" /> {busy === 'logout' ? 'Signing out…' : 'Sign out'}</button></div>
      </header>
      <main className="dashboard-main">
        <section className="dashboard-intro" aria-labelledby="dashboard-title">
          <div><div className="eyebrow"><span className="status-dot" /> Your private workspace</div><h1 id="dashboard-title">You’re home, {session.username}.</h1><p className="muted">Open an app, or check where you’re signed in.</p></div>
          <div className="access-badge"><ShieldCheck aria-hidden="true" /><span>Signed in<br /><small>Expires {dateTime(session.expiresAt)}</small></span></div>
        </section>
        {error && <p className="alert alert-error" role="alert">{error}</p>}
        {notice && <p className="alert alert-success" role="status">{notice}</p>}
        <section className="dashboard-section" aria-labelledby="apps-heading">
          <div className="section-heading"><div><span className="section-kicker">YOUR COLLECTION</span><h2 id="apps-heading">Apps</h2></div><span className="count-label">{apps.length} {apps.length === 1 ? 'app' : 'apps'}</span></div>
          {loading ? <div className="empty-panel" role="status">Loading your apps…</div> : apps.length ? (
            <div className="apps-grid">{apps.map((app, index) => (
              <a className="app-card" key={app.id} href={app.url}><div className={`app-monogram app-color-${index % 3}`} aria-hidden="true">{app.name?.slice(0, 1).toUpperCase() || 'A'}</div><div className="app-description"><h3>{app.name}</h3><p>{new URL(app.url).host}</p></div><ArrowUpRight className="app-arrow" aria-hidden="true" /></a>
            ))}</div>
          ) : <div className="empty-panel"><ShieldCheck aria-hidden="true" /><h3>Your apps will live here.</h3><p className="muted">Once an app is connected to Gatekeeper, you can open it from this page.</p></div>}
        </section>
        <section className="dashboard-section" aria-labelledby="sessions-heading">
          <div className="section-heading sessions-heading">
            <div><span className="section-kicker">STAY IN CONTROL</span><h2 id="sessions-heading">Your sessions</h2><p className="muted">End access on devices you no longer use.</p></div>
            <div className="section-actions"><button className="button button-subtle" disabled={loading || Boolean(busy)} onClick={handleRefresh}><RefreshCw aria-hidden="true" />{busy === 'refresh' ? 'Refreshing…' : 'Refresh'}</button>{otherSessions.length > 0 && <button className="button button-outline" disabled={Boolean(busy)} onClick={() => mutate('/sessions/revoke-others', 'others', 'You signed out all other sessions.')}>{busy === 'others' ? 'Signing out…' : 'Sign out other sessions'}</button>}</div>
          </div>
          <div className="sessions-panel">
            {loading ? <p className="panel-message" role="status">Loading your sessions…</p> : sessions.length ? (
              <ul className="session-list">{sessions.map((item) => {
                const Device = /Mobile|Android|iPhone/.test(item.userAgent || '') ? Smartphone : Laptop;
                return <li key={item.id} className="session-row"><div className="device-icon"><Device aria-hidden="true" /></div><div className="session-details"><div className="session-title"><h3>{deviceName(item.userAgent)}</h3>{item.current && <span className="current-badge">This session</span>}</div><p className="session-meta">{item.ipAddress || 'Unknown address'} <span aria-hidden="true">·</span> Signed in {dateTime(item.createdAt)}</p><p className="session-meta">Last seen {dateTime(item.lastSeenAt)} <span aria-hidden="true">·</span> Expires {dateTime(item.expiresAt)}</p></div>{!item.current && <button className="button button-danger" disabled={Boolean(busy)} aria-label={`Sign out ${deviceName(item.userAgent)} session from ${dateTime(item.createdAt)}`} onClick={() => mutate(`/sessions/${encodeURIComponent(item.id)}/revoke`, item.id, 'That session has been signed out.')}>{busy === item.id ? 'Signing out…' : 'Sign out'}</button>}</li>;
              })}</ul>
            ) : <p className="panel-message">No active sessions to display.</p>}
            <p className="session-footnote"><Clock3 aria-hidden="true" />Signing out a session blocks its next protected request.</p>
          </div>
        </section>
      </main>
      <footer className="site-footer"><span>Gatekeeper</span><span>Your apps. Your access.</span></footer>
    </div>
  );
}
