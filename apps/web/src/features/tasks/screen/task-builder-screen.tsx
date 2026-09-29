import { AlertTriangle, ArrowLeft, Plus, Trash2 } from '@icons';
import type { Step, StepKind, TaskGraph } from '@klankish/shared';
import { Repeat, Show } from 'meemaw';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { ApiError } from '@shared/api/client';
import { ROUTES } from '@shared/constants/routes';
import {
  Button,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
  Sheet,
  Textarea,
} from '@shared/ui/primitives';
import { StepKindMark } from '@shared/ui/status';
import { cn } from '@shared/utils/cn';
import { list } from '@shared/utils/list';

import {
  useCreateTask,
  useSchedulePreview,
  useTask,
  useUpdateTask,
} from '../api/use-tasks';

/**
 * The task builder.
 *
 * A form-based step LIST rather than a drag-and-drop canvas — stated as a non-goal in goals.md,
 * because a list covers the real cases at a fraction of the cost and is far easier to keep
 * accessible.
 *
 * Validation is the server's, not a reimplementation: the same `validateGraph` that guards the
 * save runs on every save attempt, and its per-step field errors are shown against the step they
 * belong to. A second client-side validator would eventually disagree with the real one, and the
 * disagreement would be invisible until a task failed at 3am.
 */

const STEP_KINDS: Array<{ value: StepKind; label: string; hint: string }> = [
  { value: 'http', label: 'HTTP request', hint: 'Call an API' },
  { value: 'branch', label: 'Branch', hint: 'Go somewhere based on a condition' },
  { value: 'transform', label: 'Transform', hint: 'Compute values from earlier steps' },
  { value: 'assert', label: 'Assert', hint: 'Fail unless a condition holds' },
  { value: 'delay', label: 'Delay', hint: 'Wait before continuing' },
  { value: 'shell', label: 'Command', hint: 'Run a command (if enabled on this instance)' },
  { value: 'noop', label: 'Marker', hint: 'Does nothing' },
];

interface DraftStep {
  key: string;
  name: string;
  kind: StepKind;
  next: string;
  // Per-kind fields, kept flat so the form stays simple. Serialised into a real Step on save.
  method: string;
  url: string;
  headers: string;
  body: string;
  condition: string;
  branchWhen: string;
  branchGoto: string;
  otherwise: string;
  setExpr: string;
  ms: string;
  command: string;
  captureName: string;
  captureFrom: string;
}

function emptyStep(index: number): DraftStep {
  return {
    key: `step_${index + 1}`,
    name: '',
    kind: 'http',
    next: '',
    method: 'GET',
    url: '',
    headers: '',
    body: '',
    condition: '',
    branchWhen: '',
    branchGoto: '',
    otherwise: '',
    setExpr: '',
    ms: '1000',
    command: '',
    captureName: '',
    captureFrom: '',
  };
}

