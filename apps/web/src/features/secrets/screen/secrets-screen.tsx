import { Key, Lock, Plus, Trash2 } from '@icons';
import { Repeat, Show } from 'meemaw';
import { useState } from 'react';

import { ApiError } from '@shared/api/client';
import {
  Button, EmptyState, Field, Input, LoadingState, PageHeader, Sheet, Table, Td, Th,
} from '@shared/ui/primitives';
import { formatRelative } from '@shared/ui/status';
import { list } from '@shared/utils/list';

import { useCreateSecret, useDeleteSecret, useSecrets } from '../api/use-secrets';

/**
 * Secrets.
 *
 * Write-only by design, and the UI says so plainly rather than leaving a user hunting for a
 * "reveal" button that does not exist. There is no endpoint that returns a plaintext value — not
 * for an admin, not for the owner.
 */
export default function SecretsScreen() {
  const { data, isLoading } = useSecrets();
  const create = useCreateSecret();
  const remove = useDeleteSecret();

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [topError, setTopError] = useState<string | null>(null);

  async function onCreate(): Promise<void> {
    setErrors({});
    setTopError(null);
    try {
      await create.mutateAsync({ name, value });
      setName(''); setValue(''); setAdding(false);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors ?? {});
        if (!err.isValidation) setTopError(err.displayMessage);
      } else {
        setTopError('Could not reach the server.');
      }
    }
  }

  return (
    <div className="mx-auto max-w-[840px]">
      <PageHeader
        title="Secrets"
        subtitle="Referenced in a step as {{ secrets.NAME }}. Stored encrypted; never shown again."
        actions={
          <Show when={!adding}>
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
              New secret
            </Button>
          </Show>
        }
      />

      <Show when={adding}>
        <Sheet className="mb-5" padding="md">
          <p className="overline mb-3">New secret</p>
          <div className="flex flex-col gap-3">
            <Field
              label="Name"
              hint="Letters, numbers and underscores. This is what you reference in a step."
              error={errors['name']?.[0]}
            >
              <Input
                mono placeholder="STRIPE_API_KEY" value={name}
                onChange={(e) => setName(e.target.value)}
                invalid={errors['name'] !== undefined}
              />
            </Field>
            <Field label="Value" error={errors['value']?.[0]}>
              <Input
                type="password" mono value={value}
                onChange={(e) => setValue(e.target.value)}
                invalid={errors['value'] !== undefined}
              />
            </Field>
            <Show when={topError !== null}>
              <p className="text-[12px] text-short">{topError}</p>
            </Show>
            <div className="flex gap-2">
              <Button variant="primary" loading={create.isPending} onClick={() => void onCreate()}>
                Save
              </Button>
              <Button variant="quiet" onClick={() => { setAdding(false); setErrors({}); setTopError(null); }}>
                Cancel
              </Button>
            </div>
          </div>
        </Sheet>
      </Show>

      <Show when={isLoading}><LoadingState /></Show>

      <Show when={!isLoading}>
        <Show
          when={(data?.length ?? 0) > 0}
          fallback={
            <Sheet padding="lg">
              <EmptyState
                icon={<Key size={28} />}
                title="No secrets yet"
                description="Add an API key or token here, then reference it in a step without it ever appearing in a run record."
              />
            </Sheet>
          }
        >
          <Sheet padding="none">
            <div className="px-5 pt-4">
              <Table caption="Secrets">
                <thead>
                  <tr>
                    <Th>Name</Th><Th>Value</Th>
                    <Th align="right">Last used</Th><Th align="right">Added</Th><Th align="right"><span className="sr-only">Actions</span></Th>
                  </tr>
                </thead>
                <tbody>
                  <Repeat each={list(data)}>
                    {(secret) => (
                      <tr key={secret.id} className="group transition-colors hover:bg-sheet-2">
                        <Td mono className="text-ink">{secret.name}</Td>
                        <Td>
                          <span className="flex items-center gap-1.5 text-ink-4">
                            <Lock size={11} />
                            <span className="rec">never shown</span>
                          </span>
                        </Td>
                        <Td align="right" mono className="text-ink-3">
                          {secret.last_used_at === null ? 'never' : formatRelative(secret.last_used_at)}
                        </Td>
                        <Td align="right" mono className="text-ink-3">
                          {formatRelative(secret.created_at)}
                        </Td>
                        <Td align="right">
                          <span className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                            <Button
                              size="sm" variant="quiet" icon={<Trash2 size={12} />}
                              aria-label={`Delete ${secret.name}`}
                              onClick={() => remove.mutate(secret.id)}
                            />
                          </span>
                        </Td>
                      </tr>
                    )}
                  </Repeat>
                </tbody>
              </Table>
            </div>
          </Sheet>
        </Show>
      </Show>
    </div>
  );
}
