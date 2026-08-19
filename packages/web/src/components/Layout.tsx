import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import {
  Boxes,
  CircleHelp,
  ClipboardList,
  FlaskConical,
  History,
  Home,
  Layers,
  Lightbulb,
  LogOut,
  MapPin,
  Menu,
  MonitorCheck,
  Package,
  KeyRound,
  KeySquare,
  Radio,
  Recycle,
  Settings2,
  Tags,
  Trash2,
  TrendingUp,
  Truck,
  Users,
  X,
} from 'lucide-react';
import { LOCALES, roleAtLeast } from '@inventory/shared';
import type { UserRole } from '@inventory/shared';
import { authClient, asSessionUser } from '../api/auth';
import { useBranding } from '../api/branding';
import { useI18n } from '../i18n';
import { cn } from '../lib/cn';
import { useDeviceClaim } from '../lib/device';
import { FastKeyModal } from './FastKeyModal';
import { IdleTimer } from './IdleTimer';
import { ChangeOwnPasswordModal } from './PasswordModal';
import { RememberDeviceModal } from './RememberDeviceModal';
import { ThemeMenu } from './ThemeMenu';
import { HelpMenu, TourProvider } from './Tour';
import { Button, RoleBadge } from './ui';

interface NavItem {
  to: string;
  labelKey: string;
  icon: typeof Home;
  minRole?: UserRole; // nav is role-gated, but data pages stay visible to viewers
  divider?: boolean; // start a new group above this item
}

/** A blank `to` renders a section divider instead of a link. */
const NAV_ITEMS: NavItem[] = [
  { to: '/', labelKey: 'nav.home', icon: Home },
  { to: '/items', labelKey: 'nav.items', icon: Package },
  { to: '/concepts', labelKey: 'nav.concepts', icon: Lightbulb },
  { to: '/analogous', labelKey: 'nav.analogous', icon: Layers },
  { to: '/variants', labelKey: 'nav.variants', icon: Tags },
  { to: '/locations', labelKey: 'nav.locations', icon: MapPin },
  // — the operational half: what we need, what we ordered, what we use.
  { to: '/requests', labelKey: 'nav.requests', icon: ClipboardList, divider: true },
  { to: '/lots', labelKey: 'nav.lots', icon: Truck, minRole: 'manager' },
  { to: '/forecast', labelKey: 'nav.forecast', icon: TrendingUp },
  { to: '/actions', labelKey: 'nav.actions', icon: FlaskConical },
  { to: '/pools', labelKey: 'nav.pools', icon: Recycle },
  { to: '/log', labelKey: 'nav.log', icon: Radio, minRole: 'admin' },
  { to: '/types', labelKey: 'nav.types', icon: Settings2, minRole: 'admin', divider: true },
  { to: '/users', labelKey: 'nav.users', icon: Users, minRole: 'admin' },
  { to: '/history', labelKey: 'nav.history', icon: History },
  // Managers can delete, so managers can undelete — and purge.
  { to: '/trash', labelKey: 'nav.trash', icon: Trash2, minRole: 'manager' },
];

/**
 * The three-letter locale switcher. Exported because the signed-out Home has a
 * header of its own and must offer the same choice — somebody reading the
 * noticeboard in German should not have to sign in to read it in German.
 */
export function LanguagePicker() {
  const { locale, setLocale } = useI18n();
  return (
    <div className="flex items-center gap-1">
      {LOCALES.map((code) => (
        <button
          key={code}
          onClick={() => setLocale(code)}
          className={cn(
            'rounded px-2 py-1 font-mono text-xs uppercase transition-colors cursor-pointer',
            locale === code
              ? 'bg-primary-tint font-semibold text-primary'
              : 'text-muted hover:text-text',
          )}
        >
          {code}
        </button>
      ))}
    </div>
  );
}

/** The workshop's logo and name, or the built-in mark when nobody has set one. */
export function BrandMark({ compact }: { compact?: boolean }) {
  const { t } = useI18n();
  const branding = useBranding();
  const logo = branding.data?.logo ?? null;
  return (
    <>
      {logo ? (
        // Constrained rather than sized: a logo is whatever shape it is, and
        // the sidebar is 15rem wide whatever anybody uploads.
        <img src={logo} alt="" className={cn('w-auto object-contain', compact ? 'h-6 max-w-28' : 'h-7 max-w-36')} />
      ) : (
        <Boxes className={cn('text-primary', compact ? 'h-5 w-5' : 'h-6 w-6')} />
      )}
      <span className={cn('truncate font-semibold text-text', compact ? '' : 'text-lg')}>
        {branding.data?.name ?? t('app.name')}
      </span>
    </>
  );
}

