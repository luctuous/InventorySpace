import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router';
import { KeyRound, KeySquare, LogOut, Plus } from 'lucide-react';
import { USER_ROLES, userCreateSchema } from '@inventory/shared';
import type { UserCreate, UserRole } from '@inventory/shared';
import { asSessionUser, authClient } from '../api/auth';
import { ApiRequestError } from '../api/client';
import {
  useCreateUser,
  useRevokeAllSessions,
  useRevokeFastKey,
  useSetUserRole,
  useUsers,
} from '../api/entities';
import { ResetPasswordModal } from '../components/PasswordModal';
import { useToast } from '../components/toast';
import { Button, FieldError, Input, Label, Modal, Select, Spinner } from '../components/ui';
import { useI18n } from '../i18n';
import { releaseDevice } from '../lib/device';
import { formatDate } from '../lib/format';

// Admin-only user management. Public registration closes
// after the first user, so accounts are created here.

function CreateUserModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const createUser = useCreateUser();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<UserCreate>({
    resolver: zodResolver(userCreateSchema),
    defaultValues: { name: '', username: '', email: '', password: '', role: 'operator' },
  });

  const submit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      // An empty address field means "no address", not an empty one.
      await createUser.mutateAsync({ ...values, email: values.email || null });
      toast({ message: t('users.created'), variant: 'success' });
      form.reset();
      onClose();
    } catch (error) {
      setServerError(error instanceof ApiRequestError ? error.message : String(error));
    }
  });

  return (
    <Modal open={open} onClose={onClose} title={t('users.new')}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <Label htmlFor="u-name">{t('auth.name')}</Label>
          <Input id="u-name" {...form.register('name')} />
          <FieldError message={form.formState.errors.name?.message} />
        </div>
        <div>
          <Label htmlFor="u-username">{t('auth.username')}</Label>
          <Input id="u-username" autoComplete="off" {...form.register('username')} />
          <FieldError message={form.formState.errors.username?.message} />
          <p className="mt-1 text-xs text-muted">{t('users.usernameHint')}</p>
        </div>
        <div>
          <Label htmlFor="u-email">{t('auth.email')} ({t('common.optional')})</Label>
          <Input id="u-email" type="email" {...form.register('email')} />
          <FieldError message={form.formState.errors.email?.message} />
          <p className="mt-1 text-xs text-muted">{t('users.emailHint')}</p>
        </div>
        <div>
          <Label htmlFor="u-password">{t('users.tempPassword')}</Label>
          <Input id="u-password" type="text" autoComplete="new-password" {...form.register('password')} />
          <FieldError message={form.formState.errors.password?.message} />
        </div>
        <div>
          <Label htmlFor="u-role">{t('users.role')}</Label>
          <Select id="u-role" {...form.register('role')}>
            {USER_ROLES.map((role) => (
              <option key={role} value={role}>{t(`roles.${role}`)}</option>
            ))}
          </Select>
        </div>
        {serverError && <p className="text-sm text-danger">{serverError}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>{t('common.save')}</Button>
        </div>
      </form>
    </Modal>
  );
}

