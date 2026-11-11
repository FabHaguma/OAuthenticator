import { useState } from 'react';
import { ArrowRight, Eye, EyeOff, KeyRound, ShieldCheck } from 'lucide-react';
import { api } from '../api';

export default function Login() {
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const returnTo = new URLSearchParams(window.location.search).get('returnTo');

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await api('/login', {
        method: 'POST',
        body: JSON.stringify({ password, ...(returnTo ? { returnTo } : {}) }),
      });
      window.location.assign(data.redirectTo);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="login-shell">
      <header className="login-header">
        <a className="brand" href="/" aria-label="Gatekeeper home"><ShieldCheck aria-hidden="true" /> Gatekeeper</a>
        <span className="quiet-label">Your personal gateway</span>
      </header>
      <main className="login-main">
        <section className="login-intro" aria-labelledby="welcome-heading">
          <div className="eyebrow"><span className="status-dot" /> A little privacy, everywhere</div>
          <h1 id="welcome-heading">Your apps.<br />{' '}One front door.</h1>
          <p>One sign-in for your personal corner of the web. Everything you need, kept just for you.</p>
          <div className="intro-note"><ShieldCheck aria-hidden="true" /><span>A private space for your everyday tools.</span></div>
        </section>
        <section className="login-card" aria-labelledby="signin-heading">
          <div className="icon-tile"><KeyRound aria-hidden="true" /></div>
          <h2 id="signin-heading">Welcome back.</h2>
          <p className="muted">{returnTo ? 'Sign in to continue to your app.' : 'Sign in to open your apps and manage access.'}</p>
          <form onSubmit={handleSubmit}>
            <label htmlFor="password">Your password</label>
            <div className="password-field">
              <input id="password" name="password" type={visible ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} aria-invalid={Boolean(error)} aria-describedby={error ? 'login-error' : undefined} />
              <button type="button" className="password-toggle" onClick={() => setVisible(!visible)} aria-label={visible ? 'Hide password' : 'Show password'} aria-pressed={visible}>
                {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              </button>
            </div>
            {error && <p className="alert alert-error" id="login-error" role="alert">{error}</p>}
            <button className="button button-primary button-full" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'} <ArrowRight aria-hidden="true" /></button>
          </form>
          <p className="form-note">Private access. No public sign-ups.</p>
        </section>
      </main>
      <footer className="site-footer"><span>Gatekeeper</span><span>One login. Your own space.</span></footer>
    </div>
  );
}