export function Layout() {
  const { t } = useI18n();
  const { data: session } = authClient.useSession();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [fastKeyOpen, setFastKeyOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [deviceOpen, setDeviceOpen] = useState(false);
  const claim = useDeviceClaim();

  const user = session ? asSessionUser(session.user) : null;
  const claimedBy = claim !== null && claim.userId === user?.id;

  const signOut = async () => {
    // The claim survives a sign-out on purpose. Signing out at your own desk
    // is closing the door, not moving out: the claim grants nothing by itself
    // — it only tells the next sign-in "if this is Anna again, give her the
    // lasting session back". Moving out is the Forget button.
    await authClient.signOut();
    navigate('/login');
  };

  const sidebar = (
    <div className="flex h-full w-60 flex-col border-r border-line bg-surface">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <BrandMark />
      </div>

      <nav data-tour="nav" className="flex-1 space-y-0.5 overflow-y-auto px-3">
        {NAV_ITEMS.filter(
          (item) => !item.minRole || (user && roleAtLeast(user.role, item.minRole)),
        ).map((item) => (
          <div key={item.to} className={cn(item.divider && 'mt-2 border-t border-line pt-2')}>
            <NavLink
              to={item.to}
              end={item.to === '/'}
              onClick={() => setMobileOpen(false)}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-primary-tint font-medium text-primary'
                    : 'text-muted hover:bg-surface-2 hover:text-text',
                )
              }
            >
              <item.icon className="h-4 w-4" />
              {t(item.labelKey)}
            </NavLink>
          </div>
        ))}
      </nav>

      <div className="space-y-3 border-t border-line px-5 py-4">
        <div className="flex items-center gap-1">
          <LanguagePicker />
          <span className="ml-auto flex items-center">
            {/* Help is two things: the written manual, served by the app itself
                so it works with no network, and the guided tours. */}
            <span className="relative">
              <button
                data-tour="help"
                onClick={() => setHelpOpen((open) => !open)}
                title={t('manual.title')}
                className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text"
              >
                <CircleHelp className="h-4 w-4" />
              </button>
              {helpOpen && (
                <>
                  <span className="fixed inset-0 z-40" onClick={() => setHelpOpen(false)} />
                  <span className="absolute bottom-full left-0 z-50 mb-2 block">
                    <HelpMenu
                      onNavigate={() => {
                        setHelpOpen(false);
                        setMobileOpen(false);
                      }}
                    />
                  </span>
                </>
              )}
            </span>
            <ThemeMenu />
          </span>
        </div>
        {user && (
          <div className="flex items-center justify-between gap-1">
            <div className="min-w-0">
              <p className="truncate text-sm text-text">{user.name}</p>
              <RoleBadge role={user.role} label={t(`roles.${user.role}`)} />
            </div>
            <Button
              variant="ghost"
              size="icon"
              data-tour="remember-device"
              onClick={() => setDeviceOpen(true)}
              title={t('auth.rememberDevice')}
            >
              {/* Tinted when this computer is yours: the one place you can
                  tell at a glance whether the twenty-minute rule applies. */}
              <MonitorCheck className={cn('h-4 w-4', claimedBy && 'text-primary')} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              data-tour="fast-key"
              onClick={() => setFastKeyOpen(true)}
              title={t('fastKey.title')}
            >
              <KeySquare className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setPasswordOpen(true)}
              title={t('password.change')}
            >
              <KeyRound className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={signOut} title={t('auth.signOut')}>
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <TourProvider setNavOpen={setMobileOpen}>
    <div className="flex h-dvh">
      {/* Desktop sidebar */}
      <aside className="hidden md:block">{sidebar}</aside>

      {/* Mobile: top bar + overlay drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 flex md:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
          <aside className="relative z-50">{sidebar}</aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-line px-4 py-3 md:hidden">
          <Button variant="ghost" size="icon" onClick={() => setMobileOpen((v) => !v)}>
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
          <BrandMark compact />
        </header>
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          <Outlet />
        </main>
      </div>

      <ChangeOwnPasswordModal open={passwordOpen} onClose={() => setPasswordOpen(false)} />
      <FastKeyModal open={fastKeyOpen} onClose={() => setFastKeyOpen(false)} />
      {user && deviceOpen && (
        <RememberDeviceModal open onClose={() => setDeviceOpen(false)} user={user} />
      )}
      {/* Mounted here rather than above the router: the idle rule is about
          people who are signed in and working, and the sign-in screen has
          nothing to time out of. */}
      <IdleTimer userId={user?.id ?? null} />
    </div>
    </TourProvider>
  );
}
