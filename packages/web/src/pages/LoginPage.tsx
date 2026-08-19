import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { z } from 'zod';
import { ArrowLeft, Boxes, KeySquare, MonitorCheck } from 'lucide-react';
import { placeholderEmail, usernameProblem } from '@inventory/shared';
import { authClient } from '../api/auth';
import { useBranding } from '../api/branding';
import { useI18n } from '../i18n';
import { claimDevice, claimedBy, claimedFor, releaseDevice } from '../lib/device';
import { Button, FieldError, Input, Label, Spinner } from '../components/ui';

// One page, two modes: normal sign-in, and "first run" registration that
// creates the admin account. The server closes registration after the first
// user, so the register tab simply errors out afterwards.
//
// The identity is a **username**, free-form, not an email — a workshop hands out
// logins at the bench and most of the people who need one have no mailbox
// worth typing. An address can be added later, per account, for the day this
// gets linked to Outlook. Sign-in still accepts one if it is there, which is
// what the `@` test is for.

type Mode = 'signIn' | 'register';

// Same field shape either way, stricter rules when registering — so the form
// keeps one type across both modes.
function schemaFor(mode: Mode) {
  return z.object({
    identifier:
      mode === 'register'
        ? z.string().min(2).refine((value) => usernameProblem(value) === null, {
            message: 'No @, no stray spaces',
          })
        : z.string().min(1),
    password: z.string().min(8),
    name: mode === 'register' ? z.string().min(1) : z.string().optional(),
  });
}
type LoginForm = z.infer<ReturnType<typeof schemaFor>>;

const looksLikeEmail = (value: string) => value.includes('@');

/**
 * A short random tag for the placeholder address.
 *
 * NOT `crypto.randomUUID()`: that one only exists in a **secure context**, and
 * the whole point of this product is a server somebody reaches at
 * `http://192.168.1.20:3000` over the workshop network — which is not one. It works
 * on `localhost`, which is why this survived until the app was opened from a
 * second machine. `getRandomValues` has no such restriction.
 */
