export interface Email {
  to: string;
  subject: string;
  text: string;
}

export type SendEmail = (email: Email) => Promise<void>;

/** Sends through Resend (https://resend.com/docs/api-reference/emails/send-email). */
export function resendSender(opts: { apiKey: string; from: string; fetch?: typeof fetch }): SendEmail {
  const doFetch = opts.fetch ?? fetch;
  return async ({ to, subject, text }) => {
    const res = await doFetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: opts.from, to: [to], subject, text }),
    });
    if (!res.ok) throw new Error(`Resend responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
  };
}

/** Used when RESEND_API_KEY isn't set (local dev): prints the email instead of sending it. */
export const consoleSender: SendEmail = async ({ to, subject, text }) => {
  console.log(`[email to ${to}] ${subject}\n${text}`);
};

/** Sender address used when EMAIL_FROM isn't set, so deploys that predate the variable keep working. */
export const DEFAULT_EMAIL_FROM = "loopway <matthew@craftmill.dev>";

/** Resend when RESEND_API_KEY is set (from EMAIL_FROM), else the console. */
export function senderFromEnv(env: NodeJS.ProcessEnv = process.env, fetchFn?: typeof fetch): SendEmail {
  if (!env.RESEND_API_KEY) return consoleSender;
  return resendSender({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM || DEFAULT_EMAIL_FROM, fetch: fetchFn });
}
