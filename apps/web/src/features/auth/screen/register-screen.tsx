import { Show } from 'meemaw';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { ApiError } from '@shared/api/client';
import { ROUTES } from '@shared/constants/routes';
import { Button, Field, Input } from '@shared/ui/primitives';

import { useAuth } from '../providers/auth-provider';
import { AuthLayout } from './login-screen';

export default function RegisterScreen() {
  const { register } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      await register(form);
      navigate(ROUTES.DASHBOARD);
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors ?? {});
        setError(err.isValidation ? null : err.displayMessage);
      } else {
        setError('Could not reach the server.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Create an account" subtitle="Scheduled work, with a record you can read.">
      <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4">
        <Field label="Name" error={fieldErrors['name']?.[0]}>
          <Input value={form.name} onChange={set('name')} invalid={fieldErrors['name'] !== undefined} required autoFocus />
        </Field>

        <Field label="Email" error={fieldErrors['email']?.[0]}>
          <Input type="email" autoComplete="email" value={form.email} onChange={set('email')} invalid={fieldErrors['email'] !== undefined} required />
        </Field>

        <Field
          label="Password"
          hint="At least 10 characters."
          error={fieldErrors['password']?.[0]}
        >
          <Input type="password" autoComplete="new-password" value={form.password} onChange={set('password')} invalid={fieldErrors['password'] !== undefined} required />
        </Field>

        <Show when={error !== null}>
          <p className="text-[12px] text-short">{error}</p>
        </Show>

        <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-1 w-full justify-center">
          Create account
        </Button>
      </form>

      <p className="mt-5 text-center text-[12px] text-ink-3">
        Already have one?{' '}
        <Link to={ROUTES.AUTH.LOGIN} className="text-emerald-600 hover:underline">Sign in</Link>
      </p>
    </AuthLayout>
  );
}
