import { Navigate, useLocation } from 'react-router';
import type { ReactNode } from 'react';
import { authClient } from '../api/auth';
import { PublicHomePage } from '../pages/PublicHomePage';
import { Spinner } from './ui';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { data: session, isPending } = authClient.useSession();
  const location = useLocation();

  if (isPending) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }
  if (!session) {
    // Home is the one page that works without a session: a read-only stock
    // board anybody can read. It gets its own bare shell rather than
    // the app layout, whose sidebar links all lead somewhere they cannot go.
    //
    // Handled here rather than as a separate route so that signing in does not
    // remount the layout under the person's feet.
    if (location.pathname === '/') return <PublicHomePage />;
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