/** Turn the flat draft into the real Step union the engine executes. */
function toStep(draft: DraftStep, nextKey: string | null): Step {
  const base = {
    key: draft.key.trim(),
    ...(draft.name.trim() !== '' && { name: draft.name.trim() }),
    next: nextKey,
    ...(draft.captureName.trim() !== '' &&
      draft.captureFrom.trim() !== '' && {
        capture: [{ name: draft.captureName.trim(), from: draft.captureFrom.trim() }],
      }),
  };

  switch (draft.kind) {
    case 'http': {
      let headers: Record<string, string> | undefined;
      if (draft.headers.trim() !== '') {
        try {
          headers = JSON.parse(draft.headers) as Record<string, string>;
        } catch {
          // Left undefined; the server's validation reports the real problem rather than this
          // form guessing at one.
        }
      }
      let body: unknown;
      if (draft.body.trim() !== '') {
        try {
          body = JSON.parse(draft.body);
        } catch {
          body = draft.body;
        }
      }
      return {
        ...base,
        kind: 'http',
        method: draft.method as 'GET',
        url: draft.url.trim(),
        ...(headers !== undefined && { headers }),
        ...(body !== undefined && { body }),
      };
    }
    case 'branch':
      return {
        ...base,
        kind: 'branch',
        cases:
          draft.branchWhen.trim() === ''
            ? []
            : [{ when: draft.branchWhen.trim(), goto: draft.branchGoto.trim() }],
        otherwise: draft.otherwise.trim() === '' ? null : draft.otherwise.trim(),
      };
    case 'transform': {
      const set: Record<string, string> = {};
      for (const line of draft.setExpr.split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) set[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
      return { ...base, kind: 'transform', set };
    }
    case 'assert':
      return { ...base, kind: 'assert', condition: draft.condition.trim() };
    case 'delay':
      return { ...base, kind: 'delay', ms: Number.parseInt(draft.ms, 10) || 1000 };
    case 'shell':
      return {
        ...base,
        kind: 'shell',
        // argv, split on whitespace — never a shell string. There is no shell, so there is
        // nothing to inject into.
        command: draft.command.trim().split(/\s+/).filter((c) => c !== ''),
      };
    default:
      return { ...base, kind: 'noop' };
  }
}

export default function TaskBuilderScreen() {
  const { id } = useParams<{ id: string }>();
  const isEdit = id !== undefined;
  const navigate = useNavigate();

  const { data: existing, isLoading } = useTask(id);
  const create = useCreateTask();
  const update = useUpdateTask(id ?? '');

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState<DraftStep[]>([emptyStep(0)]);
  const [scheduleKind, setScheduleKind] = useState<'manual' | 'cron' | 'interval'>('manual');
  const [cron, setCron] = useState('0 * * * *');
  const [timezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [topError, setTopError] = useState<string | null>(null);

  const preview = useSchedulePreview(scheduleKind === 'cron' ? cron : '', timezone);

  // Hydrate from an existing task once.
  const [hydrated, setHydrated] = useState(false);
  if (isEdit && existing !== undefined && !hydrated) {
    setName(existing.name);
    setDescription(existing.description ?? '');
    setHydrated(true);
  }

  const graph: TaskGraph = useMemo(() => {
    const built = steps.map((draft, i) => {
      const explicit = draft.next.trim();
      // An empty `next` means "the one after this", which is what a list implies. The last step
      // terminates.
      const fallback = i < steps.length - 1 ? (steps[i + 1]?.key.trim() ?? null) : null;
      return toStep(draft, explicit !== '' ? explicit : fallback);
    });
    return { version: 1, entry: steps[0]?.key.trim() ?? '', steps: built };
  }, [steps]);

  const updateStep = (i: number, patch: Partial<DraftStep>): void => {
    setSteps((prev) => prev.map((s, j) => (i === j ? { ...s, ...patch } : s)));
  };

  async function onSave(): Promise<void> {
    setErrors({});
    setTopError(null);

    const payload = {
      name: name.trim(),
      description: description.trim() === '' ? null : description.trim(),
      graph,
      ...(scheduleKind !== 'manual' && {
        schedule: {
          kind: scheduleKind,
          ...(scheduleKind === 'cron' && { cron_expr: cron, timezone }),
          ...(scheduleKind === 'interval' && { interval_ms: 900_000, timezone }),
        },
      }),
    };

    try {
      if (isEdit) {
        await update.mutateAsync(payload);
        navigate(ROUTES.TASKS.detail(id));
      } else {
        const created = await create.mutateAsync(payload);
        navigate(ROUTES.TASKS.detail(created.id));
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors ?? {});
        setTopError(err.isValidation ? 'This task has problems — see the notes below.' : err.displayMessage);
      } else {
        setTopError('Could not reach the server.');
      }
    }
  }

  if (isEdit && isLoading) return <LoadingState />;

  const busy = create.isPending || update.isPending;

  return (
    <div className="mx-auto max-w-[840px]">
      <Link
        to={ROUTES.TASKS.LIST}
        className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-ink-3 transition-colors hover:text-ink"
      >
        <ArrowLeft size={13} />
        All tasks
      </Link>

      <PageHeader
        title={isEdit ? 'Edit task' : 'New task'}
        subtitle="Steps run in order. Each one can read what the ones before it produced."
        actions={
          <Button variant="primary" loading={busy} onClick={() => void onSave()}>
            {isEdit ? 'Save version' : 'Create task'}
          </Button>
        }
      />

      <Show when={topError !== null}>
        <Sheet className="mb-5 border-short-edge bg-short-bg" padding="tight">
          <p className="flex items-center gap-2 text-[13px] text-short">
            <AlertTriangle size={14} />
            {topError}
          </p>
        </Sheet>
      </Show>

      {/* ---- definition ---- */}
      <Sheet className="mb-5" padding="md">
        <div className="flex flex-col gap-4">
          <Field label="Name" required error={errors['name']?.[0]}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nightly backup check"
              invalid={errors['name'] !== undefined}
            />
          </Field>
          <Field label="Description" hint="What this is for, in a sentence.">
            <Textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
      </Sheet>

      {/* ---- schedule ---- */}
      <Sheet className="mb-5" padding="md">
        <p className="overline mb-3">Schedule</p>
        <div className="flex flex-col gap-4">
          <Field label="When should this run?">
            <Select
              value={scheduleKind}
              onChange={(e) => setScheduleKind(e.target.value as typeof scheduleKind)}
            >
              <option value="manual">Only when I run it</option>
              <option value="cron">On a schedule</option>
              <option value="interval">Every 15 minutes</option>
            </Select>
          </Field>

          <Show when={scheduleKind === 'cron'}>
            <Field
              label="Schedule expression"
              hint={`Five fields: minute hour day month weekday. Times are ${timezone}.`}
              error={errors['schedule.cron_expr']?.[0]}
            >
              <Input
                mono
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                placeholder="0 9 * * 1-5"
                invalid={errors['schedule.cron_expr'] !== undefined}
              />
            </Field>

            {/* The preview is computed by the SERVER, using the same code the scheduler uses.
                A client-side cron parser would eventually disagree, and the disagreement would
                be invisible until a task fired at the wrong time. */}
            <Show when={preview.data !== undefined}>
              <div className="rounded-card border border-sheet-edge bg-paper-deep px-3 py-2.5">
                <p className="mb-1.5 text-[12px] text-ink-2">{preview.data?.description}</p>
                <Show
                  when={(preview.data?.next_fires.length ?? 0) > 0}
                  fallback={<p className="text-[11px] text-short">That is not a valid schedule.</p>}
                >
                  <p className="overline mb-1">Next runs</p>
                  <div className="flex flex-col gap-0.5">
                    <Repeat each={list(preview.data?.next_fires)}>
                      {(iso: string) => (
                        <span key={iso} className="rec">
                          {new Date(iso).toLocaleString(undefined, {
                            weekday: 'short',
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      )}
                    </Repeat>
                  </div>
                </Show>
              </div>
            </Show>
          </Show>
        </div>
      </Sheet>

      {/* ---- steps ---- */}
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="serif text-[17px] font-semibold text-ink">Steps</h2>
        <Button
          size="sm"
          variant="ghost"
          icon={<Plus size={13} />}
          onClick={() => setSteps((s) => [...s, emptyStep(s.length)])}
        >
          Add step
        </Button>
      </div>

      <div className="flex flex-col gap-3">
        <Repeat each={steps}>
          {(step: DraftStep, i: number) => (
            <StepCard
              key={i}
              index={i}
              step={step}
              errors={errors[step.key.trim()] ?? []}
              canRemove={steps.length > 1}
              onChange={(patch) => updateStep(i, patch)}
              onRemove={() => setSteps((s) => s.filter((_, j) => j !== i))}
            />
          )}
        </Repeat>
      </div>
    </div>
  );
}

function StepCard({
  index,
  step,
  errors,
  canRemove,
  onChange,
  onRemove,
}: {
  index: number;
  step: DraftStep;
  errors: string[];
  canRemove: boolean;
  onChange: (patch: Partial<DraftStep>) => void;
  onRemove: () => void;
}) {
  const hasError = errors.length > 0;

  return (
    <Sheet
      padding="md"
      className={cn(hasError && 'border-short-edge')}
    >
      <div className="mb-4 flex items-center gap-3">
        <span className="rec">{String(index).padStart(2, '0')}</span>
        <StepKindMark kind={step.kind} />
        <Input
          value={step.key}
          onChange={(e) => onChange({ key: e.target.value })}
          mono
          className="h-7 max-w-[160px] text-[12px]"
          aria-label="Step key"
        />
        <Select
          value={step.kind}
          onChange={(e) => onChange({ kind: e.target.value as StepKind })}
          className="h-7 max-w-[180px] text-[12px]"
          aria-label="Step kind"
        >
          <Repeat each={list(STEP_KINDS)}>
            {(k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            )}
          </Repeat>
        </Select>
        <Show when={canRemove}>
          <Button
            size="sm"
            variant="quiet"
            className="ml-auto"
            icon={<Trash2 size={12} />}
            aria-label={`Remove step ${step.key}`}
            onClick={onRemove}
          />
        </Show>
      </div>

      <Show when={hasError}>
        <div className="mb-3 rounded-sharp border border-short-edge bg-short-bg px-2.5 py-2">
          <Repeat each={errors}>
            {(msg: string) => (
              <p key={msg} className="text-[12px] text-short">
                {msg}
              </p>
            )}
          </Repeat>
        </div>
      </Show>

      <div className="flex flex-col gap-3">
        <Show when={step.kind === 'http'}>
          <div className="flex gap-2">
            <Select
              value={step.method}
              onChange={(e) => onChange({ method: e.target.value })}
              className="max-w-[110px]"
              aria-label="Method"
            >
              <Repeat each={['GET', 'POST', 'PUT', 'PATCH', 'DELETE']}>
                {(m: string) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                )}
              </Repeat>
            </Select>
            <Input
              mono
              placeholder="https://api.example.com/things"
              value={step.url}
              onChange={(e) => onChange({ url: e.target.value })}
            />
          </div>
          <Field label="Headers" hint='JSON. Use {{ secrets.NAME }} for credentials.'>
            <Textarea
              mono
              rows={2}
              placeholder='{"Authorization": "Bearer {{ secrets.API_KEY }}"}'
              value={step.headers}
              onChange={(e) => onChange({ headers: e.target.value })}
            />
          </Field>
          <Field label="Capture a value" hint="Store part of the response for later steps.">
            <div className="flex gap-2">
              <Input
                mono
                placeholder="name"
                className="max-w-[160px]"
                value={step.captureName}
                onChange={(e) => onChange({ captureName: e.target.value })}
              />
              <Input
                mono
                placeholder="steps.fetch.output.body.id"
                value={step.captureFrom}
                onChange={(e) => onChange({ captureFrom: e.target.value })}
              />
            </div>
          </Field>
        </Show>

        <Show when={step.kind === 'branch'}>
          <Field label="If this is true…" hint="e.g. steps.fetch.output.status == 200">
            <Input
              mono
              value={step.branchWhen}
              onChange={(e) => onChange({ branchWhen: e.target.value })}
            />
          </Field>
          <div className="flex gap-2">
            <Field label="…go to step" className="flex-1">
              <Input
                mono
                value={step.branchGoto}
                onChange={(e) => onChange({ branchGoto: e.target.value })}
              />
            </Field>
            <Field label="Otherwise" hint="Blank ends the run." className="flex-1">
              <Input
                mono
                value={step.otherwise}
                onChange={(e) => onChange({ otherwise: e.target.value })}
              />
            </Field>
          </div>
        </Show>

        <Show when={step.kind === 'transform'}>
          <Field label="Set values" hint="One per line: name = expression">
            <Textarea
              mono
              rows={3}
              placeholder={'total = steps.fetch.output.body.count * 2\nlabel = "n=" + vars.total'}
              value={step.setExpr}
              onChange={(e) => onChange({ setExpr: e.target.value })}
            />
          </Field>
        </Show>

        <Show when={step.kind === 'assert'}>
          <Field label="Must be true" hint="The run fails here if this does not hold.">
            <Input
              mono
              placeholder="steps.fetch.output.body.count > 0"
              value={step.condition}
              onChange={(e) => onChange({ condition: e.target.value })}
            />
          </Field>
        </Show>

        <Show when={step.kind === 'delay'}>
          <Field label="Wait (milliseconds)">
            <Input
              mono
              type="number"
              className="max-w-[160px]"
              value={step.ms}
              onChange={(e) => onChange({ ms: e.target.value })}
            />
          </Field>
        </Show>

        <Show when={step.kind === 'shell'}>
          <Field
            label="Command"
            hint="Split on spaces into arguments. There is no shell, so pipes and redirects will not work."
          >
            <Input
              mono
              placeholder="git status --short"
              value={step.command}
              onChange={(e) => onChange({ command: e.target.value })}
            />
          </Field>
        </Show>
      </div>
    </Sheet>
  );
}
