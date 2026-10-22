/** The two sign-in methods we offer, as stored in `users.auth_provider` / `users.last_auth_provider`. */
export type AuthProvider = 'google.com' | 'emailLink';

/**
 * Maps Firebase's raw `sign_in_provider` to the label we store. `undefined` means "not a method we offer": the caller
 * refuses the sign-in and creates nothing.
 *
 * UNCONFIRMED: Firebase email-link sign-in is believed to report `password`. Only a real token from our Firebase project
 * settles it; if it reports something else, this is the one place to change. (Password sign-in is not offered in the
 * Firebase console, so `password` can only be an email link.)
 */
export function mapSignInProvider(raw: string): AuthProvider | undefined {
  if (raw === 'google.com') return 'google.com';
  if (raw === 'password') return 'emailLink';
  return undefined;
}
