import { useState } from 'react';
import { useNavigate } from 'react-router';
import { MonitorCheck, MonitorX, ShieldAlert } from 'lucide-react';
import { authClient } from '../api/auth';
import { useI18n } from '../i18n';
import { claimDevice, releaseDevice, useDeviceClaim } from '../lib/device';
import { useToast } from './toast';
import { Button, FieldError, Input, Label, Modal } from './ui';

// Claiming a computer: "this desk is mine, stop signing me out".
//
// It costs a password, and it has to. The session cookie this creates outlives
// shutdowns, hibernation and closing the browser; a bench machine left
// unlocked for two minutes must not be enough for somebody to make it
// permanently theirs.
//
// The password is not checked and then discarded — it signs in again, with
// `rememberMe`. That is the only way to get a lasting cookie out of
// better-auth, and it means the check and the upgrade cannot come apart:
// there is no path where the password was wrong and the machine got claimed.

export function RememberDeviceModal({
  open,
  onClose,
  user,
}: {
  open: boolean;
  onClose: () => void;
  user: { id: string; name: string; username?: string | null; email?: string | null };
}) {
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const claim = useDeviceClaim();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mine = claim !== null && claim.userId === user.id;

  const remember = async () => {
    setError(null);
    setBusy(true);
    try {
      const identifier = user.username ?? user.email ?? '';
      const result = identifier.includes('@')
        ? await authClient.signIn.email({ email: identifier, password, rememberMe: true })
        : await authClient.signIn.username({ username: identifier, password, rememberMe: true });

      if (result.error) {
        setError(t('auth.wrongPassword'));
        return;
      }
      claimDevice({ userId: user.id, username: identifier, name: user.name });
      setPassword('');
      toast({ message: t('auth.claimed', { name: user.name }), variant: 'success' });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Forgetting signs you out on the spot.
   *
   * The cookie in this browser is already a lasting one and there is no way to
   * shorten it in place — only a fresh sign-in can hand out a different kind.
   * Ending the session is therefore the only honest way to make "forget this
   * computer" true immediately, rather than at some point in the future the
   * person would have no way to predict.
   */
  const forget = async () => {
    releaseDevice();
    await authClient.signOut();
    toast({ message: t('auth.forgotten') });
    onClose();
    navigate('/login', { replace: true });
  };

  return (
    <Modal open={open} onClose={onClose} title={t('auth.rememberDevice')}>
      <div className="space-y-4">
        {mine ? (
          <>
            <p className="flex items-start gap-2.5 rounded-md bg-primary-tint px-3 py-2.5 text-sm text-primary">
              <MonitorCheck className="mt-0.5 h-4 w-4 shrink-0" />
              {t('auth.claimed', { name: claim.name || user.name })}
            </p>
            <p className="text-xs text-muted">{t('auth.rememberDeviceHint')}</p>
            <div className="flex justify-end gap-2 border-t border-line pt-4">
              <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
              <Button variant="danger" onClick={() => void forget()}>
                <MonitorX className="h-4 w-4" /> {t('auth.forget')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-text">{t('auth.rememberDeviceHint')}</p>
            {claim !== null && (
              // Somebody else's desk. Claiming it takes it from them, and they
              // should not find that out by silently losing their session.
              <p className="flex items-start gap-2.5 rounded-md bg-warning-tint px-3 py-2.5 text-xs text-warning">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                {t('auth.claimed', { name: claim.name })}
              </p>
            )}
            <div>
              <Label htmlFor="claim-password">{t('auth.confirmPassword')}</Label>
              <Input
                id="claim-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && password) void remember();
                }}
              />
              <p className="mt-1 text-xs text-muted">{t('auth.confirmPasswordWhy')}</p>
              <FieldError message={error ?? undefined} />
            </div>
            <div className="flex justify-end gap-2 border-t border-line pt-4">
              <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
              <Button disabled={busy || password.length === 0} onClick={() => void remember()}>
                <MonitorCheck className="h-4 w-4" /> {t('auth.rememberDevice')}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
