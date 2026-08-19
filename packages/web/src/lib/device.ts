import { useEffect, useState } from 'react';

// "Remember this computer".
//
// The claim is a note in this browser's own storage saying which account has
// adopted this machine. It is not a credential — the session cookie is what
// keeps you signed in — it is the record of *why* that cookie was made a
// lasting one, and who it belongs to. Two things read it:
//
//   · sign-in (password or chord) asks for a cookie that survives shutdown,
//     but only when the person signing in is the one who claimed the machine;
//   · the idle timer stands down, because a claimed computer is somebody's
//     own desk and throwing them out every twenty minutes is the bug, not the
//     feature.
//
// Clearing browser storage un-claims the machine, which is the right failure:
// you get the cautious behaviour, not the permissive one.

const STORAGE_KEY = 'remembered-device';
/** Fired on this window when the claim changes; storage events only reach others. */
const CLAIM_CHANGED = 'device-claim-changed';

export interface DeviceClaim {
  userId: string;
  /**
   * What this person types to sign in. Kept because the sign-in screen has to
   * decide "is this the owner of this desk?" *before* there is a session to
   * ask — matching the typed name is the only handle available at that point.
   */
  username: string;
  name: string;
}

export function readClaim(): DeviceClaim | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DeviceClaim>;
    if (typeof parsed.userId === 'string' && parsed.userId) {
      return {
        userId: parsed.userId,
        username: typeof parsed.username === 'string' ? parsed.username : '',
        name: typeof parsed.name === 'string' ? parsed.name : '',
      };
    }
  } catch {
    // Corrupted storage → treat the machine as unclaimed, which is the safe end.
  }
  return null;
}

export function claimDevice(claim: DeviceClaim): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(claim));
  window.dispatchEvent(new Event(CLAIM_CHANGED));
}

export function releaseDevice(): void {
  localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event(CLAIM_CHANGED));
}

/**
 * Whether this browser is claimed by the given account.
 *
 * Passed to the sign-in call as `rememberMe`. A colleague signing in on
 * somebody else's claimed desk gets an ordinary session that times out — the
 * machine belongs to one person, not to whoever sits at it.
 */
export function claimedBy(userId: string | null | undefined): boolean {
  const claim = readClaim();
  return claim !== null && claim.userId === userId;
}

/**
 * Same question at the sign-in screen, where the only thing known about the
 * person is what they have typed into the name box. Case-insensitive, because
 * `Anna` and `anna` are one account (see the username plugin in api/auth.ts).
 */
export function claimedFor(identifier: string): boolean {
  const claim = readClaim();
  return (
    claim !== null &&
    claim.username !== '' &&
    claim.username.toLowerCase() === identifier.trim().toLowerCase()
  );
}

/** Re-renders on claim changes, including from another tab. */
export function useDeviceClaim(): DeviceClaim | null {
  const [claim, setClaim] = useState<DeviceClaim | null>(readClaim);
  useEffect(() => {
    const sync = () => setClaim(readClaim());
    window.addEventListener(CLAIM_CHANGED, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(CLAIM_CHANGED, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return claim;
}