function randomSuffix(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function LoginPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const branding = useBranding();
  const [params] = useSearchParams();
  const [mode, setMode] = useState<Mode>('signIn');
  const [serverError, setServerError] = useState<string | null>(null);
  const [remember, setRemember] = useState(false);

  const form = useForm<LoginForm>({
    resolver: zodResolver(schemaFor(mode)),
    defaultValues: { identifier: '', password: '', name: '' },
  });

  // Somebody signing in at their own claimed desk should not have to tick the
  // box every morning. Watching the name field means the tick appears as soon
  // as they have typed it, whether they typed it or the browser filled it in.
  const typedIdentifier = form.watch('identifier');
  useEffect(() => {
    if (mode === 'signIn' && claimedFor(typedIdentifier)) setRemember(true);
  }, [mode, typedIdentifier]);

  const submit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      const result =
        mode === 'signIn'
          ? looksLikeEmail(values.identifier)
            ? await authClient.signIn.email({
                email: values.identifier,
                password: values.password,
                rememberMe: remember,
              })
            : await authClient.signIn.username({
                username: values.identifier,
                password: values.password,
                rememberMe: remember,
              })
          : await authClient.signUp.email({
              // better-auth insists on an address; the first admin gets one
              // that can never receive, and can put a real one in later.
              email: placeholderEmail(values.identifier, randomSuffix()),
              username: values.identifier,
              password: values.password,
              name: values.name ?? '',
            });

      if (result.error) {
        setServerError(result.error.message ?? t('auth.signInError'));
        return;
      }
      // The claim is written from the signed-in user, not from what was typed
      // — the id is what every later decision compares against.
      const signedIn = result.data?.user;
      if (remember && signedIn) {
        claimDevice({
          userId: signedIn.id,
          username: values.identifier,
          name: signedIn.name || values.identifier,
        });
      } else if (signedIn && claimedBy(signedIn.id)) {
        // Only the owner of this desk can give it up, and unticking the box is
        // how they say so. A colleague borrowing the machine for five minutes
        // must NOT un-claim it: their session is an ordinary one that times
        // out, and when the owner comes back the desk is still theirs.
        releaseDevice();
      }
      navigate('/');
    } catch (error) {
      // Anything that throws here used to leave the button springing back with
      // no explanation at all, which is worse than any error message. It is
      // how the crypto.randomUUID bug above stayed invisible.
      setServerError(error instanceof Error ? error.message : String(error));
    }
  });

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-8">
        <div className="mb-8 flex flex-col items-center gap-3">
          {branding.data?.logo ? (
            <img src={branding.data.logo} alt="" className="h-12 w-auto max-w-48 object-contain" />
          ) : (
            <Boxes className="h-10 w-10 text-primary" />
          )}
          <div className="text-center">
            <h1 className="text-xl font-semibold text-text">
              {branding.data?.name ?? t('auth.welcomeTitle')}
            </h1>
            <p className="text-sm text-muted">{t('auth.welcomeSubtitle')}</p>
          </div>
        </div>

        {/* Arriving here because a shared computer timed out deserves a
            sentence saying so; otherwise it looks like the app lost the
            session for no reason. */}
        {params.get('idle') === '1' && (
          <p className="mb-4 rounded-md bg-warning-tint px-3 py-2 text-xs text-warning">
            {t('auth.signedOutIdle')}
          </p>
        )}

        {/* data-chord-ok: a key chord is read even from inside these fields —
            see the note in lib/chord.ts. It only applies while signed out. */}
        <form onSubmit={submit} className="space-y-4" data-chord-ok>
          {mode === 'register' && (
            <div>
              <Label htmlFor="name">{t('auth.name')}</Label>
              <Input id="name" autoComplete="name" {...form.register('name')} />
              <FieldError message={form.formState.errors.name?.message} />
            </div>
          )}
          <div>
            <Label htmlFor="identifier">
              {mode === 'signIn' ? t('auth.identifier') : t('auth.username')}
            </Label>
            <Input id="identifier" type="text" autoComplete="username" {...form.register('identifier')} />
            <FieldError message={form.formState.errors.identifier?.message} />
          </div>
          <div>
            <Label htmlFor="password">{t('auth.password')}</Label>
            <Input
              id="password"
              type="password"
              autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'}
              {...form.register('password')}
            />
            <FieldError message={form.formState.errors.password?.message} />
          </div>

          {/* Off by default: most of these computers are shared, and the safe
              behaviour has to be the one you get by not reading carefully.
              Registration is the first-run admin, who has no desk yet. */}
          {mode === 'signIn' && (
          <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-line px-3 py-2.5">
            <input
              type="checkbox"
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-(--color-primary-base)"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-sm text-text">
                <MonitorCheck className="h-3.5 w-3.5 shrink-0 text-muted" />
                {t('auth.rememberDevice')}
              </span>
              <span className="mt-0.5 block text-xs text-muted">
                {t('auth.rememberDeviceHint')}
              </span>
            </span>
          </label>
          )}

          {serverError && <p className="text-sm text-danger">{serverError}</p>}

          <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? (
              <Spinner className="h-4 w-4 border-primary-foreground/40 border-t-primary-foreground" />
            ) : mode === 'signIn' ? (
              t('auth.signIn')
            ) : (
              t('auth.createAdmin')
            )}
          </Button>
        </form>

        {mode === 'signIn' && (
          // The chord listener is app-wide, so this is a sign, not a control —
          // but nobody presses a shortcut they were never told about.
          <p className="mt-5 flex items-start gap-2 border-t border-line pt-4 text-xs text-muted">
            <KeySquare className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t('fastKey.loginHint')}
          </p>
        )}

        <button
          className="mt-4 w-full text-center text-xs text-muted hover:text-text cursor-pointer"
          onClick={() => {
            setMode(mode === 'signIn' ? 'register' : 'signIn');
            setServerError(null);
          }}
        >
          {mode === 'signIn' ? t('auth.firstRun') : t('auth.backToSignIn')}
        </button>

        {/* The way back to the noticeboard, for somebody who only wanted to
            know whether there is any wood glue left. */}
        <Link
          to="/"
          className="mt-3 flex items-center justify-center gap-1.5 text-xs text-muted hover:text-text"
        >
          <ArrowLeft className="h-3 w-3" />
          {t('auth.browse')}
        </Link>
      </div>
    </div>
  );
}
