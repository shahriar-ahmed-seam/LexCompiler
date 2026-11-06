import React, { useEffect, useState } from 'react';
import { Scale } from 'lucide-react';
import { LoginHero } from '../dark/LoginHero';
import { api, navigate } from '../api';
import { Button, ErrorNote, Field, Input } from '../ui';
import { safeReturnPath } from '../../../shared/safePath';
import type { Me } from '../types';

export function LoginPage({ me, onSignedIn }: { me: Me | null; onSignedIn: () => Promise<void> }) {
  const returnTo = new URLSearchParams(window.location.search).get('returnTo') || '/app';
  const safeReturn = safeReturnPath(returnTo, '/app');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Which sign-in methods the server offers; until it answers, show the password form.
  const [config, setConfig] = useState<{ oidcEnabled: boolean; passwordSignIn: boolean; loginUrl: string | null } | null>(null);
  useEffect(() => {
    api<{ oidcEnabled: boolean; passwordSignIn: boolean; loginUrl: string | null }>('/auth/config').then(setConfig, () => setConfig(null));
  }, []);
  const sso = Boolean(config?.oidcEnabled && config.loginUrl);
  const passwordForm = !sso || Boolean(config?.passwordSignIn);
  useEffect(() => {
    if (me) navigate(safeReturn, true);
  }, [me, safeReturn]);

  const signInWithSso = () => window.location.assign(`${config?.loginUrl ?? '/api/auth/login'}?returnTo=${encodeURIComponent(safeReturn)}`);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/password', { body: { email, password } });
      await onSignedIn();
      // Pages outside the web app (the engine console) load on their own.
      if (safeReturn.startsWith('/app')) navigate(safeReturn, true);
      else window.location.assign(safeReturn);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_1.05fr]">
      <div className="flex flex-col px-6 py-8 sm:px-12">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-zinc-900 text-white">
            <Scale className="size-4" aria-hidden />
          </span>
          <span className="text-lg font-semibold tracking-tight">LexCompiler</span>
        </div>
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-12">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Sign in to your workspace</h1>
          <p className="mt-1.5 text-sm text-zinc-500">Use the email address your workspace owner invited.</p>
          {sso && (
            <Button type="button" variant="primary" className="mt-8 w-full" onClick={signInWithSso}>
              Sign in with single sign-on
            </Button>
          )}
          {passwordForm && (
          <form className={sso ? 'mt-6 space-y-4 border-t border-zinc-100 pt-6' : 'mt-8 space-y-4'} onSubmit={submit}>
            <Field label="Work email" htmlFor="email">
              <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
            </Field>
            <Field label="Password" htmlFor="password">
              <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            {error && <ErrorNote>{error}</ErrorNote>}
            <Button type="submit" variant={sso ? 'secondary' : 'primary'} loading={busy} className="w-full">
              Sign in
            </Button>
          </form>
          )}
          <p className="mt-8 text-xs leading-relaxed text-zinc-500">Auditors don't need an account: open the share link you were sent.</p>
        </div>
        <div className="text-xs text-zinc-500">© {new Date().getFullYear()} LexCompiler</div>
      </div>

      <LoginHero />
    </div>
  );
}
