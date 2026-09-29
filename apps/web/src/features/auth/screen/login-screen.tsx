import { Show } from 'meemaw';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { ApiError } from '@shared/api/client';
import { ROUTES } from '@shared/constants/routes';
import { Button, Field, Input, Sheet } from '@shared/ui/primitives';

import { useAuth } from '../providers/auth-provider';

export default function LoginScreen() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});

    try {
      await login(email, password);
      navigate(ROUTES.DASHBOARD);
    } catch (err) {
      if (err instanceof ApiError) {
        // Branch on the stable IDENTITY, display the resolved MESSAGE. Never the other way round:
        // messages are copy and will change, identities are contract.
        setFieldErrors(err.fieldErrors ?? {});
        setError(
          err.reason === 'account_suspended'
            ? err.displayMessage
            : err.isValidation
              ? null
              : err.displayMessage,
        );
      } else {
        setError('Could not reach the server.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Sign in" subtitle="Your tasks, and everything they have done.">
      <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4">
        <Field label="Email" error={fieldErrors['email']?.[0]}>
          <Input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            invalid={fieldErrors['email'] !== undefined}
            required
            autoFocus
          />
        </Field>

        <Field label="Password" error={fieldErrors['password']?.[0]}>
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            invalid={fieldErrors['password'] !== undefined}
            required
          />
        </Field>

        <Show when={error !== null}>
          <p className="text-[12px] text-short">{error}</p>
        </Show>

        <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-1 w-full justify-center">
          Sign in
        </Button>
      </form>

      <p className="mt-5 text-center text-[12px] text-ink-3">
        No account?{' '}
        <Link to={ROUTES.AUTH.REGISTER} className="text-emerald-600 hover:underline">
          Create one
        </Link>
      </p>
    </AuthLayout>
  );
}

export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper-deep px-4">
      <div className="w-full max-w-[380px]">
        <div className="mb-7 text-center">
          <p className="serif text-[26px] font-semibold tracking-[-0.022em] text-ink">
            Klankish<span className="text-emerald-600">.</span>
          </p>
          <p className="mt-1 text-[12px] text-ink-3">{subtitle}</p>
        </div>

        <Sheet padding="lg">
          <h1 className="serif mb-5 text-[19px] font-semibold text-ink">{title}</h1>
          {children}
        </Sheet>
      </div>
    </div>
  );
}
