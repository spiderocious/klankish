import { env, mailConfigured } from './env.js';
import { subLogger } from './logger.js';

/**
 * Email, behind a port.
 *
 * A `Mailer` interface rather than calling Resend directly, for three reasons that all showed up
 * in the persona's hard-won rules:
 *
 *   1. CI must never hold real credentials. The stub driver satisfies the same interface.
 *   2. An unconfigured instance must DEGRADE, not crash. Self-hosting Klankish should not require
 *      a Resend account just to run a task that makes an HTTP call.
 *   3. Swapping providers later touches one file.
 *
 * Resend is called over plain `fetch` rather than its SDK: the API is one POST, and this avoids a
 * dependency (and its transitive tree) for something this small.
 */

const log = subLogger('mailer');

export interface SendInput {
  readonly to: readonly string[];
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly cc?: readonly string[];
  readonly replyTo?: string;
}

export interface SendResult {
  readonly id: string;
  readonly provider: 'resend' | 'stub';
}

export interface Mailer {
  readonly configured: boolean;
  send(input: SendInput): Promise<SendResult>;
}

/**
 * The stub.
 *
 * Used in tests and whenever RESEND_API_KEY is absent. It LOGS rather than silently succeeding,
 * so a developer who expected an email and got none can see why in one line.
 */
class StubMailer implements Mailer {
  readonly configured = false;

  async send(input: SendInput): Promise<SendResult> {
    log.info(
      { to: input.to, subject: input.subject },
      'email not sent — no RESEND_API_KEY configured on this instance',
    );
    return { id: `stub_${Date.now()}`, provider: 'stub' };
  }
}

class ResendMailer implements Mailer {
  readonly configured = true;

  constructor(private readonly apiKey: string) {}

  async send(input: SendInput): Promise<SendResult> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [...input.to],
        subject: input.subject,
        ...(input.text !== undefined && { text: input.text }),
        ...(input.html !== undefined && { html: input.html }),
        ...(input.cc !== undefined && input.cc.length > 0 && { cc: [...input.cc] }),
        ...(input.replyTo !== undefined && { reply_to: input.replyTo }),
      }),
      // Not unbounded: an email step must not hold a worker lease hostage because a provider is
      // slow to answer.
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.text();
      // The body is included because Resend's errors are specific and actionable ("domain not
      // verified"), and a generic failure here would send someone hunting.
      throw new Error(`Resend returned ${res.status}: ${body.slice(0, 300)}`);
    }

    const json = (await res.json()) as { id?: string };
    return { id: json.id ?? 'unknown', provider: 'resend' };
  }
}

export const mailer: Mailer = mailConfigured
  ? new ResendMailer(env.RESEND_API_KEY!)
  : new StubMailer();

/** Templates, kept here so copy lives in one reviewable place rather than inside the engine. */
export const emailTemplates = {
  runFailed(input: {
    taskName: string;
    runId: string;
    errorMessage: string;
    appUrl: string;
  }): { subject: string; text: string } {
    return {
      subject: `${input.taskName} failed`,
      text: [
        `${input.taskName} failed.`,
        '',
        input.errorMessage,
        '',
        `See what happened: ${input.appUrl}/runs/${input.runId}`,
      ].join('\n'),
    };
  },

  runRecovered(input: { taskName: string; runId: string; appUrl: string }): {
    subject: string;
    text: string;
  } {
    return {
      subject: `${input.taskName} is working again`,
      text: [
        `${input.taskName} succeeded after failing previously.`,
        '',
        `${input.appUrl}/runs/${input.runId}`,
      ].join('\n'),
    };
  },

  passwordReset(input: { appUrl: string; token: string }): { subject: string; text: string } {
    return {
      subject: 'Reset your Klankish password',
      text: [
        'Use this link to set a new password. It expires in one hour.',
        '',
        `${input.appUrl}/reset-password?token=${input.token}`,
        '',
        'If you did not ask for this, you can ignore it — nothing has changed.',
      ].join('\n'),
    };
  },
};
