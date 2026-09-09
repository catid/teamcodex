/** Resolve display status without erasing the underlying failure state.
 * @param {{enabled?: boolean, status: string, _refreshPromise?: Promise<unknown> | null}} account
 * @returns {string}
 */
export function accountStatus(account) {
  if (account.enabled === false) return 'disabled';
  if (account._refreshPromise) return 'refreshing';
  return account.status;
}
