import { useState } from 'react';
import { ApiRequestError } from '../api/client';
import { useChangeOwnPassword, useResetUserPassword } from '../api/entities';
import { useToast } from './toast';
import { Button, FieldError, Input, Label, Modal } from './ui';
import { useI18n } from '../i18n';

// Two shapes of the same job. Changing your own password proves you know the
// current one; an admin resetting somebody else's does not — that is what a
// reset is for — and it signs that person out everywhere.

export function ChangeOwnPasswordModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const changePassword = useChangeOwnPassword();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mismatch = repeat.length > 0 && next !== repeat;
  const tooShort = next.length > 0 && next.length < 8;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await changePassword.mutateAsync({ currentPassword: current, newPassword: next });
      toast({ message: t('password.changed'), variant: 'success' });
      setCurrent(''); setNext(''); setRepeat('');
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : String(err));
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t('password.change')}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <Label htmlFor="pw-current">{t('password.current')}</Label>
          <Input id="pw-current" type="password" autoComplete="current-password"
            value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="pw-new">{t('password.new')}</Label>
          <Input id="pw-new" type="password" autoComplete="new-password"
            value={next} onChange={(e) => setNext(e.target.value)} />
          <FieldError message={tooShort ? t('password.tooShort') : undefined} />
        </div>
        <div>
          <Label htmlFor="pw-repeat">{t('password.repeat')}</Label>
          <Input id="pw-repeat" type="password" autoComplete="new-password"
            value={repeat} onChange={(e) => setRepeat(e.target.value)} />
          <FieldError message={mismatch ? t('password.mismatch') : undefined} />
        </div>
        <p className="text-xs text-muted">{t('password.signsOutOthers')}</p>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            type="submit"
            disabled={!current || next.length < 8 || mismatch || changePassword.isPending}
          >
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function ResetPasswordModal({
  user,
  onClose,
}: {
  user: { id: string; name: string } | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const resetPassword = useResetUserPassword();
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!user) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await resetPassword.mutateAsync({ id: user.id, newPassword: next });
      toast({ message: t('password.reset'), variant: 'success' });
      setNext('');
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : String(err));
    }
  };

  return (
    <Modal open onClose={onClose} title={`${t('password.resetFor')} ${user.name}`}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <Label htmlFor="pw-reset">{t('users.tempPassword')}</Label>
          <Input id="pw-reset" type="text" autoComplete="off"
            value={next} onChange={(e) => setNext(e.target.value)} />
          <FieldError message={next.length > 0 && next.length < 8 ? t('password.tooShort') : undefined} />
        </div>
        <p className="text-xs text-muted">{t('password.resetNote')}</p>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={next.length < 8 || resetPassword.isPending}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
