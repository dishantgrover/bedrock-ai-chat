import { useState } from 'react';

import { completeNewPassword, signIn } from '../auth.js';

/**
 * Sign-in screen. Accounts are created by an administrator, so there is no
 * self-service signup. A first sign-in with a temporary password transitions
 * this form into the set-a-new-password state.
 *
 * @param {{onSignedIn: () => void}} props Callback once a session exists.
 */
export default function Login({ onSignedIn }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);

    try {
      if (mustChangePassword) {
        if (newPassword !== confirmPassword) {
          throw new Error('Passwords do not match.');
        }
        await completeNewPassword(newPassword);
        onSignedIn();
        return;
      }

      const result = await signIn(username.trim(), password);
      if (result.status === 'newPasswordRequired') {
        setMustChangePassword(true);
        return;
      }
      onSignedIn();
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold">AI Chat</h1>
          <p className="mt-2 text-sm text-zinc-400">
            {mustChangePassword
              ? 'Choose a permanent password to finish setting up your account.'
              : 'Sign in to continue.'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {mustChangePassword ? (
            <>
              <Field
                label="New password"
                type="password"
                value={newPassword}
                onChange={setNewPassword}
                autoComplete="new-password"
                required
              />
              <Field
                label="Confirm password"
                type="password"
                value={confirmPassword}
                onChange={setConfirmPassword}
                autoComplete="new-password"
                required
              />
            </>
          ) : (
            <>
              <Field
                label="Username"
                type="text"
                value={username}
                onChange={setUsername}
                autoComplete="username"
                autoCapitalize="none"
                required
              />
              <Field
                label="Password"
                type="password"
                value={password}
                onChange={setPassword}
                autoComplete="current-password"
                required
              />
            </>
          )}

          {error && (
            <p role="alert" className="text-sm text-red-400">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-zinc-100 px-4 py-3 text-sm font-medium text-zinc-900 transition hover:bg-white disabled:opacity-50"
          >
            {busy ? 'Working...' : mustChangePassword ? 'Set password' : 'Sign in'}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-zinc-500">
          Accounts are issued by the administrator.
        </p>
      </div>
    </div>
  );
}

/**
 * Labelled text input.
 *
 * @param {Object} props Input props; `onChange` receives the raw value.
 */
function Field({ label, value, onChange, ...rest }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm text-zinc-300">{label}</span>
      <input
        {...rest}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-surface-border bg-surface-raised px-3 py-2.5 text-zinc-100 outline-none transition focus:border-zinc-500"
      />
    </label>
  );
}