export function UsersPage() {
  const { t, locale } = useI18n();
  const toast = useToast();
  const { data: session } = authClient.useSession();
  const navigate = useNavigate();
  const usersQuery = useUsers(true);
  const setUserRole = useSetUserRole();
  const revokeFastKey = useRevokeFastKey();
  const revokeAll = useRevokeAllSessions();
  const [createOpen, setCreateOpen] = useState(false);
  const [resetting, setResetting] = useState<{ id: string; name: string } | null>(null);

  const me = session ? asSessionUser(session.user) : null;

  const revoke = async (id: string, name: string) => {
    try {
      await revokeFastKey.mutateAsync(id);
      toast({ message: t('fastKey.revoked', { name }), variant: 'success' });
    } catch (error) {
      toast({ message: error instanceof ApiRequestError ? error.message : String(error), variant: 'danger' });
    }
  };

  /**
   * Ending every session includes this one, so the last thing that happens is
   * this browser landing on the sign-in screen. Confirmed first, because there
   * is no undo and everybody in the workshop feels it at once.
   */
  const signOutEveryone = async () => {
    if (!window.confirm(t('auth.revokeAllConfirm'))) return;
    try {
      const result = await revokeAll.mutateAsync();
      releaseDevice();
      toast({ message: t('auth.revokeAllDone', { n: result.sessions }), variant: 'success' });
      navigate('/login', { replace: true });
    } catch (error) {
      toast({ message: error instanceof ApiRequestError ? error.message : String(error), variant: 'danger' });
    }
  };

  const changeRole = async (id: string, role: UserRole) => {
    try {
      await setUserRole.mutateAsync({ id, role });
      toast({ message: t('common.saved'), variant: 'success' });
    } catch (error) {
      toast({ message: error instanceof ApiRequestError ? error.message : String(error), variant: 'danger' });
    }
  };

  if (usersQuery.isPending) {
    return <div className="flex justify-center py-16"><Spinner /></div>;
  }

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-text">{t('users.title')}</h1>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" /> {t('users.new')}
        </Button>
      </div>

      {/* The one lever that reaches a claimed computer. Claimed
          machines never sign themselves out, so somebody has to be able to end
          every session in the building at once — a laptop goes missing, a
          password gets shoulder-surfed, somebody leaves the group. */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/40 bg-danger-tint px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm text-text">{t('auth.revokeAll')}</p>
          <p className="mt-0.5 text-xs text-muted">{t('auth.revokeAllHint')}</p>
        </div>
        <Button
          variant="danger"
          disabled={revokeAll.isPending}
          onClick={() => void signOutEveryone()}
        >
          <LogOut className="h-4 w-4" /> {t('auth.revokeAll')}
        </Button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-surface text-left text-xs uppercase tracking-wide text-muted">
              <th className="px-4 py-2.5 font-medium">{t('auth.name')}</th>
              <th className="px-4 py-2.5 font-medium">{t('auth.username')}</th>
              <th className="px-4 py-2.5 font-medium">{t('auth.email')}</th>
              <th className="px-4 py-2.5 font-medium">{t('fastKey.column')}</th>
              <th className="px-4 py-2.5 font-medium">{t('users.role')}</th>
              <th className="px-4 py-2.5 font-medium">{t('users.since')}</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {usersQuery.data?.map((row) => (
              <tr key={row.id} className="border-b border-line last:border-0 hover:bg-surface">
                <td className="px-4 py-2.5 text-text">{row.name}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-text">{row.username ?? '—'}</td>
                <td className="px-4 py-2.5 text-muted">{row.email ?? '—'}</td>
                <td className="px-4 py-2.5">
                  {row.hasFastKey ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      title={t('fastKey.revokeHint')}
                      onClick={() => void revoke(row.id, row.name)}
                    >
                      <KeySquare className="h-4 w-4" /> {t('fastKey.revoke')}
                    </Button>
                  ) : (
                    <span className="text-xs text-muted">—</span>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <Select
                    className="h-8 w-32"
                    value={row.role}
                    disabled={row.id === me?.id}
                    title={row.id === me?.id ? t('users.ownRole') : undefined}
                    onChange={(e) => void changeRole(row.id, e.target.value as UserRole)}
                  >
                    {USER_ROLES.map((role) => (
                      <option key={role} value={role}>{t(`roles.${role}`)}</option>
                    ))}
                  </Select>
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-muted">
                  {formatDate(row.createdAt, locale)}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    title={t('password.resetHint')}
                    onClick={() => setResetting({ id: row.id, name: row.name })}
                  >
                    <KeyRound className="h-4 w-4" /> {t('password.resetShort')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <CreateUserModal open={createOpen} onClose={() => setCreateOpen(false)} />
      <ResetPasswordModal user={resetting} onClose={() => setResetting(null)} />
    </div>
  );
}
