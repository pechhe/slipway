const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** The remote `land` pushes the integration branch to: the top-level `remote`,
 * or the older `sourcePublication.remote` form other repositories still declare. */
export function declaredPublicationRemote(policy) {
  const value = policy?.remote ?? policy?.sourcePublication?.remote;
  if (value === undefined) return null;
  if (typeof value !== "string" || !REMOTE.test(value)) {
    throw new Error("Invalid publication remote in .peach/execution.json: expected one named remote");
  }
  return value;
}
